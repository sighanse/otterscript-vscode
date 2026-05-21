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
  createUnbalancedDiagnostic,
  findDuplicateMapKeyDiagnostics,
  stripStrings,
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
 * @property {() => RegExp} scalarCallRegex - Regex factory for scalar function calls
 * @property {() => RegExp} vectorCallRegex - Regex factory for vector function calls
 * @property {() => RegExp} operationCallRegex - Regex factory for operation-like tokens
 */

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
    scalarCallRegex,
    vectorCallRegex,
    operationCallRegex,
  } = ctx;

  // -- Parser state variables (track position and context)
  let braces = 0;             // { } balance
  let parens = 0;             // ( ) balance
  let brackets = 0;           // [ ] balance
  let lastBracePos = -1;      // Offset of first unmatched '{'; -1 = not yet seen
  let lastParenPos = -1;      // Offset of first unmatched '('; -1 = not yet seen
  let lastBracketPos = -1;    // Offset of first unmatched '['; -1 = not yet seen
  let inString = false;       // Currently inside a quoted string?
  let inBlockComment = false; // Currently inside a block comment?
  let swimDelimiter = null;   // Active swim-string delimiter (e.g., ">==8>")
  let stringChar = "";       // Current quote character (' or ")
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  // -- Split into lines for line-by-line processing
  const lines = text.split("\n");

  // -- Process all lines
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];

    // ------------------------------------------------------------
    // Missing '$' in if conditions
    // ------------------------------------------------------------
    if (!inBlockComment) {
      const diagnostic = checkMissingDollar(rawLine, lineIndex, nonVariableIdentifiers);
      if (diagnostic) {
        issues.push(diagnostic);
      }
    }

    // ------------------------------------------------------------
    // Character-by-character state tracking
    // ------------------------------------------------------------
    for (let col = 0; col < rawLine.length; col++) {
      const ch = rawLine[col];

      // -- Block Comment Handling (Highest priority)
      if (inBlockComment) {
        // -- Check for closing */
        if (ch === "*" && rawLine[col + 1] === "/") {
          inBlockComment = false;
          col++; // Skip the '/'
        }
        continue; // Skip everything else while in block comment
      }

      // -- Check for opening /*
      if (!inString && swimDelimiter === null &&
          ch === "/" && rawLine[col + 1] === "*") {
        inBlockComment = true;
        col++; // Skip the '*'
        continue;
      }

      // -- Handle regular strings (single/double quoted)
      if (swimDelimiter === null && (ch === '"' || ch === "'")) {
        if (!inString) {
          inString = true;
          stringChar = ch;
        } else if (ch === stringChar) {
          // -- Check if this quote is escaped
          let backslashCount = 0;
          let pos = col - 1;
          while (pos >= 0 && rawLine[pos] === "\\") {
            backslashCount++;
            pos--;
          }
          if (backslashCount % 2 === 0) {
            inString = false;
          }
        }
        continue;
      }

      // -- Handle swim-strings (fish sentinels)
      if (!inString && swimDelimiter === null && ch === ">") {
        const m = rawLine.slice(col).match(/^>[^>]{0,5}>/);
        if (m) {
          swimDelimiter = m[0];
          col += swimDelimiter.length - 1;
          continue;
        }
      }

      // -- Exit swim-string when finding the matching delimiter
      if (swimDelimiter) {
        if (rawLine.startsWith(swimDelimiter, col)) {
          col += swimDelimiter.length - 1;
          swimDelimiter = null;
        }
        continue;
      }

      // -- Skip line comments (# or //)
      if (!inString && swimDelimiter === null &&
          (ch === "#" || (ch === "/" && rawLine[col + 1] === "/"))) {
        break; // Skip rest of line
      }

      // -- Count braces for balance checking
      if (!inString && swimDelimiter === null) {

        // -- Braces { }
        if (ch === "{") {
          braces++;
          if (braces === 1) lastBracePos = document.offsetAt(new vscode.Position(lineIndex, col));
        } else if (ch === "}") {
          if (braces === 0) {
            // Unexpected closing - report immediately
            const pos = document.offsetAt(new vscode.Position(lineIndex, col));
            const diag = createUnbalancedDiagnostic(-1, pos, "{", "}", "brace", document);
            if (diag) issues.push(diag);
          } else {
            braces--;
          }
        }

        // -- Parenthesis ( )
        else if (ch === "(") {
          parens++;
          if (parens === 1) lastParenPos = document.offsetAt(new vscode.Position(lineIndex, col));
        } else if (ch === ")") {
          if (parens === 0) {
            // Unexpected closing - report immediately
            const pos = document.offsetAt(new vscode.Position(lineIndex, col));
            const diag = createUnbalancedDiagnostic(-1, pos, "(", ")", "parenthesis", document);
            if (diag) issues.push(diag);
          } else {
            parens--;
          }
        }

        // -- Brackets [ ]
        else if (ch === "[") {
          brackets++;
          if (brackets === 1) lastBracketPos = document.offsetAt(new vscode.Position(lineIndex, col));
        } else if (ch === "]") {
          if (brackets === 0) {
            // Unexpected closing - report immediately
            const pos = document.offsetAt(new vscode.Position(lineIndex, col));
            const diag = createUnbalancedDiagnostic(-1, pos, "[", "]", "bracket", document);
            if (diag) issues.push(diag);
          } else {
            brackets--;
          }
        }
      }
    }

    // ============================================================
    // SYMBOL DETECTION
    // ============================================================
    if (!inBlockComment) {
      // -- Skip comment-only lines
      if (!/^\s*#/.test(rawLine) && !/^\s*\/\//.test(rawLine)) {
        // -- Strip strings for symbol detection
        const line = stripStrings(rawLine);

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

        // -- Detect invalid logical operators
        if (/^\s*if\b/.test(line)) {
          // -- Detect assignment-like '=' in conditions (likely intended as '==')
          // Scan rawLine with a length-preserving mask so that column index j
          // always maps correctly back to the original document position.
          // Replacing string contents with spaces (not empty) keeps all indexes stable.
          const maskedLine = rawLine
            .replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, m => m[0] + " ".repeat(m.length - 2) + m[0])
            .replace(/(#|\/\/).*$/, m => " ".repeat(m.length));

          for (let j = 0; j < maskedLine.length; j++) {
            if (maskedLine[j] !== "=") continue;

            const prev = maskedLine[j - 1];
            const next = maskedLine[j + 1];
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
    }
  }

  // -- Unbalanced opening braces, parentheses, brackets
  const symbols = [
    { count: braces, lastPos: lastBracePos, open: "{", close: "}", name: "brace" },
    { count: parens, lastPos: lastParenPos, open: "(", close: ")", name: "parenthesis" },
    { count: brackets, lastPos: lastBracketPos, open: "[", close: "]", name: "bracket" },
  ];

  for (const sym of symbols) {
    if (sym.count > 0) {
      const diag = createUnbalancedDiagnostic(sym.count, sym.lastPos, sym.open, sym.close, sym.name, document);
      if (diag) issues.push(diag);
    }
  }

  // -- Detect duplicate keys inside map expressions: %( key: value, key: value )
  issues.push(...findDuplicateMapKeyDiagnostics(document, text));

  collection.set(document.uri, issues);
}

module.exports = {
  updateDiagnostics,
};
