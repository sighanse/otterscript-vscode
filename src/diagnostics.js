// @ts-check
/**
 * @fileoverview Diagnostics engine for OtterScript documents.
 *
 * This module performs a full analysis pass and writes diagnostics to a
 * provided VS Code DiagnosticCollection.
 */

const vscode = require("vscode");
const {
  isReadOnlyView,
  log,
  lookupOwn,
  NON_VARIABLE_IDENTIFIERS,
} = require("./helpers");
const {
  NAMESPACES,
  keywordDocs,
  mapFunctionDocs,
  operationDocs,
  scalarFunctionDocs,
  vectorFunctionDocs,
} = require("./language-data");
const {
  createCodeScanState,
  createTemplateScanState,
  documentUsesTemplateTags,
  maskCommentSpans,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
} = require("./scanner");
const { findAdaptiveCardDiagnostics } = require("./adaptivecard");

/**
 * The function table, kind and diagnostic code for each call sigil.
 * @type {Readonly<Record<string, { docs: Readonly<Record<string, import("./language-data").DocEntry>>, kind: string }>>}
 */
const FUNCTION_TABLES = Object.freeze({
  "$": { docs: scalarFunctionDocs, kind: "scalar" },
  "@": { docs: vectorFunctionDocs, kind: "vector" },
  "%": { docs: mapFunctionDocs, kind: "map" },
});

