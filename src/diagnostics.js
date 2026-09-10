// @ts-check
/**
 * @fileoverview Diagnostics engine for OtterScript documents.
 *
 * This module performs a full analysis pass and writes diagnostics to a
 * provided VS Code DiagnosticCollection.
 */

const vscode = require("vscode");
const {
  checkMissingDollar,
  createCodeScanState,
  createTemplateScanState,
  createUnbalancedDiagnostic,
  findDuplicateMapKeyDiagnosticsFromMasked,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
  documentUsesTemplateTags,
} = require("./helpers");

/**
 * Context object passed to updateDiagnostics to avoid hidden closures.
 *
 * @typedef {Object} DiagnosticsContext
 * @property {Set<string>} nonVariableIdentifiers - Identifiers valid without '$'
 * @property {Set<string>} knownKeywords - Known language keywords
 * @property {Set<string>} knownScalarFunctions - Known scalar function names
 * @property {Set<string>} knownVectorFunctions - Known vector function names
 * @property {Set<string>} knownOperations - Known operation names
 * @property {ReadonlySet<string>} knownNamespaces - Valid OtterScript namespace tokens
 * @property {() => RegExp} scalarCallRegex - Regex factory for scalar function calls
 * @property {() => RegExp} vectorCallRegex - Regex factory for vector function calls
 * @property {() => RegExp} operationCallRegex - Regex factory for operation-like tokens
 */

/**
 * Matches a `Namespace::` qualifier: a bare identifier followed by `::` and then
 * a letter (the operation name). Group 1 is the char before the token so we can
 * reject mid-token matches; group 2 is the namespace token itself.
 * @type {RegExp}
 */
const NAMESPACE_QUALIFIER_REGEX = /(^|[^A-Za-z0-9_$@:])([A-Za-z][A-Za-z0-9]*)::(?=[A-Za-z])/g;

// -- Text-template (`<% ... %>`) structural checks --------------------------
/** One complete single-line template tag; group 1 is the body. @type {RegExp} */
const TEMPLATE_TAG_REGEX = /<%(.*?)%>/g;
/** Tag body that is only a block-terminator keyword (`end`, `endforeach`, ...). @type {RegExp} */
const TEMPLATE_END_KEYWORD_REGEX = /^\s*(end(?:if|for|foreach|while)?)\s*$/i;
/**
 * Tag body that opens a `{ }` block: `if` / `foreach` / `while`, optionally
 * after `}` / `else`, or context-binding `for server|role|directory|deployable`.
 * Bare `for i = ... ` / `for $x in ...` is left to the `incorrect-for-usage`
 * check, which owns that misuse.
 * @type {RegExp}
 */
const TEMPLATE_BLOCK_OPENER_REGEX =
  /^\s*(?:\}\s*)?(?:else\s+)?(?:(?:if|foreach|while)\b|for\s+(?:server|role|directory|deployable)\b)/i;

/**
 * Emits the `<% %>` structural diagnostics (Phase 1) and the template/expression
 * mode-mixing check (Phase 2, check 4) for one line of a template-aware
 * document. Consumes the string/comment-masked line (delimiters still visible);
 * pushes onto `issues` and advances the cross-line `tagBalance` / `exprState`.
 *
 * @param {string} tagView - `maskNonCodeSpans` output for the raw line
 * @param {number} lineIndex
 * @param {vscode.Diagnostic[]} issues
 * @param {{ count: number, lastLine: number, lastCol: number }} tagBalance
 * @param {{ depth: number }} exprState - Unclosed OtterScript-expression depth
 *   in the literal text (`$(`, `%(`, `@(`, `$Name(`), carried across lines.
 * @returns {void}
 */
