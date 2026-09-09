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
  createUnbalancedDiagnostic,
  findDuplicateMapKeyDiagnosticsFromMasked,
  maskNonCodeSpans,
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

  // -- Split into lines for line-by-line processing
  const lines = text.split("\n");

  // -- Process all lines
  const maskedLines = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = maskNonCodeSpans(lines[lineIndex], scanState);
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

  // -- Detect duplicate keys inside map expressions: %( key: value, key: value )
  issues.push(...findDuplicateMapKeyDiagnosticsFromMasked(document, maskedLines.join("\n")));

  collection.set(document.uri, issues);
}

module.exports = {
  updateDiagnostics,
};