/** A function call: sigil (group 1) and name (group 2). Not `<%`, nor a `%(` map literal. */
const FUNCTION_CALL_REGEX = /(?<!<)([$@%])([A-Za-z][A-Za-z0-9_]*)\s*\(/g;

/** Namespaces, lower-cased: Inedo resolves them case-insensitively. */
const KNOWN_NAMESPACES = new Set([...NAMESPACES].map((n) => n.toLowerCase()));
/**
 * The namespaces whose operations are documented (`core` for the built-ins),
 * lower-cased. A dashed name behind any other known namespace
 * (`Kubernetes::Ensure-Thing`) isn't flagged as an unknown operation: its
 * extension's operations simply aren't documented.
 */
const DOCUMENTED_OPERATION_NAMESPACES = new Set(Object.values(operationDocs).map((doc) => (doc.namespace ?? "Core").toLowerCase()));

// ============================================================
// DIAGNOSTIC CHECKS
// ============================================================

/**
 * Checks for missing '$' before variable names in if conditions.
 *
 * Only the first operand after `if` (and any opening parens) is checked, and
 * only when it is directly followed by a comparison operator -- e.g.
 * `if count == 5` or `if (count > 5)`.
 *
 * @param {string} line - The line, already masked by {@link maskNonCodeSpans}
 *   (so identifiers inside strings/comments are not seen)
 * @param {number} lineIndex - The line number (0-indexed)
 * @param {Set<string>} nonVariableIdentifiers - Set of literals (true, false, null)
 * @returns {vscode.Diagnostic | null} - Diagnostic if missing '$' found, null otherwise
 */
function checkMissingDollar(line, lineIndex, nonVariableIdentifiers) {
  const match = line.match(/^\s*if\s*(?:\(\s*)*([a-zA-Z][a-zA-Z0-9_]*)\s*(=|==|!=|<=|>=|<|>)/);

  // -- Guard: ensure regex matched and we have a valid index position
  if (!match || typeof match.index !== 'number') return null;

  const varName = match[1];

  // -- Skip known literals that don't need '$' (true, false, null)
  if (nonVariableIdentifiers.has(varName)) {
    return null;
  }

  // -- Calculate exact position of variable name within the line
  const varNameIndex = match.index + match[0].indexOf(varName);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(lineIndex, varNameIndex),
      new vscode.Position(lineIndex, varNameIndex + varName.length)
    ),
    `Missing '$' before variable: ${varName}. Use $${varName}`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.code = "missing-dollar";
  diagnostic.source = "OtterScript";

  return diagnostic;
}

/**
 * Finds the matching ')' for the '(' at `openParenIndex` in text already
 * masked by {@link maskNonCodeSpans} (so no string-awareness is needed).
 * Unlike scanner's `findBalancedParenEnd`, this may cross line breaks.
 *
 * @param {string} maskedText
 * @param {number} openParenIndex - Index of the opening '('
 * @returns {number} Matching ')' index, or -1 when not found
 * @private
 */
function findMatchingParen(maskedText, openParenIndex) {
  let depth = 1;
  for (let i = openParenIndex + 1; i < maskedText.length; i++) {
    if (maskedText[i] === "(") depth++;
    if (maskedText[i] === ")") depth--;
    if (depth === 0) return i;
  }
  return -1;
}

/**
 * Finds duplicate keys inside map expressions and returns diagnostics, given
 * text that has ALREADY been masked by {@link maskNonCodeSpans}.
 *
 * This performs a best-effort scan of `%(... )` blocks and warns when the
 * same key appears more than once at the top level of a map. `updateDiagnostics`
 * masks every line during its own scan and passes that masked copy straight in,
 * so strings, comments, and swim-strings are ignored identically to every other
 * feature. A raw-text caller must run `maskNonCodeSpans` line by line first
 * (see `createCodeScanState`).
 *
 * @param {vscode.TextDocument} document - Document to analyze; used only for
 *   `positionAt()` offset-to-position conversion, not for its text.
 * @param {string} maskedText - Document text already run through
 *   `maskNonCodeSpans`, with strings, comments, and swim-strings blanked out
 *   and line length/offsets preserved (so `document.positionAt()` stays valid).
 * @returns {vscode.Diagnostic[]} Duplicate-key diagnostics
 */
function findDuplicateMapKeyDiagnosticsFromMasked(document, maskedText) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  /**
   * Parses a map expression body and reports duplicate top-level keys.
   *
   * @param {number} start - Start index of map body (after '%(')
   * @param {number} end - End index of map body (at matching ')')
   * @returns {void}
   */
  function scanMapBody(start, end) {
    let nestingDepth = 0;
    let segmentStart = start;
    const seenKeys = new Set();

    for (let i = start; i <= end; i++) {
      const ch = i === end ? ',' : maskedText[i];

      if (ch === '(' || ch === '[' || ch === '{') {
        nestingDepth++;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (nestingDepth > 0) nestingDepth--;
        continue;
      }

      if (ch === ',' && nestingDepth === 0) {
        const segmentText = maskedText.slice(segmentStart, i);
        const keyMatch = segmentText.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/);

        if (keyMatch) {
          const key = keyMatch[1];
          const keyStart = segmentStart + keyMatch[0].indexOf(key);

          if (seenKeys.has(key)) {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(
                document.positionAt(keyStart),
                document.positionAt(keyStart + key.length)
              ),
              `Duplicate key '${key}' in map expression.`,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = "duplicate-map-key";
            diagnostic.source = "OtterScript";
            issues.push(diagnostic);
          } else {
            seenKeys.add(key);
          }
        }

        segmentStart = i + 1;
      }
    }
  }

  // Every `%(` gets its own scan -- including maps nested inside another map,
  // whose keys scanMapBody deliberately ignores when scanning the outer one.
  for (let i = 0; i < maskedText.length - 1; i++) {
    if (maskedText[i] === '%' && maskedText[i + 1] === '(') {
      const close = findMatchingParen(maskedText, i + 1);
      if (close !== -1) {
        scanMapBody(i + 2, close);
      }
    }
  }

  return issues;
}

/**
 * How many arguments a `$Name(...)` / `@Name(...)` / `%Name(...)` doc
 * signature takes: `min` counts the parameters not written `[optional]`,
 * `max` all of them (Infinity after a `...` tail). Null when the signature
 * isn't a parenthesized call (a bare property like `$ExecutionId`).
 *
 * @param {string} signature - e.g. `"$Substring(Text, Offset, [Length])"`
 * @returns {{ min: number, max: number } | null}
 */