function checkTemplateTags(tagView, lineIndex, issues, tagBalance, exprState) {
  // Check 1: `<%` / `%>` balance (mirrors the brace/paren/bracket balance loop).
  // Check 4: a `<%` reached while an OtterScript expression opened in the literal
  //   text is still unclosed -- text templating and expressions cannot nest.
  for (let col = 0; col < tagView.length; col++) {
    const ch = tagView[col];
    const next = tagView[col + 1];

    if (ch === "<" && next === "%") {
      if (tagBalance.count === 0 && exprState.depth > 0) {
        const d = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(lineIndex, col),
            new vscode.Position(lineIndex, col + 2)
          ),
          "Template tag inside an unclosed expression - '<% %>' and OtterScript expressions cannot be mixed",
          vscode.DiagnosticSeverity.Warning
        );
        d.code = "template-in-expression";
        d.source = "OtterScript";
        issues.push(d);
        exprState.depth = 0; // one report per stuck region
      }
      if (tagBalance.count === 0) {
        tagBalance.lastLine = lineIndex;
        tagBalance.lastCol = col;
      }
      tagBalance.count++;
      col++;
      continue;
    }

    if (ch === "%" && next === ">") {
      if (tagBalance.count === 0) {
        const d = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(lineIndex, col),
            new vscode.Position(lineIndex, col + 2)
          ),
          "Unexpected '%>' - no matching '<%'",
          vscode.DiagnosticSeverity.Error
        );
        d.source = "OtterScript";
        issues.push(d);
      } else {
        tagBalance.count--;
      }
      col++;
      continue;
    }

    // -- Expression-depth tracking, only in literal text (not inside a tag).
    if (tagBalance.count === 0) {
      if ((ch === "$" || ch === "%" || ch === "@") && next === "(") {
        exprState.depth++;
        col++;
      } else if (ch === "$" && next && /[A-Za-z]/.test(next)) {
        let j = col + 1;
        while (j < tagView.length && /[A-Za-z0-9_]/.test(tagView[j])) j++;
        if (tagView[j] === "(") {
          exprState.depth++;
          col = j;
        }
      } else if (ch === ")" && exprState.depth > 0) {
        exprState.depth--;
      }
    }
  }

  // Checks 2 & 3: inspect each complete single-line `<% ... %>` tag body.
  for (const m of tagView.matchAll(TEMPLATE_TAG_REGEX)) {
    const body = m[1];
    const bodyStart = /** @type {number} */ (m.index) + 2;

    const endKw = body.match(TEMPLATE_END_KEYWORD_REGEX);
    if (endKw) {
      const kw = endKw[1];
      const kwStart = bodyStart + body.indexOf(kw);
      const d = new vscode.Diagnostic(
        new vscode.Range(
          new vscode.Position(lineIndex, kwStart),
          new vscode.Position(lineIndex, kwStart + kw.length)
        ),
        `'<% ${kw} %>' is not OtterScript - close a template block with '<% } %>'`,
        vscode.DiagnosticSeverity.Warning
      );
      d.code = "template-end-keyword";
      d.source = "OtterScript";
      issues.push(d);
      continue; // a terminator tag is never also a block opener
    }

    if (!body.includes("{") && TEMPLATE_BLOCK_OPENER_REGEX.test(body)) {
      const kwMatch = /** @type {RegExpMatchArray} */ (body.match(/\b(?:if|foreach|for|while)\b/i));
      const kwStart = bodyStart + /** @type {number} */ (kwMatch.index);
      const d = new vscode.Diagnostic(
        new vscode.Range(
          new vscode.Position(lineIndex, kwStart),
          new vscode.Position(lineIndex, kwStart + kwMatch[0].length)
        ),
        `'<% ${kwMatch[0]} ... %>' must open a block - add '{' before '%>'`,
        vscode.DiagnosticSeverity.Warning
      );
      d.code = "template-missing-brace";
      d.source = "OtterScript";
      issues.push(d);
    }
  }
}

/** An operand token: `$name`, `@name`, or a number. @type {RegExp} */
const OPERAND_TOKEN = /\$[A-Za-z]\w*|@[A-Za-z]\w*|\d[\d.]*/y;

