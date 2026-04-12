/**
 * OtterScript VS Code extension entry point.
 *
 * Responsibilities:
 * - Register language features (completion, hover, signature help)
 * - Bridge plain docs (docs.js) into VS Code UI objects
 * - Provide lightweight diagnostics (syntax sanity checks)
 *
 * Design principles:
 * - docs.js contains ONLY plain data (no vscode imports)
 * - extension.js is the only place that creates VS Code objects
 * - Snippets own insertion text; providers never guess prefixes
 */

const vscode = require("vscode");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log("OtterScript extension active");

  // Configuration
  let completionEnabled = true;
  let hoverEnabled = true;
  let signatureHelpEnabled = true;

  function loadConfig() {
    const config = vscode.workspace.getConfiguration("otterscript");
    completionEnabled = config.get("completion.enable", true);
    hoverEnabled = config.get("hover.enable", true);
    signatureHelpEnabled = config.get("signatureHelp.enable", true);
  }
  // Load configuration settings now and on change
  loadConfig();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("otterscript")) {
        loadConfig();
      }
    })
  );

  // Import language documentation from docs.js
  // Objects contain plain strings only.
  // Any conversion to MarkdownString happens in this file.
  let docs;
  try {
    docs = require("./docs.js");
  } catch (err) {
    console.error("Failed to load docs.js", err);

    vscode.window.showErrorMessage(
      "OtterScript Language Support failed to load documentation data. " +
      "The extension could not be activated. Check the developer console for details."
    );

    // Abort activation cleanly
    return;
  }
  const {
    operationDocs,
    syntaxDocs,
    keywordDocs,
    variableDocs,
    scalarFunctionDocs,
    vectorFunctionDocs
  } = docs;


  /**
   * Builds a word-boundary RegExp that matches any of the given names.
   *
   * @param {Iterable<string>} names
   * @returns {RegExp}
   */
  function buildWordRegex(names) {
    return new RegExp(
      `\\b(${[...names]
        .map(name =>
          name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
        )
        .join("|")})\\b`
    );
  }

  // Identifiers that are keywords/literals, not variables requiring '$'
  const nonVariableIdentifiers = new Set([
    "true","false","null"
  ]);


  /**
   * Returns true if the given position is inside a quoted string
   * or a line comment.
   *
   * This uses a fast, best-effort heuristic and does not attempt
   * full parsing.
   *
   * @param {string} line
   * @param {number} position
   * @returns {boolean}
   */
  function isInStringOrComment(line, position) {
    const prefix = line.slice(0, position);

    // Inside line comment
    if (/^\s*(#|\/\/)/.test(prefix)) {
      return true;
    }

    // Inside quoted string (simple, fast heuristic)
    const doubleQuotes = (prefix.match(/"/g) || []).length;
    const singleQuotes = (prefix.match(/'/g) || []).length;

    return doubleQuotes % 2 === 1 || singleQuotes % 2 === 1;
  }

  /**
   * Replaces quoted string literals in a line with empty placeholders.
   *
   * @param {string} line
   * @returns {string}
   */
  function stripStrings(line) {
    return line
      // double-quoted strings
      .replace(/"([^"\\]|\\.)*"/g, '""')
      // single-quoted strings
      .replace(/'([^'\\]|\\.)*'/g, "''");
  }

  /**
   * Performs best-effort validation of documentation tables.
   *
   * This function intentionally validates unknown input and
   * reports warnings instead of throwing.
   *
   * @param {string} label Human-readable category label (e.g. "keywordDocs")
   * @param {Record<string, unknown>} docs Documentation table to validate
   */
    function validateDocs(label, docs) {
      for (const [key, rawDoc] of Object.entries(docs)) {
        /** @type {any} */
        const doc = rawDoc;

      if (!doc || typeof doc !== "object") {
        console.warn(`[docs] ${label}.${key} is not an object`);
        continue;
      }
      if (!doc.name || typeof doc.name !== "string") {
        console.warn(`[docs] ${label}.${key} is missing required 'name'`);
      }
      if (!doc.description || typeof doc.description !== "string") {
        console.warn(`[docs] ${label}.${key} is missing required 'description'`);
      }
      if (doc.snippet && typeof doc.snippet !== "string") {
        console.warn(`[docs] ${label}.${key} 'snippet' must be a string`);
      }
      if (doc.signature && typeof doc.signature !== "string") {
        console.warn(`[docs] ${label}.${key} 'signature' must be a string`);
      }
      if (doc.documentation && typeof doc.documentation !== "string") {
        console.warn(`[docs] ${label}.${key} 'documentation' must be a string`);
      }
    }
  }

  validateDocs("scalarFunctionDocs", scalarFunctionDocs);
  validateDocs("operationDocs", operationDocs);
  validateDocs("vectorFunctionDocs", vectorFunctionDocs);
  validateDocs("variableDocs", variableDocs);
  //validateDocs("syntaxDocs", syntaxDocs);
  validateDocs("keywordDocs", keywordDocs);

  const knownKeywords = new Set(Object.keys(keywordDocs));
  const knownScalarFunctions = new Set(Object.keys(scalarFunctionDocs));
  const knownVectorFunctions = new Set(Object.keys(vectorFunctionDocs));
  const knownOperations = new Set(Object.keys(operationDocs));

  const operationRegex = buildWordRegex(knownOperations);
  const scalarCallRegex = () => /\$([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
  const vectorCallRegex = () => /@([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
  const operationCallRegex = () => /\b([A-Za-z][A-Za-z-]*)\b/g;

  // ============================================================
  // SIGNATURE HELP
  // ============================================================
  // Provides parameter hints for $scalar(...) and @vector(...)

  const signatureHelpProvider =
    vscode.languages.registerSignatureHelpProvider(
      "otterscript",
      {
        provideSignatureHelp(document, position) {
          // Check if the signature help provider is enabled in settings
          if (!signatureHelpEnabled) {
            return null;
          }

          const line = document.lineAt(position.line).text.slice(0, position.character);

          // Find the last function call before cursor
          const match = line.match(/([@$])([A-Za-z][A-Za-z0-9]*)\s*\(([^()]*)$/);
          if (!match) return null;

          const [, prefix, name, args] = match;
          const fn =
            prefix === "$"
              ? scalarFunctionDocs[name]
              : vectorFunctionDocs[name];

          // No matching function found at the cursor position
          if (!fn) return null;
          // Signature help only makes sense when a concrete signature exists
          if (!fn.signature) return null;

          let activeParam = 0;
          let inString = false;
          let quote = null;

          for (const ch of args) {
            if ((ch === '"' || ch === "'") && !inString) {
              inString = true;
              quote = ch;
            } else if (ch === quote) {
              inString = false;
            } else if (!inString && ch === ",") {
              activeParam++;
            }
          }

          const sig = new vscode.SignatureInformation(
            fn.signature,
            fn.documentation
          );

          const paramList = fn.signature.match(/\(([^)]+)\)/);
          if (paramList) {
            sig.parameters = paramList[1]
              .split(",")
              .map(p => new vscode.ParameterInformation(p.trim()));
          }

          const help = new vscode.SignatureHelp();
          help.signatures = [sig];
          help.activeSignature = 0;
          help.activeParameter = Math.min(
            activeParam,
            sig.parameters.length - 1
          );

          return help;
        }
      },
      "(",
      ","
    );


  // ------------------------------------------------------------
  // SCALAR FUNCTION COMPLETION ($Function)
  // ------------------------------------------------------------
  // Triggered after typing '$'.

  const functionCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled in settings
          if (!completionEnabled) {
            return null;
          }

          const linePrefix = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          const match = linePrefix.match(/\$([a-zA-Z]*)$/);
          if (!match) return [];

          const typed = match[1];

          return Object.keys(scalarFunctionDocs)
            .filter(name =>
              name.toLowerCase().startsWith(typed.toLowerCase())
            )
            .map(name => {
              const doc = scalarFunctionDocs[name];
              const item = new vscode.CompletionItem(
                doc.name,
                vscode.CompletionItemKind.Function
              );

              // Snippet-style insertion
              if (doc.snippet) {
                // Strip leading \$ because $ already exists in text
                item.insertText = new vscode.SnippetString(
                  doc.snippet.replace(/^\\\$/, "")
                );
              } else {
                // Fallback for scalar functions without snippets
                item.insertText = new vscode.SnippetString(`${name}($0)`)
              }
              item.detail = doc.signature;
              item.documentation = doc.documentation
                ? new vscode.MarkdownString(doc.documentation)
                : undefined;
              item.sortText = `1_${name}`;

              return item;
            });
        }
      },
      "$"
    );

  // ------------------------------------------------------------
  // VARIABLE COMPLETION ($Variable)
  // ------------------------------------------------------------
  // Triggered after typing '$'.

  const variableCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled in settings
          if (!completionEnabled) {
            return [];
          }

          const text = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          const match = text.match(/\$([A-Za-z]*)$/);
          if (!match) return [];

          const typed = match[1];

          return Object.keys(variableDocs)
            .filter(name =>
              name.toLowerCase().startsWith(typed.toLowerCase())
            )
            .map(name => {
              const doc = variableDocs[name];
              const item = new vscode.CompletionItem(
                doc.name,
                vscode.CompletionItemKind.Variable
              );
              item.insertText = doc.name.startsWith("$") ? doc.name.slice(1) : doc.name;
              item.detail = doc.description;
              item.sortText = `2_${doc.name}`;

              return item;
            });
        }
      },
      "$"
    );

  // ------------------------------------------------------------
  // VECTOR FUNCTION / VARIABLE COMPLETION (@Function / @Variable)
  // ------------------------------------------------------------
  // Triggered after typing '@'.

  const vectorCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled in settings
          if (!completionEnabled) {
            return [];
          }

          const linePrefix = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          const match = linePrefix.match(/@([a-zA-Z]*)$/);
          if (!match) return [];

          const typed = match[1];

          return Object.keys(vectorFunctionDocs)
            .filter(name =>
              name.toLowerCase().startsWith(typed.toLowerCase())
            )
            .map(name => {
              const doc = vectorFunctionDocs[name];
              const isFunction = doc.signature?.includes("(");

              const item = new vscode.CompletionItem(
                doc.name,
                isFunction
                  ? vscode.CompletionItemKind.Function
                  : vscode.CompletionItemKind.Variable
              );

              const insertName = doc.name.replace(/^\s*@/, "");
              if (isFunction) {
                item.insertText = new vscode.SnippetString(
                  doc.snippet ?? `${insertName}($0)`
                );
              } else {
                item.insertText = new vscode.SnippetString(`${insertName}`);
              }

              item.detail = doc.signature || `@${name}`;
              item.documentation = doc.documentation
                ? new vscode.MarkdownString(doc.documentation)
                : undefined;
              item.sortText = isFunction
                ? `2_${name}` // functions after variables
                : `1_${name}`;

              return item;
            });
        }
      },
      "@"
    );

  // ------------------------------------------------------------
  // OPERATION COMPLETION (Log-Information, etc.)
  // ------------------------------------------------------------
  // Operations are NOT prefixed by '$' or '@'.
  // Snippets for operations own the full inserted text.

  const operationCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled in settings
          if (!completionEnabled) {
            return [];
          }

          const line = document.lineAt(position.line).text;
          const cursor = position.character;
          const prefix = line.slice(0, cursor);

          // Do not trigger inside strings or comments
          if (isInStringOrComment(line, cursor)) {
            return [];
          }

          // Only trigger on word starts (not $ or @)
          const match = prefix.match(/\b([A-Za-z]+(?:-[A-Za-z]+)*)$/);
          if (!match) return [];

          const typed = match[1];

          // Require at least 3 characters to avoid noise
          if (typed.length < 3) {
            return [];
          }

          const keywordItems = [...knownKeywords]
            .filter(name =>
              name.toLowerCase().startsWith(typed.toLowerCase())
            )
            .map(name => {
              const doc = keywordDocs[name];
              const item = new vscode.CompletionItem(
                {
                  label: doc.name,
                  description: doc.description
                },
                vscode.CompletionItemKind.Function
              );

              // Snippet-style insertion
              if (doc.snippet) {
                item.insertText = new vscode.SnippetString(doc.snippet);
              } else {
                // Keywords without snippets: insert keyword only
                item.insertText = doc.name;
              }
              item.detail = doc.signature ?? doc.description ?? "OtterScript keyword";
              item.documentation = doc.documentation
                ? new vscode.MarkdownString(doc.documentation)
                : undefined;

              // Keywords after operations
              item.sortText = `1_${name}`;

              return item;
            });

          const operationItems = [...knownOperations]
            .filter(name =>
              name.toLowerCase().startsWith(typed.toLowerCase())
            )
            .map(name => {
              const doc = operationDocs[name];
              const item = new vscode.CompletionItem(
                {
                  label: doc.name,
                  description: doc.description
                },
                vscode.CompletionItemKind.Function
              );

              // Snippet-style insertion
              if (doc.snippet) {
                item.insertText = new vscode.SnippetString(doc.snippet);
              } else {
                item.insertText = new vscode.SnippetString(
                  `${doc.name} "$0";`
                );
              }
              item.detail = doc.signature ?? doc.description ?? "OtterScript operation";
              item.documentation = doc.documentation
                ? new vscode.MarkdownString(doc.documentation)
                : undefined;

              // Priority: operations above keywords
              item.sortText = `0_${name}`;

              return item;
            });

        return [
          ...operationItems,
          ...keywordItems
        ];
        }
      }
    );

  // ============================================================
  // HOVER
  // ============================================================
  // Hover resolution order (most specific first):
  // 1. Template tags (<% %>)
  // 2. Expression delimiters (%(), @(), $())
  // 3. Keywords (if, foreach, with, etc.)
  // 4. Operations (Log-*)
  // 5. Symbols ($var, @vector, functions)

  const hoverProvider = vscode.languages.registerHoverProvider("otterscript", {
    provideHover(document, position) {
      // Check if hover is enabled in settings
      if (!hoverEnabled) {
        return null;
      }

      // Check for template tag
      const templateRange = document.getWordRangeAtPosition(position, /<%|%>/);
      if (templateRange) {
        const text = document.getText(templateRange);
        if (text === '<%') {
          return new vscode.Hover(
                new vscode.MarkdownString(syntaxDocs.templateOpen), templateRange);
          }
        if (text === '%>') {
          return new vscode.Hover(
                new vscode.MarkdownString(syntaxDocs.templateClose), templateRange);
        }
      }

      // Check for expression delimiters
      const exprRange = document.getWordRangeAtPosition(position, /%\(|@\(|\$\(/);
      if (exprRange) {
          const text = document.getText(exprRange);
          if (text === '%(') {
              return new vscode.Hover(
                  new vscode.MarkdownString(syntaxDocs.mapExpr), exprRange);
          }
          if (text === '@(') {
              return new vscode.Hover(
                  new vscode.MarkdownString(syntaxDocs.vectorExpr),exprRange);
          }
          if (text === '$(') {
              return new vscode.Hover(
                  new vscode.MarkdownString(syntaxDocs.nestedEval),exprRange);
          }
      }
      // Check for keywords
      const wordRange = document.getWordRangeAtPosition(
        position,
        /\b[a-zA-Z]+(?:-[a-zA-Z]+)*\b/
      );

      if (wordRange) {
        const word = document.getText(wordRange);

        if (knownKeywords.has(word) && !word.startsWith("$") && !word.startsWith("@")){
          const doc = keywordDocs[word];
          const markdown = new vscode.MarkdownString();
          markdown.appendMarkdown(`### ${doc.name}\n\n`);
          markdown.appendMarkdown(`${doc.description}\n\n`);

          if (typeof doc.documentation === "string") {
            markdown.appendMarkdown(doc.documentation);
          }
          return new vscode.Hover(markdown, wordRange);
        }
      }

      // Swim string delimiters (fish sentinels, e.g. >>, >==8>, >--=>)
      const swimRange = document.getWordRangeAtPosition(
        position,
        />[^>]{0,5}>/
      );

      if (swimRange) {
        return new vscode.Hover(
          new vscode.MarkdownString(syntaxDocs.swimString),
          swimRange
        );
      }

      // Check for Operations
      const operationRange = document.getWordRangeAtPosition(
      position,
      operationRegex
      );

      if (operationRange) {
        const opName = document.getText(operationRange);
        const doc = operationDocs[opName];

        if (doc) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`### ${doc.name}\n\n`);
          md.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
          md.appendMarkdown(`${doc.description}\n\n`);
          if (doc.documentation) {
            md.appendMarkdown(doc.documentation);
          }

          return new vscode.Hover(md, operationRange);
        }
      }

      // Check for Symbols
      const symbolRange = document.getWordRangeAtPosition(
        position,
        /[@$][A-Za-z][A-Za-z0-9]*/
      );
      if (!symbolRange) return null;

      const text = document.getText(symbolRange);
      const prefix = text[0];
      const name = text.substring(1);

      let doc;
      if (prefix === "$") {
        doc = scalarFunctionDocs[name] || variableDocs[name];
      } else if (prefix === "@") {
        doc = vectorFunctionDocs[name];
      }

      if (!doc) return null;

      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`### ${doc.name}\n\n`);

      if (doc.signature) {
        markdown.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
      }

      if (doc.description) {
        markdown.appendMarkdown(`${doc.description}\n\n`);
      }

      if (typeof doc.documentation === "string") {
        markdown.appendMarkdown(doc.documentation);
      }

      return new vscode.Hover(markdown, symbolRange);
    }
});

  // ============================================================
  // DIAGNOSTICS
  // ============================================================

  const diagnostics = vscode.languages.createDiagnosticCollection("otterscript");

  context.subscriptions.push(diagnostics);

  /**
   * Updates diagnostics for an OtterScript document.
   *
   * @param {import('vscode').TextDocument} document
   */
  function updateDiagnostics(document) {
    if (document.languageId !== "otterscript") return;

    const text = document.getText();
    let braces = 0;
    let lastPos = 0;
    let inString = false;
    let swimDelimiter = null;
    let stringChar = '';
    const issues = [];

    // Split into lines for condition checking
    const lines = text.split('\n');

    // Check for missing $ in if conditions
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: if variableName followed by comparison operator (=, ==, !=, <, >, <=, >=)
      const missingDollarMatch = line.match(/^\s*if\s+([a-zA-Z][a-zA-Z0-9_]*)\s*(=|==|!=|<=|>=|<|>)/);
      if (missingDollarMatch) {
        const varName = missingDollarMatch[1];
        const startIndex = line.indexOf(varName);

        // Do NOT warn for known keywords / literals
        if (nonVariableIdentifiers.has(varName)) {
          continue;
        }

        issues.push(
          new vscode.Diagnostic(
            new vscode.Range(
              new vscode.Position(i, startIndex),
              new vscode.Position(i, startIndex + varName.length)
            ),
            `Missing '$' before variable: ${varName}. Use $${varName}`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }

    // ------------------------------------------------------------
    // UNKNOWN SYMBOL DIAGNOSTICS
    // ------------------------------------------------------------

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const rawLine = lines[lineIndex];

      for (let col = 0; col < rawLine.length; col++) {
        const ch = rawLine[col];

        // Toggle string states
        if (swimDelimiter === null && (ch === '"' || ch === "'")) {
          if (!inString) {
            inString = true;
            stringChar = ch;
          } else if (ch === stringChar && rawLine[col - 1] !== '\\') {
            inString = false;
          }
          continue;
        }

        // Enter swim string
        if (!inString && swimDelimiter === null && ch === '>') {
          const m = rawLine.slice(col).match(/^>[^>]{0,5}>/);
          if (m) {
            swimDelimiter = m[0];
            col += swimDelimiter.length - 1;
            continue;
          }
        }

        // Exit swim string
        if (swimDelimiter) {
          if (rawLine.startsWith(swimDelimiter, col)) {
            col += swimDelimiter.length - 1;
            swimDelimiter = null;
          }
          continue;
        }

        // Skip line comments
        if (!inString && swimDelimiter === null &&
            (ch === '#' || (ch === '/' && rawLine[col + 1] === '/'))) {
          break;
        }

        // Skip block comments
        if (!inString && swimDelimiter === null &&
            ch === '/' && rawLine[col + 1] === '*') {
          while (
            lineIndex < lines.length &&
            !(rawLine[col] === '*' && rawLine[col + 1] === '/')
          ) {
            col++;
          }
          col++;
          continue;
        }

        // Count braces
        if (!inString && swimDelimiter === null) {
          if (ch === '{') {
            braces++;
            lastPos = document.offsetAt(
              new vscode.Position(lineIndex, col)
            );
          }
          if (ch === '}') {
            braces--;
          }
        }
      }
      // Skip comments quickly
      if (/^\s*#/.test(rawLine) || /^\s*\/\//.test(rawLine)) {
        continue;
      }

      // Remove string contents so regexes don’t see them
      const line = stripStrings(rawLine);

      // ---- Scalar functions: $Func(...)
      for (const match of line.matchAll(scalarCallRegex())) {
        const name = match[1];
        if (!knownScalarFunctions.has(name)) {
          const start = match.index + 1; // skip $
          issues.push(
            new vscode.Diagnostic(
              new vscode.Range(
                new vscode.Position(lineIndex, start),
                new vscode.Position(lineIndex, start + name.length)
              ),
              `Unknown scalar function '$${name}'`,
              vscode.DiagnosticSeverity.Warning
            )
          );
        }
      }

      // ---- Vector functions: @Func(...)
      for (const match of line.matchAll(vectorCallRegex())) {
        const name = match[1];
        if (!knownVectorFunctions.has(name)) {
          const start = match.index + 1; // skip @
          issues.push(
            new vscode.Diagnostic(
              new vscode.Range(
                new vscode.Position(lineIndex, start),
                new vscode.Position(lineIndex, start + name.length)
              ),
              `Unknown vector function '@${name}'`,
              vscode.DiagnosticSeverity.Warning
            )
          );
        }
      }

      // ---- Operations: Log-Information style
      for (const match of line.matchAll(operationCallRegex())) {
        const name = match[1];

        // Unknown execution statement (Log-* style)
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
          issues.push(
            new vscode.Diagnostic(
              new vscode.Range(
                new vscode.Position(lineIndex, start),
                new vscode.Position(lineIndex, start + name.length)
              ),
              `Unknown operation '${name}'`,
              vscode.DiagnosticSeverity.Warning
            )
          );
        }
      }
      // Invalid logical operator: single & or |
      if (/^\s*if\b/.test(line)) {
        for (let j = 0; j < line.length; j++) {
          const ch = line[j];

          if (ch === "&" || ch === "|") {
            const prev = line[j - 1];
            const next = line[j + 1];

            // valid operators are && and ||
            if (prev === ch || next === ch) {
              continue;
            }

            issues.push(
              new vscode.Diagnostic(
                new vscode.Range(
                  new vscode.Position(lineIndex, j),
                  new vscode.Position(lineIndex, j + 1)
                ),
                `Invalid logical operator '${ch}'. Use '${ch}${ch}'.`,
                vscode.DiagnosticSeverity.Warning
              )
            );
          }
        }
      }
    }
    if (braces !== 0) {
        issues.push(
          new vscode.Diagnostic(
            new vscode.Range(
              document.positionAt(lastPos),
              document.positionAt(lastPos + 1)
            ),
            "Unbalanced braces",
            vscode.DiagnosticSeverity.Error
          )
        );
     }
    diagnostics.set(document.uri, issues);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => updateDiagnostics(e.document)),
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics)
  );

  // Run diagnostics for already-open files
  vscode.workspace.textDocuments.forEach(updateDiagnostics);

  // ============================================================
  // REGISTER
  // ============================================================
  // Register all providers
  context.subscriptions.push(
    signatureHelpProvider,
    functionCompletionProvider,
    variableCompletionProvider,
    vectorCompletionProvider,
    operationCompletionProvider,
    hoverProvider
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