function parseArity(signature) {
  const m = signature.match(/^[$@%][A-Za-z]\w*\(([\s\S]*)\)$/);
  if (!m) return null;
  const argsText = m[1].trim();
  if (argsText === "") return { min: 0, max: 0 };

  const parts = argsText.split(",").map((s) => s.trim());
  const vararg = parts.includes("...");
  const params = parts.filter((p) => p !== "...");
  return {
    min: params.filter((p) => !p.startsWith("[")).length,
    max: vararg ? Infinity : params.length,
  };
}

/**
 * The signature fields the argument-count checks read from a docs entry.
 * @typedef {{ signature?: string, overloads?: { product: string, signature: string }[] }} FunctionSignatures
 */

/**
 * The argument range any documented form of a function accepts: its
 * `signature` and its other products' `overloads` (e.g. BuildMaster's
 * three-argument `$PackageProperty` next to ProGet's two-argument one) --
 * the fewest any form requires to the most any form takes, so a call is
 * never flagged for using a form that is valid somewhere. Null when a form
 * isn't a parenthesized call.
 *
 * @param {FunctionSignatures} doc
 * @returns {{ min: number, max: number } | null}
 */
function arityOf(doc) {
  let min = Infinity;
  let max = 0;
  for (const signature of [doc.signature, ...(doc.overloads ?? []).map((o) => o.signature)]) {
    if (!signature) continue;
    const arity = parseArity(signature);
    if (!arity) return null;
    min = Math.min(min, arity.min);
    max = Math.max(max, arity.max);
  }
  return min === Infinity ? null : { min, max };
}

/**
 * Finds calls to known functions with more arguments than any documented
 * form takes (`too-many-arguments`) or fewer than every form requires
 * (`too-few-arguments`), given text already masked by
 * {@link maskNonCodeSpans} (and, for template-aware documents,
 * {@link maskOutsideTemplateTags}).
 *
 * @param {vscode.TextDocument} document - Used only for `positionAt()`.
 * @param {string} maskedText - Full document text, already masked.
 * @param {string} [text] - The same text unmasked (default: the document's);
 *   masking blanks a string argument, so `$F("x")` would look empty
 * @returns {vscode.Diagnostic[]}
 */
function findArgumentCountDiagnosticsFromMasked(document, maskedText, text = document.getText()) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  /**
   * @param {number} start - Index just after the call's '('
   * @param {number} end - Index of the matching ')'
   * @returns {number} Number of top-level comma-separated arguments
   */
  function countArgs(start, end) {
    const body = maskedText.slice(start, end);
    // Blank once masked: no argument, or a single string (or a comment).
    if (body.trim() === "") {
      const state = createCodeScanState();
      const raw = text.slice(start, end).split("\n").map((line) => maskCommentSpans(line, state)).join("\n");
      return raw.trim() === "" ? 0 : 1;
    }

    let depth = 0;
    let count = 1;
    for (const ch of body) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") { if (depth > 0) depth--; }
      else if (ch === "," && depth === 0) count++;
    }
    return count;
  }

  for (const match of maskedText.matchAll(FUNCTION_CALL_REGEX)) {
    const [whole, sigil, name] = match;
    const doc = lookupOwn(FUNCTION_TABLES[sigil].docs, name);
    const arity = doc && arityOf(doc);
    if (!arity) continue;

    const openParenIndex = /** @type {number} */ (match.index) + whole.length - 1;
    const closeParenIndex = findMatchingParen(maskedText, openParenIndex);
    if (closeParenIndex === -1) continue;

    const argCount = countArgs(openParenIndex + 1, closeParenIndex);
    /**
     * @param {number} n
     * @returns {string} `n argument(s)`
     */
    const args = (n) => `${n} argument${n === 1 ? "" : "s"}`;
    let message;
    let code;
    if (argCount > arity.max) {
      message = `'${sigil}${name}' takes at most ${args(arity.max)}, got ${argCount}.`;
      code = "too-many-arguments";
    } else if (argCount < arity.min) {
      message = `'${sigil}${name}' needs at least ${args(arity.min)}, got ${argCount}.`;
      code = "too-few-arguments";
    } else {
      continue;
    }

    const nameStart = /** @type {number} */ (match.index) + 1;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + name.length)),
      message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = code;
    diagnostic.source = "OtterScript";
    issues.push(diagnostic);
  }
  return issues;
}