/**
 * Phase 2, check 5: two operand tokens with only whitespace between them inside
 * a `%( ... )` / `@( ... )` literal -- e.g. `%( v: $a $b )` -- which OtterScript
 * evaluates to a "Stack Empty" error. Scoped to map/vector literals only (the
 * innermost open bracket must be `%(` or `@(`); a missing `+` there is the
 * classic mistake. Function-call argument lists are left for a later pass.
 *
 * @param {vscode.TextDocument} document - For offset -> Position conversion only
 * @param {string} maskedText - Whole document, `maskNonCodeSpans`-masked
 * @returns {vscode.Diagnostic[]}
 */
function findAdjacentOperandDiagnostics(document, maskedText) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];
  /** @type {("map" | "plain")[]} */
  const stack = [];
  let mapDepth = 0;

  for (let i = 0; i < maskedText.length; i++) {
    const ch = maskedText[i];

    if ((ch === "%" || ch === "@") && maskedText[i + 1] === "(") {
      stack.push("map");
      mapDepth++;
      i++;
      continue;
    }
    if (ch === "(") {
      stack.push("plain");
      continue;
    }
    if (ch === ")") {
      if (stack.pop() === "map") mapDepth--;
      continue;
    }

    // Only look for juxtaposition when the innermost bracket is a map/vector.
    if (mapDepth === 0 || stack[stack.length - 1] !== "map") continue;
    if (ch !== "$" && ch !== "@" && !(ch >= "0" && ch <= "9")) continue;

    OPERAND_TOKEN.lastIndex = i;
    const first = OPERAND_TOKEN.exec(maskedText);
    if (!first || first.index !== i) continue;

    let j = i + first[0].length;
    if (maskedText[j] !== " " && maskedText[j] !== "\t") { i = j - 1; continue; }
    while (maskedText[j] === " " || maskedText[j] === "\t") j++;

    OPERAND_TOKEN.lastIndex = j;
    const second = OPERAND_TOKEN.exec(maskedText);
    if (second && second.index === j) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(j), document.positionAt(j + second[0].length)),
        `Missing operator between '${first[0]}' and '${second[0]}' - did you mean '+'? (adjacent values raise "Stack Empty")`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.code = "missing-operator";
      diagnostic.source = "OtterScript";
      issues.push(diagnostic);
    }
    i = j - 1; // re-scan from the second operand (catches `$a $b $c`)
  }

  return issues;
}

/**
 * Updates diagnostics for an OtterScript document.
 * Performs a full scan of the document and reports all issues.
 *
 * @param {vscode.TextDocument} document - Document to analyze
 * @param {vscode.DiagnosticCollection} collection - Target diagnostics collection
 * @param {DiagnosticsContext} ctx - Explicit diagnostics dependencies
 * @returns {void}
 */
