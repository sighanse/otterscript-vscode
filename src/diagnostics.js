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
  findArgumentCountDiagnosticsFromMasked,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
  documentUsesTemplateTags,
  log,
} = require("./helpers");
const { findAdaptiveCardDiagnostics } = require("./adaptivecard");

/**
 * Context object passed to updateDiagnostics to avoid hidden closures.
 *
 * @typedef {Object} DiagnosticsContext
 * @property {Set<string>} nonVariableIdentifiers - Identifiers valid without '$'
 * @property {Set<string>} knownKeywords - Known language keywords
 * @property {Set<string>} knownScalarFunctions - Known scalar function names
 * @property {Set<string>} knownVectorFunctions - Known vector function names
 * @property {Record<string, {signature?: string}>} scalarFunctionDocs - Scalar function docs, keyed by name
 * @property {Record<string, {signature?: string}>} vectorFunctionDocs - Vector function docs, keyed by name
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
 * Builds an OtterScript diagnostic spanning `[start, end)` on one line.
 *
 * @param {number} lineIndex
 * @param {number} start
 * @param {number} end
 * @param {string} message
 * @param {vscode.DiagnosticSeverity} severity
 * @param {string} [code] - Diagnostic code; omitted for checks with no quick-fix/code
 * @returns {vscode.Diagnostic}
 */
function lineDiagnostic(lineIndex, start, end, message, severity, code) {
  const d = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(lineIndex, start), new vscode.Position(lineIndex, end)),
    message,
    severity
  );
  if (code) d.code = code;
  d.source = "OtterScript";
  return d;
}

/**
 * Finds the first segment containing `needle` as a literal substring, and
 * returns its source position. Used to locate a keyword within a tag body
 * that may have been accumulated across several physical lines -- the
 * keyword itself is assumed to live wholly within one of those lines (a
 * realistic assumption; nobody splits `foreach` across a line break).
 *
 * @param {{ lineIndex: number, startCol: number, text: string }[]} segments
 * @param {string} needle
 * @returns {{ lineIndex: number, col: number } | null}
 */
function locateInSegments(segments, needle) {
  for (const seg of segments) {
    const idx = seg.text.indexOf(needle);
    if (idx !== -1) return { lineIndex: seg.lineIndex, col: seg.startCol + idx };
  }
  return null;
}

/**
 * Checks 2 & 3: given one complete `<% ... %>` tag's body -- possibly
 * accumulated across multiple physical lines -- flags a bare terminator
 * keyword (`<% end %>`) or a block opener missing its `{` (`<% foreach ... %>`
 * with no brace before `%>`).
 *
 * @param {{ lineIndex: number, startCol: number, text: string }[]} segments -
 *   One entry per physical line the tag body spans, in source order.
 * @param {vscode.Diagnostic[]} issues
 * @returns {void}
 */
function checkTagBody(segments, issues) {
  const body = segments.map((s) => s.text).join("\n");

  const endKw = body.match(TEMPLATE_END_KEYWORD_REGEX);
  if (endKw) {
    const kw = endKw[1];
    const loc = /** @type {{ lineIndex: number, col: number }} */ (locateInSegments(segments, kw));
    issues.push(lineDiagnostic(
      loc.lineIndex, loc.col, loc.col + kw.length,
      `'<% ${kw} %>' is not OtterScript - close a template block with '<% } %>'`,
      vscode.DiagnosticSeverity.Warning,
      "template-end-keyword"
    ));
    return; // a terminator tag is never also a block opener
  }

  if (!body.includes("{") && TEMPLATE_BLOCK_OPENER_REGEX.test(body)) {
    const kwMatch = /** @type {RegExpMatchArray} */ (body.match(/\b(?:if|foreach|for|while)\b/i));
    const kwText = kwMatch[0];
    const loc = /** @type {{ lineIndex: number, col: number }} */ (locateInSegments(segments, kwText));
    issues.push(lineDiagnostic(
      loc.lineIndex, loc.col, loc.col + kwText.length,
      `'<% ${kwText} ... %>' must open a block - add '{' before '%>'`,
      vscode.DiagnosticSeverity.Warning,
      "template-missing-brace"
    ));
  }
}