/**
 * Gets the diagnostic code as a string, unwrapping the `{ value, target }`
 * object form; returns '' when the diagnostic has no code.
 * @param {vscode.Diagnostic} diagnostic
 * @returns {string}
 */
function getDiagnosticCode(diagnostic) {
  const code = diagnostic.code;
  if (code === undefined || code === null) return '';
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

// ============================================================
// UNBALANCED SYMBOLS
// ============================================================

/**
 * Creates a diagnostic for unbalanced symbols.
 * @param {number} count - Current count (positive = unclosed, negative = extra closing)
 * @param {number} lastPos - Document offset of the symbol to report: the
 *   outermost still-open opener when `count > 0`, or the extra closer when
 *   `count < 0`
 * @param {string} openChar - Opening character ('{', '(', '[')
 * @param {string} closeChar - Closing character ('}', ')', ']')
 * @param {string} name - Display name ('brace', 'parenthesis', 'bracket')
 * @param {vscode.TextDocument} document - The document
 * @returns {vscode.Diagnostic | null}
 */
function createUnbalancedDiagnostic(count, lastPos, openChar, closeChar, name, document) {
  if (count === 0) return null;

  const pos = document.positionAt(lastPos);
  const lineNum = pos.line + 1;
  const colNum = pos.character + 1;
  const message = count > 0
    ? `Unclosed ${name}(s): ${count} '${openChar}' not closed (first at line ${lineNum}, col ${colNum})`
    : `Unexpected closing ${name}: Extra '${closeChar}' at line ${lineNum}, col ${colNum}`;

  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(pos, document.positionAt(lastPos + 1)),
    message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.code = "unbalanced-symbol";
  diagnostic.source = "OtterScript";
  return diagnostic;
}

/**
 * The settings the checks read -- the live settings object from extension.js.
 *
 * @typedef {object} DiagnosticsContext
 * @property {Readonly<Record<string, string>>} [diagnosticRules] - The
 *   `otterscript.diagnostics.rules` setting: diagnostic code -> `"off"` or a
 *   severity override (see {@link applyDiagnosticRules})
 * @property {string} [adaptiveCardMaxVersion] - The
 *   `otterscript.adaptiveCards.maxVersion` setting: the highest Adaptive Card
 *   version the target host supports
 */

/**
 * Every diagnostic code this extension emits. Each one can be switched off or
 * re-ranked via the `otterscript.diagnostics.rules` setting, whose schema in
 * package.json must list exactly these codes (guarded by a unit test).
 * @type {ReadonlyArray<string>}
 */
const DIAGNOSTIC_CODES = Object.freeze([
  // -- Syntax & balance
  "unbalanced-symbol",
  "missing-dollar",
  "assignment-in-condition",
  "invalid-operator",
  "incorrect-for-usage",
  "duplicate-map-key",
  // -- Unknown names & arity
  "unknown-scalar-function",
  "unknown-vector-function",
  "unknown-map-function",
  "unknown-operation",
  "unknown-namespace",
  "too-many-arguments",
  "too-few-arguments",
  // -- Text templates (`<% %>`)
  "template-unexpected-close",
  "template-unclosed",
  "template-end-keyword",
  "template-missing-brace",
  "template-in-expression",
  // -- Adaptive Cards
  "adaptivecard-missing-version",
  "adaptivecard-unknown-type",
  "adaptivecard-invalid-value",
  "adaptivecard-version-too-low",
  "adaptivecard-version-too-high",
  "adaptivecard-templating-keyword",
  "adaptivecard-unknown-target",
  "adaptivecard-duplicate-id",
  "adaptivecard-content-type",
  "adaptivecard-webhook-submit",
]);

/**
 * `otterscript.diagnostics.rules` values other than `"off"`, mapped to the
 * severity they force.
 * @type {Readonly<Record<string, vscode.DiagnosticSeverity>>}
 */
const RULE_SEVERITIES = Object.freeze({
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
});

/**
 * Applies the user's per-code rules: drops diagnostics whose code is set to
 * `"off"` and overrides the severity of those set to a severity name.
 * Diagnostics with no rule, or an unrecognized rule value, pass through
 * unchanged. Mutates the severity of the surviving diagnostics in place.
 *
 * @param {vscode.Diagnostic[]} issues
 * @param {Readonly<Record<string, string>> | undefined} rules
 * @returns {vscode.Diagnostic[]}
 */
function applyDiagnosticRules(issues, rules) {
  if (!rules || Object.keys(rules).length === 0) return issues;
  return issues.filter((issue) => {
    const rule = rules[getDiagnosticCode(issue)];
    if (rule === "off") return false;
    // Own keys only: `in` would also match inherited names such as
    // "constructor" and assign a function as the severity.
    if (rule !== undefined && Object.hasOwn(RULE_SEVERITIES, rule)) issue.severity = RULE_SEVERITIES[rule];
    return true;
  });
}

/**
 * Matches a `Namespace::` qualifier: a bare identifier followed by `::` and then
 * a letter (the operation name). Group 1 is the char before the token so we can
 * reject mid-token matches; group 2 is the namespace token itself.
 * @type {RegExp}
 */
const NAMESPACE_QUALIFIER_REGEX = /(^|[^A-Za-z0-9_$@:])([A-Za-z][A-Za-z0-9]*)::(?=[A-Za-z])/g;

// -- Text-template (`<% ... %>`) structural checks --------------------------
/**
 * Tag body that is only a block-terminator keyword (`end`, `endforeach`, ...).
 * @type {RegExp}
 */
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
 * @param {string} code - Diagnostic code; one of {@link DIAGNOSTIC_CODES}
 * @returns {vscode.Diagnostic}
 */
function lineDiagnostic(lineIndex, start, end, message, severity, code) {
  const d = new vscode.Diagnostic(
    new vscode.Range(new vscode.Position(lineIndex, start), new vscode.Position(lineIndex, end)),
    message,
    severity
  );
  d.code = code;
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
          vscode.DiagnosticSeverity.Error,
          "template-unexpected-close"
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
 * Where the condition of an `if` line ends: at the `{` that opens its body
 * (outside parentheses), or at the end of the line when the brace is on a
 * later line. A braced variable such as `${my var}` is part of the condition,
 * not the body.
 *
 * @param {string} line - Masked by `maskNonCodeSpans`
 * @returns {number} Index just past the condition, or -1 when the line isn't
 *   an `if` statement
 */
function findIfConditionEnd(line) {
  const start = /^\s*if\b/.exec(line);
  if (!start) return -1;
  let depth = 0;
  for (let i = start[0].length; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") depth++;
    else if (ch === ")") { if (depth > 0) depth--; }
    else if (ch === "{") {
      if ("$@%".includes(line[i - 1])) {
        const close = line.indexOf("}", i);
        if (close === -1) return line.length;
        i = close;
      } else if (depth === 0) {
        return i;
      }
    }
  }
  return line.length;
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
  if (document.languageId !== "otterscript" || isReadOnlyView(document)) return;

  const text = document.getText();

  const { diagnosticRules, adaptiveCardMaxVersion } = ctx;

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
    const missingDollarDiagnostic = checkMissingDollar(line, lineIndex, NON_VARIABLE_IDENTIFIERS);
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
    // -- Unknown `$Name(`, `@Name(` and `%Name(` functions
    for (const match of line.matchAll(FUNCTION_CALL_REGEX)) {
      const [, sigil, name] = match;
      const { docs, kind } = FUNCTION_TABLES[sigil];
      if (lookupOwn(docs, name)) continue;
      const start = /** @type {number} */ (match.index) + 1;
      issues.push(lineDiagnostic(
        lineIndex, start, start + name.length,
        `Unknown ${kind} function '${sigil}${name}'`,
        vscode.DiagnosticSeverity.Warning,
        `unknown-${kind}-function`
      ));
    }

    // -- Detect unknown operations. Only a word in operation position counts:
    //    the first word of a statement (after the line start, `{`, `}` or
    //    `;`, optionally behind `Namespace::`). Dashed words elsewhere are
    //    names, which Inedo's grammar lets contain dashes too -- variables
    //    (`$my-var`), map keys and parameter names (`my-key: 1`, also when
    //    one starts a line), module names (`call My-Module`) and implicit
    //    string arguments (`Ensure-Thing My-Arg`).
    for (const match of line.matchAll(/\b([A-Za-z][A-Za-z-]*)\b/g)) {
      const name = match[1];
      const before = line.slice(0, match.index);

      // When the token is the operation half of `UnknownNs::Do-Thing`, the
      // unknown-namespace check below already flags the real problem -- don't
      // also report the operation name as unknown.
      const qualifier = before.match(/([A-Za-z][A-Za-z0-9]*)::$/)?.[1];
      if (qualifier && !KNOWN_NAMESPACES.has(qualifier.toLowerCase())) continue;
      // A known namespace whose operations aren't documented: nothing to compare against.
      if (qualifier && !DOCUMENTED_OPERATION_NAMESPACES.has(qualifier.toLowerCase())) continue;

      const statementStart = qualifier ? before.slice(0, -(qualifier.length + 2)) : before;
      // A `{` right after a sigil opens a braced variable (`${my-var}`), not a block.
      if (!/(?:^|[;}]|(?<![$@%])\{)\s*$/.test(statementStart)) continue;
      if (/^\s*(?::|=>)/.test(line.slice(match.index + name.length))) continue;

      if (
        name.includes("-") &&
        !lookupOwn(keywordDocs, name) &&
        !lookupOwn(operationDocs, name)
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
      if (KNOWN_NAMESPACES.has(token.toLowerCase())) continue;

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
    const conditionEnd = findIfConditionEnd(line);
    if (conditionEnd !== -1) {
      // -- Detect assignment-like '=' in conditions (likely intended as '==').
      // `line` is already a length-preserving masked version of the source line.
      // Only the condition is checked: a body on the same line
      // (`if $x { set $y = 1; }`) has real assignments.
      for (let j = 0; j < conditionEnd; j++) {
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
      for (let j = 0; j < conditionEnd; j++) {
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
    // Matches: for i = 1 to 10, for $item in @list, for item in list, with
    // dashed names too ($item-name), in any case -- so the position comes from
    // the match, not a search for "for".
    const forLoopMatch = /^(\s*)for\s+([$@%]?[A-Za-z](?:[\w-]*[A-Za-z0-9])?)\s+(=|in)\s+/i.exec(line);
    if (forLoopMatch) {
      const startIndex = forLoopMatch[1].length;
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
      vscode.DiagnosticSeverity.Error,
      "template-unclosed"
    ));
  }

  // -- Duplicate map keys, argument counts, and (template-aware documents
  //    only) content-triggered Adaptive Card checks. Isolated in its own try/catch:
  //    these run over the whole joined document rather than per-line like
  //    every check above, so a bug here must not be able to wipe out the
  //    per-line diagnostics already collected above it.
  const joinedMasked = maskedLines.join("\n");
  try {
    issues.push(...findDuplicateMapKeyDiagnosticsFromMasked(document, joinedMasked));
    issues.push(...findArgumentCountDiagnosticsFromMasked(document, joinedMasked));
    if (templateAware) {
      // Triggered by a literal "type": "AdaptiveCard" in the literal output.
      issues.push(...findAdaptiveCardDiagnostics(document, text, { maxVersion: adaptiveCardMaxVersion }));
    }
  } catch (err) {
    log.error(`Cross-line diagnostic scan failed for ${document.uri.toString()}:`, err);
  }

  collection.set(document.uri, applyDiagnosticRules(issues, diagnosticRules));
}

module.exports = {
  DIAGNOSTIC_CODES,
  applyDiagnosticRules,
  checkMissingDollar,
  createUnbalancedDiagnostic,
  findDuplicateMapKeyDiagnosticsFromMasked,
  getDiagnosticCode,
  updateDiagnostics,
};