function updateDiagnostics(document, collection, ctx) {
  if (document.languageId !== "otterscript") return;

  const text = document.getText();

  const {
    nonVariableIdentifiers,
    knownKeywords,
    knownScalarFunctions,
    knownVectorFunctions,
    knownOperations,
    knownNamespaces,
    scalarCallRegex,
    vectorCallRegex,
    operationCallRegex,
  } = ctx;

  // Lower-cased view of the namespace allowlist for lenient matching (Inedo
  // resolves namespaces case-insensitively; only genuinely unknown tokens flag).
  const knownNamespacesLower = new Set([...knownNamespaces].map((n) => n.toLowerCase()));

  // -- Symbol-balance state (text is pre-masked by shared scanner helpers)
  const symbols = [
    { count: 0, lastPos: -1, open: "{", close: "}", name: "brace" },
    { count: 0, lastPos: -1, open: "(", close: ")", name: "parenthesis" },
    { count: 0, lastPos: -1, open: "[", close: "]", name: "bracket" },
  ];
  const scanState = createCodeScanState();
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  // -- Text-template mode: when the document uses `<% ... %>` tags, the literal
  //    output text (JSON, Markdown, ...) between tags is NOT OtterScript. Blank
  //    it before the code checks run, and separately run the `<% %>` structural
  //    checks on a view where the delimiters are still visible.
  const templateAware = documentUsesTemplateTags(text);
  const tplState = createTemplateScanState();
  const tagScanState = createCodeScanState();
  const tagBalance = { count: 0, lastLine: -1, lastCol: -1 };
  const tplExprState = { depth: 0 };

  // -- Split into lines for line-by-line processing
  const lines = text.split("\n");

  // -- Process all lines
  const maskedLines = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];

    if (templateAware) {
      checkTemplateTags(maskNonCodeSpans(raw, tagScanState), lineIndex, issues, tagBalance, tplExprState);
    }

    const line = templateAware
      ? maskNonCodeSpans(maskOutsideTemplateTags(raw, tplState), scanState)
      : maskNonCodeSpans(raw, scanState);
    maskedLines.push(line);

    // ------------------------------------------------------------
    // Missing '$' in if conditions
    // ------------------------------------------------------------
    const missingDollarDiagnostic = checkMissingDollar(line, lineIndex, nonVariableIdentifiers);
    if (missingDollarDiagnostic) {
      issues.push(missingDollarDiagnostic);
    }

    // ------------------------------------------------------------
    // Character-by-character symbol balance checks
    // ------------------------------------------------------------
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];

      for (const sym of symbols) {
        if (ch === sym.open) {
          sym.count++;
          if (sym.count === 1) {
            sym.lastPos = document.offsetAt(new vscode.Position(lineIndex, col));
          }
          break;
        }

        if (ch === sym.close) {
          if (sym.count === 0) {
            // Unexpected closing - report immediately
            const pos = document.offsetAt(new vscode.Position(lineIndex, col));
            const diag = createUnbalancedDiagnostic(-1, pos, sym.open, sym.close, sym.name, document);
            if (diag) issues.push(diag);
          } else {
            sym.count--;
          }
          break;
        }
      }
    }

    // ============================================================
    // SYMBOL DETECTION
    // ============================================================
    // -- Detect unknown scalar functions
    for (const match of line.matchAll(scalarCallRegex())) {
      const name = match[1];
      if (!knownScalarFunctions.has(name)) {
        const start = match.index + 1;
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(lineIndex, start),
            new vscode.Position(lineIndex, start + name.length)
          ),
          `Unknown scalar function '$${name}'`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = "unknown-scalar-function";
        diagnostic.source = "OtterScript";
        issues.push(diagnostic);
      }
    }

    // -- Detect unknown vector functions
    for (const match of line.matchAll(vectorCallRegex())) {
      const name = match[1];
      if (!knownVectorFunctions.has(name)) {
        const start = match.index + 1;
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(lineIndex, start),
            new vscode.Position(lineIndex, start + name.length)
          ),
          `Unknown vector function '@${name}'`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = "unknown-vector-function";
        diagnostic.source = "OtterScript";
        issues.push(diagnostic);
      }
    }

    // -- Detect unknown operations
    for (const match of line.matchAll(operationCallRegex())) {
      const name = match[1];

      // When the token is the operation half of `UnknownNs::Do-Thing`, the
      // unknown-namespace check below already flags the real problem -- don't
      // also report the operation name as unknown.
      const qualifier = line.slice(0, match.index).match(/([A-Za-z][A-Za-z0-9]*)::$/)?.[1];
      if (qualifier && !knownNamespacesLower.has(qualifier.toLowerCase())) continue;

      if (
        name.includes("-") &&
        !name.startsWith("$") &&
        !name.startsWith("@") &&
        !knownKeywords.has(name) &&
        !knownOperations.has(name) &&
        !knownScalarFunctions.has(name) &&
        !knownVectorFunctions.has(name)
      ) {
        const start = match.index;
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(lineIndex, start),
            new vscode.Position(lineIndex, start + name.length)
          ),
          `Unknown operation '${name}'`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = "unknown-operation";
        diagnostic.source = "OtterScript";
        issues.push(diagnostic);
      }
    }

    // ------------------------------------------------------------
    // Unknown "Namespace::" qualifiers
    // ------------------------------------------------------------
    // Flag `Frobnicate::Do-Thing` when `Frobnicate` is not a known OtterScript
    // namespace. A missing prefix is NOT flagged -- namespaces are optional.
    // `call Raft::Module` uses `::` for raft names, not namespaces, so skip it.
    for (const match of line.matchAll(NAMESPACE_QUALIFIER_REGEX)) {
      const token = match[2];
      if (knownNamespacesLower.has(token.toLowerCase())) continue;

      const tokenStart = match.index + match[1].length;
      const beforeToken = line.slice(0, tokenStart);
      if (/\bcall\s+$/i.test(beforeToken)) continue; // raft-qualified module call

      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
          new vscode.Position(lineIndex, tokenStart),
          new vscode.Position(lineIndex, tokenStart + token.length)
        ),
        `Unknown namespace '${token}'`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.code = "unknown-namespace";
      diagnostic.source = "OtterScript";
      issues.push(diagnostic);
    }

    // -- Detect invalid logical operators
    if (/^\s*if\b/.test(line)) {
      // -- Detect assignment-like '=' in conditions (likely intended as '==').
      // `line` is already a length-preserving masked version of the source line.
      for (let j = 0; j < line.length; j++) {
        if (line[j] !== "=") continue;

        const prev = line[j - 1];
        const next = line[j + 1];
        const isSingleEquals = prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">"
          && next !== "=" && next !== ">";

        if (!isSingleEquals) continue;

        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(lineIndex, j),
            new vscode.Position(lineIndex, j + 1)
          ),
          "Possible assignment in condition. Did you mean '=='?",
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.code = "assignment-in-condition";
        diagnostic.source = "OtterScript";
        issues.push(diagnostic);
      }

      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (ch === "&" || ch === "|") {
          const prev = line[j - 1];
          const next = line[j + 1];
          if (prev !== ch && next !== ch) {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(
                new vscode.Position(lineIndex, j),
                new vscode.Position(lineIndex, j + 1)
              ),
              `Invalid logical operator '${ch}'. Use '${ch}${ch}'.`,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = "invalid-operator";
            diagnostic.source = "OtterScript";
            issues.push(diagnostic);
          }
        }
      }
    }

    // -- Detect incorrect 'for' usage as a loop
    // Matches: for i = 1 to 10, for $item in @list, for item in list
    const forLoopLikePattern = /^\s*for\s+(\$?\w+)\s+(=|in)\s+/i;
    if (forLoopLikePattern.test(line)) {
      const startIndex = line.indexOf("for");
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
          new vscode.Position(lineIndex, startIndex),
          new vscode.Position(lineIndex, startIndex + 3)
        ),
        "'for' in OtterScript does not perform iteration. Use 'foreach' for loops, or 'for server/role/directory' for context binding.",
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.code = "incorrect-for-usage";
      diagnostic.source = "OtterScript";
      issues.push(diagnostic);
    }
  }

  // -- Unbalanced opening braces, parentheses, brackets
  for (const sym of symbols) {
    if (sym.count > 0) {
      const diag = createUnbalancedDiagnostic(sym.count, sym.lastPos, sym.open, sym.close, sym.name, document);
      if (diag) issues.push(diag);
    }
  }

  // -- Unclosed `<%` template tag (mirrors the unbalanced-symbol report above)
  if (templateAware && tagBalance.count > 0) {
    const d = new vscode.Diagnostic(
      new vscode.Range(
        new vscode.Position(tagBalance.lastLine, tagBalance.lastCol),
        new vscode.Position(tagBalance.lastLine, tagBalance.lastCol + 2)
      ),
      `Unclosed template tag: '<%' at line ${tagBalance.lastLine + 1}, col ${tagBalance.lastCol + 1} not closed`,
      vscode.DiagnosticSeverity.Error
    );
    d.source = "OtterScript";
    issues.push(d);
  }

  // -- Detect duplicate keys inside map expressions: %( key: value, key: value )
  const joinedMasked = maskedLines.join("\n");
  issues.push(...findDuplicateMapKeyDiagnosticsFromMasked(document, joinedMasked));

  // -- Detect adjacent operands with no operator inside %(...) / @(...)
  issues.push(...findAdjacentOperandDiagnostics(document, joinedMasked));

  collection.set(document.uri, issues);
}

module.exports = {
  updateDiagnostics,
};