/**
 * Emits the `<% %>` structural diagnostics (Phase 1) and the template/expression
 * mode-mixing check (Phase 2, check 4) for one line of a template-aware
 * document. Consumes the string/comment-masked line (delimiters still visible);
 * pushes onto `issues` and advances the cross-line `tagBalance` / `exprState` /
 * `tagBody`.
 *
 * @param {string} tagView - `maskNonCodeSpans` output for the raw line
 * @param {number} lineIndex
 * @param {vscode.Diagnostic[]} issues
 * @param {{ count: number, lastLine: number, lastCol: number }} tagBalance
 * @param {{ depth: number }} exprState - Unclosed OtterScript-expression depth
 *   in the literal text (`$(`, `%(`, `@(`, `$Name(`), carried across lines.
 * @param {{ segments: { lineIndex: number, startCol: number, text: string }[] }} tagBody -
 *   The currently-open tag's body, accumulated one segment per physical line
 *   it spans (checks 2 & 3 run once the closing `%>` is reached, however many
 *   lines away that is).
 * @returns {void}
 */
function checkTemplateTags(tagView, lineIndex, issues, tagBalance, exprState, tagBody) {
  // Where, on THIS line, the currently-open tag's body segment begins. Stays
  // 0 for a line that starts already inside a tag opened on a previous line.
  let segmentStart = 0;

  // Check 1: `<%` / `%>` balance (mirrors the brace/paren/bracket balance loop).
  // Check 4: a `<%` reached while an OtterScript expression opened in the literal
  //   text is still unclosed -- text templating and expressions cannot nest.
  for (let col = 0; col < tagView.length; col++) {
    const ch = tagView[col];
    const next = tagView[col + 1];

    if (ch === "<" && next === "%") {
      if (tagBalance.count === 0 && exprState.depth > 0) {
        issues.push(lineDiagnostic(
          lineIndex, col, col + 2,
          "Template tag inside an unclosed expression - '<% %>' and OtterScript expressions cannot be mixed",
          vscode.DiagnosticSeverity.Warning,
          "template-in-expression"
        ));
        exprState.depth = 0; // one report per stuck region
      }
      if (tagBalance.count === 0) {
        tagBalance.lastLine = lineIndex;
        tagBalance.lastCol = col;
        segmentStart = col + 2;
      }
      tagBalance.count++;
      col++;
      continue;
    }

    if (ch === "%" && next === ">") {
      if (tagBalance.count === 0) {
        issues.push(lineDiagnostic(
          lineIndex, col, col + 2,
          "Unexpected '%>' - no matching '<%'",
          vscode.DiagnosticSeverity.Error
        ));
      } else {
        tagBalance.count--;
        if (tagBalance.count === 0) {
          // The tag closes here -- run checks 2 & 3 over its full body,
          // however many lines it took to get here, then start fresh.
          tagBody.segments.push({ lineIndex, startCol: segmentStart, text: tagView.slice(segmentStart, col) });
          checkTagBody(tagBody.segments, issues);
          tagBody.segments = [];
        }
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

  // The tag is still open at end of line -- record this line's contribution
  // and keep accumulating on the next one.
  if (tagBalance.count > 0) {
    tagBody.segments.push({ lineIndex, startCol: segmentStart, text: tagView.slice(segmentStart) });
  }
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
    scalarFunctionDocs,
    vectorFunctionDocs,
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
  /** @type {{ segments: { lineIndex: number, startCol: number, text: string }[] }} */
  const tagBody = { segments: [] };

  // -- Split into lines for line-by-line processing
  const lines = text.split("\n");

  // -- Process all lines. Each masked line is also kept so the cross-line
  //    checks at the end can run over the whole masked document at once.
  const maskedLines = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex];

    if (templateAware) {
      checkTemplateTags(maskNonCodeSpans(raw, tagScanState), lineIndex, issues, tagBalance, tplExprState, tagBody);
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
    // Character-by-character symbol balance checks. An extra closer is
    // reported immediately; still-open symbols are reported after the loop.
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
        issues.push(lineDiagnostic(
          lineIndex, start, start + name.length,
          `Unknown scalar function '$${name}'`,
          vscode.DiagnosticSeverity.Warning,
          "unknown-scalar-function"
        ));
      }
    }

    // -- Detect unknown vector functions
    for (const match of line.matchAll(vectorCallRegex())) {
      const name = match[1];
      if (!knownVectorFunctions.has(name)) {
        const start = match.index + 1;
        issues.push(lineDiagnostic(
          lineIndex, start, start + name.length,
          `Unknown vector function '@${name}'`,
          vscode.DiagnosticSeverity.Warning,
          "unknown-vector-function"
        ));
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
        issues.push(lineDiagnostic(
          lineIndex, start, start + name.length,
          `Unknown operation '${name}'`,
          vscode.DiagnosticSeverity.Warning,
          "unknown-operation"
        ));
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

      issues.push(lineDiagnostic(
        lineIndex, tokenStart, tokenStart + token.length,
        `Unknown namespace '${token}'`,
        vscode.DiagnosticSeverity.Warning,
        "unknown-namespace"
      ));
    }

    // ------------------------------------------------------------
    // `if` conditions: assignment-like '=' and single '&' / '|'
    // ------------------------------------------------------------
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

        issues.push(lineDiagnostic(
          lineIndex, j, j + 1,
          "Possible assignment in condition. Did you mean '=='?",
          vscode.DiagnosticSeverity.Warning,
          "assignment-in-condition"
        ));
      }

      // -- Detect a lone '&' / '|' (OtterScript's logical operators are '&&' / '||').
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (ch === "&" || ch === "|") {
          const prev = line[j - 1];
          const next = line[j + 1];
          if (prev !== ch && next !== ch) {
            issues.push(lineDiagnostic(
              lineIndex, j, j + 1,
              `Invalid logical operator '${ch}'. Use '${ch}${ch}'.`,
              vscode.DiagnosticSeverity.Warning,
              "invalid-operator"
            ));
          }
        }
      }
    }

    // ------------------------------------------------------------
    // Incorrect 'for' usage as a loop
    // ------------------------------------------------------------
    // Matches: for i = 1 to 10, for $item in @list, for item in list
    const forLoopLikePattern = /^\s*for\s+(\$?\w+)\s+(=|in)\s+/i;
    if (forLoopLikePattern.test(line)) {
      const startIndex = line.indexOf("for");
      issues.push(lineDiagnostic(
        lineIndex, startIndex, startIndex + 3,
        "'for' in OtterScript does not perform iteration. Use 'foreach' for loops, or 'for server/role/directory' for context binding.",
        vscode.DiagnosticSeverity.Warning,
        "incorrect-for-usage"
      ));
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
    issues.push(lineDiagnostic(
      tagBalance.lastLine, tagBalance.lastCol, tagBalance.lastCol + 2,
      `Unclosed template tag: '<%' not closed (first at line ${tagBalance.lastLine + 1}, col ${tagBalance.lastCol + 1})`,
      vscode.DiagnosticSeverity.Error
    ));
  }

  // -- Duplicate map keys, too-many-arguments, and (template-aware documents
  //    only) content-triggered Adaptive Card checks. Isolated in its own try/catch:
  //    these run over the whole joined document rather than per-line like
  //    every check above, so a bug here must not be able to wipe out the
  //    per-line diagnostics already collected above it.
  const joinedMasked = maskedLines.join("\n");
  try {
    issues.push(...findDuplicateMapKeyDiagnosticsFromMasked(document, joinedMasked));
    issues.push(...findArgumentCountDiagnosticsFromMasked(document, joinedMasked, scalarFunctionDocs, vectorFunctionDocs));
    if (templateAware) {
      // Triggered by a literal "type": "AdaptiveCard" in the literal output.
      issues.push(...findAdaptiveCardDiagnostics(document, text));
    }
  } catch (err) {
    log.error(`Cross-line diagnostic scan failed for ${document.uri.toString()}:`, err);
  }

  collection.set(document.uri, issues);
}

module.exports = {
  updateDiagnostics,
};
