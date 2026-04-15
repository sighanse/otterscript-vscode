// @ts-check
/**
 * OtterScript Language Extension entry point.
 *
 * RESPONSIBILITIES
 * 1. Register language features (completion, hover, signature help)
 * 2. Bridge plain docs (docs.js) into VS Code UI objects
 * 3. Provide lightweight diagnostics (syntax sanity checks)
 *
 * DESIGN PRINCIPLES
 * - docs.js contains ONLY plain data (no vscode imports)
 * - extension.js is the only place that creates VS Code objects
 * - Snippets own insertion text; providers never guess prefixes
 *
 * DOCUMENTATION
 * @author Sigurd Hansen <sigurd.hansen@gmail.com>
 * @license MIT
 * @see docs.js - Plain data documentation module
 * @see package.json - Extension manifest and configuration schema
 * @see syntaxes/otterscript.tmLanguage.json - TextMate grammar (syntax highlighting)
 * @see snippets/otterscript.json - Snippets for structural templates only
 * @see {@link https://github.com/sighanse/otterscript-vscode} - Github repository
 */

const vscode = require("vscode");

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log("OtterScript extension active");

  // ------------------------------------------------------------
  // Configuration (user‑controlled feature toggles)
  // These flags are read from workspace settings and determine
  // whether individual language features are active at runtime.
  // ------------------------------------------------------------

  // Default values (will be overridden by user settings if present)
  let completionEnabled = true;     // Auto-completion suggestions
  let hoverEnabled = true;          // Documentation on mouse hover
  let signatureHelpEnabled = true;  // Parameter hints for functions

  /**
   * Loads OtterScript configuration from VS Code workspace settings.
   *
   * Settings are stored in .vscode/settings.json or user preferences.
   * Schema defined in package.json under "contributes.configuration".
   *
   * @example
   * // .vscode/settings.json
   * {
   *   "otterscript.completion.enable": false,
   *   "otterscript.hover.enable": true
   * }
   */
  function loadConfig() {
    const config = vscode.workspace.getConfiguration("otterscript");

    // Read each setting with fallback default of 'true'
    completionEnabled = config.get("completion.enable", true);
    hoverEnabled = config.get("hover.enable", true);
    signatureHelpEnabled = config.get("signatureHelp.enable", true);
  }
  // Load settings immediately (extension just activated)
  loadConfig();

  // Watch for settings changes while extension is running
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      // Only reload if OtterScript settings changed
      if (e.affectsConfiguration("otterscript")) {
        loadConfig();
      }
    })
  );

  // DOCUMENTATION DATA LOADING
  // Loads language documentation from docs.js (plain data module).
  // Objects contain plain strings only.
  // Any conversion to MarkdownString happens in this file.
  let docs;
  // Attempt to load the documentation module with error handling
  try {
    docs = require("./docs.js");

    // Quick validation to ensure docs loaded correctly
    if (!docs || typeof docs !== "object") {
      throw new Error("docs.js did not export an object");
    }
  } catch (err) {
    // Log to console for developers (visible in VS Code Developer Tools)
    console.error("Failed to load docs.js", err);

    // Show user-friendly error message
    vscode.window.showErrorMessage(
      "OtterScript Language Extension failed to load documentation data. " +
      "The extension could not be activated. Check the developer console for details."
    );

    // Abort activation cleanly - don't register any providers
    // Without docs, completions/hover/signature help would show nothing
    return;
  }
  // Extract each documentation category into its own variable.
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

  // NON-VARIABLE IDENTIFIERS (Skip $ Validation)
  /**
   * Set of identifier names that are valid without a '$' prefix in conditions.
   * These are language literals, not user-defined variables.
   *
   * @type {Set<string>}
   */
  const nonVariableIdentifiers = new Set([
    "true",   // Boolean literal
    "false",  // Boolean literal
    "null"    // Null literal
  ]);


  /**
   * Returns true if the given position is inside a quoted string
   * or a line comment.
   *
   * This uses a fast, best-effort heuristic and does not attempt
   * full parsing.
   *
   * @param {string} line - The full line of text
   * @param {number} position - Character position within the line (0-indexed)
   * @returns {boolean} true if position is inside string/comment, false otherwise
   */
  function isInStringOrComment(line, position) {
    // Get text from line start up to cursor position
    const prefix = line.slice(0, position);

    // Check if the line starts with a comment marker (# or //)
    if (/^\s*(#|\/\/)/.test(prefix)) {
      return true;
    }

    // Inside quoted string (simple, fast heuristic)
    const doubleQuotes = (prefix.match(/"/g) || []).length;
    const singleQuotes = (prefix.match(/'/g) || []).length;

    // Return true if either quote type has an odd count (unclosed string)
    return doubleQuotes % 2 === 1 || singleQuotes % 2 === 1;
  }

  /**
   * Replaces quoted string literals in a line with empty placeholders.
   *
   * @param {string} line - The line of code to process
   * @returns {string} The line with string contents removed
   */
  function stripStrings(line) {
    return line
      // Double-quoted strings: "anything here" becomes ""
      .replace(/"([^"\\]|\\.)*"/g, '""')
      // Single-quoted strings: 'anything here' becomes ''
      .replace(/'([^'\\]|\\.)*'/g, "''");
  }

  /**
   * Performs best-effort validation of documentation tables.
   *
   * This function intentionally validates unknown input and
   * reports warnings instead of throwing, even if critical
   * fields (name/description) are missing.
   *
   * @param {string} label Human-readable category label (e.g. "keywordDocs")
   * @param {Record<string, unknown>} docs Documentation table to validate
   */
  function validateDocs(label, docs) {
    // Iterate through each documentation entry (e.g., "ToJson", "Split", etc.)
    for (const [key, rawDoc] of Object.entries(docs)) {
      /** @type {any} */
      const doc = rawDoc;

      // Verify the entry is a valid object (not null, not a primitive)
      if (!doc || typeof doc !== "object") {
        console.warn(`[docs] ${label}.${key} is not an object`);
        continue;
      }

      // ---------- Required Field: 'name' ----------
      if (!doc.name || typeof doc.name !== "string" || doc.name.trim() === "") {
        console.warn(`[docs] ${label}.${key} is missing required 'name'`);
      }

      // ---------- Required Field: 'description' ----------
      if (!doc.description || typeof doc.description !== "string") {
        console.warn(`[docs] ${label}.${key} is missing required 'description'`);
      }

      // ---------- Optional Field: 'snippet' ----------
      if (doc.snippet && typeof doc.snippet !== "string") {
        console.warn(`[docs] ${label}.${key} 'snippet' must be a string`);
      }

      // ---------- Optional Field: 'signature' ----------
      if (doc.signature && typeof doc.signature !== "string") {
        console.warn(`[docs] ${label}.${key} 'signature' must be a string`);
      }

      // ---------- Optional Field: 'documentation' ----------
      // Extended documentation shown in hover tooltips
      // Supports Markdown formatting
      if (doc.documentation && typeof doc.documentation !== "string") {
        console.warn(`[docs] ${label}.${key} 'documentation' must be a string`);
      }
    }
  }

  /**
   * Builds a standardised hover MarkdownString from a documentation entry.
   * @param {Readonly<{ name: string, signature?: string, description?: string, documentation?: string }>} doc
   * @returns {vscode.MarkdownString}
   */
  function buildHoverMarkdown(doc) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`### ${doc.name}\n\n`);
    if (doc.signature) {
      md.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
    }
    if (doc.description) {
      md.appendMarkdown(`${doc.description}\n\n`);
    }
    if (typeof doc.documentation === "string") {
      md.appendMarkdown(doc.documentation);
    }
    md.isTrusted = false;  // Default is false. true enables richer formatting, but we don't need that for now.
    return md;
  }

  /**
   * @typedef {Object} DocEntry
   * @property {string} name Human-readable name shown in completion and hover
   * @property {string} description Short summary shown in IntelliSense
   * @property {string=} signature Usage syntax
   * @property {string=} snippet VS Code snippet insertion text
   * @property {string=} documentation Extended Markdown documentation
   */
  /**
   * @param {DocEntry} doc
   * @param {vscode.CompletionItemKind} kind
   * @param {string} sortPrefix  e.g. "1_", "2_"
   * @param {string | vscode.SnippetString} insertText
   * @returns {vscode.CompletionItem}
   */
  function buildCompletionItem(doc, kind, sortPrefix, insertText) {
    const item = new vscode.CompletionItem(
      { label: doc.name, description: doc.description },
      kind
    );
    item.insertText = insertText;
    item.detail = doc.signature ?? doc.description;
    item.documentation = doc.documentation
      ? new vscode.MarkdownString(doc.documentation)
      : undefined;
    item.sortText = `${sortPrefix}${doc.name}`;
    return item;
  }

  /**
   * Checks if the cursor is in a valid position for showing completions.
   * Completions are disabled when:
   * - The user has disabled them via settings
   * - The cursor is inside a string literal
   * - The cursor is inside a comment
   *
   * @param {vscode.TextDocument} document - The current text document
   * @param {vscode.Position} position - The current cursor position
   * @returns {boolean} - True if completions should be shown, false otherwise
   */
  function isValidCompletionPosition(document, position) {
    if (!completionEnabled) return false;
    const line = document.lineAt(position.line).text;
    const cursor = position.character;
    return !isInStringOrComment(line, cursor);
  }

  // RUN VALIDATION ON ALL DOCUMENTATION SOURCES
  validateDocs("scalarFunctionDocs", scalarFunctionDocs); // $ToJson, $Base64Encode, etc.
  validateDocs("operationDocs", operationDocs);           // Log-Information, Log-Warning, Log-Error, etc.
  validateDocs("vectorFunctionDocs", vectorFunctionDocs); // @Split, @Join, etc.
  validateDocs("variableDocs", variableDocs);             // $BuildId, $FeedName, etc.
  validateDocs("syntaxDocs", syntaxDocs);                 // Template tags, swim strings, expression delimiters, etc.
  validateDocs("keywordDocs", keywordDocs);               // if, foreach, with, set, etc.

  // KNOWLEDGE BASES (Fast Lookup Sets)
  const knownKeywords = new Set(Object.keys(keywordDocs));
  const knownScalarFunctions = new Set(Object.keys(scalarFunctionDocs));
  const knownVectorFunctions = new Set(Object.keys(vectorFunctionDocs));
  const knownOperations = new Set(Object.keys(operationDocs));

  // REGEX PATTERNS FOR SYMBOL DETECTION
  const operationRegex = () => buildWordRegex(knownOperations);
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
          // Look up function documentation based on prefix type
          const fn =
            prefix === "$"
              ? scalarFunctionDocs[name]
              : vectorFunctionDocs[name];

          // No matching function found at the cursor position
          if (!fn) return null;
          // Signature help only makes sense when a concrete signature exists
          if (!fn.signature) return null;

          // Count which parameter the cursor is inside by scanning arguments
          // Example: For "$Func(one, |two, three)" -> activeParam = 1 (zero-based)
          let activeParam = 0;
          let inString = false;   // Track if we're inside quotes
          let quote = null;       // Track which quote type we're in (' or ")

          for (const ch of args) {
            // Toggle string state - ignore commas inside quotes
            if ((ch === '"' || ch === "'") && !inString) {
              inString = true;
              quote = ch;
            } else if (ch === quote) {
              inString = false;
            } else if (!inString && ch === ",") {
              activeParam++;
            }
          }

          // Build the signature help UI object
          const sig = new vscode.SignatureInformation(
            fn.signature,
            fn.documentation
          );

          // Parse signature to extract individual parameters
          const paramList = fn.signature.match(/\(([^)]+)\)/);
          if (paramList) {
            sig.parameters = paramList[1]
              .split(",")
              .map(p => new vscode.ParameterInformation(p.trim()));
          }

          // Prepare the response
          const help = new vscode.SignatureHelp();
          help.signatures = [sig];
          help.activeSignature = 0;
          // Only set activeParameter when parameters were extracted.
          if (sig.parameters.length > 0) {
            help.activeParameter = Math.min(
              activeParam,
              sig.parameters.length - 1
            );
          }
          return help;
        }
      },
      "(",  // Trigger on opening parenthesis
      ","   // Trigger on comma (when moving to next parameter)
    );

  // ------------------------------------------------------------
  // SCALAR FUNCTION COMPLETION PROVIDER ($Function)
  // ------------------------------------------------------------
  // Shows completions for scalar functions when user types '$'.
  // Examples: $ToJson, $Base64Encode, $Trim
  //
  // Trigger character: '$'
  // After selection: Inserts function name and optionally parentheses
  // Then triggers signature help for parameter hints

  const functionCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position)) return [];

          const linePrefix = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          // Match: $ followed by optional letters (partial function name)
          const match = linePrefix.match(/\$([a-zA-Z]*)$/);
          if (!match) return [];

          const typed = match[1];

          return Object.entries(scalarFunctionDocs)
              .filter(([name]) => name.toLowerCase().startsWith(typed.toLowerCase()))
              .map(([name, doc]) => {
                  const snippet = doc.snippet
                    ? new vscode.SnippetString(doc.snippet.replace(/^\\\$/, ""))
                    : new vscode.SnippetString(`${name}(\${0})`);
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Function, '1_', snippet);
                  item.command = { command: 'editor.action.triggerParameterHints', title: '' };
                  return item;
              });
        }
      },
      "$"   // Trigger character - provider runs when user types this
    );

  // ------------------------------------------------------------
  // VARIABLE COMPLETION PROVIDER ($Variable)
  // ------------------------------------------------------------
  // Shows completions for predefined OtterScript variables when user types '$'.
  // Examples: $BuildId, $FeedName, $PackageVersion
  //
  // Note: This provider shares the same trigger character ($) as scalar functions.
  // VS Code shows both types in the completion list automatically.

  const variableCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position)) return [];

          const text = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          // Match: $ followed by optional letters (partial variable name)
          const match = text.match(/\$([A-Za-z]*)$/);
          if (!match) return [];

          const typed = match[1];

          // Filter variables by what user typed and create completion items
          return Object.entries(variableDocs)
              .filter(([name]) => name.toLowerCase().startsWith(typed.toLowerCase()))
              .map(([name, doc]) => {
                  // Remove leading $ for insertion (user already typed it)
                  const snippet = doc.snippet
                    ? new vscode.SnippetString(doc.snippet.replace(/^\\\$/, ""))
                    : name.startsWith("$") ? name.slice(1) : name;
                  return buildCompletionItem(doc, vscode.CompletionItemKind.Variable, '2_', snippet);
          });
        }
      },
      "$"   // Trigger character - same as scalar function provider
    );

  // ------------------------------------------------------------
  // VECTOR COMPLETION PROVIDER (@Function / @Variable)
  // ------------------------------------------------------------
  // Triggered after typing '@'.

  const vectorCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position)) return [];

          // Get text from line start to cursor
          const linePrefix = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          // Match: @ followed by optional letters (partial name)
          const match = linePrefix.match(/@([a-zA-Z]*)$/);
          if (!match) return [];

          const typed = match[1];

          // Filter vector docs by what user typed
          return Object.entries(vectorFunctionDocs)
              .filter(([name]) => name.toLowerCase().startsWith(typed.toLowerCase()))
              .map(([name, doc]) => {
                  const isFunction = doc.signature?.includes("(");
                  const insertName = name.replace(/^\s*@/, "");
                  // Prefer doc.snippet if it exists, otherwise fall back to default pattern
                  const insertText = isFunction
                      ? new vscode.SnippetString(
                          (doc.snippet?.replace(/^\s*@/, "") || `${insertName}(\${0})`)
                        )
                      : insertName;
                  const kind = isFunction
                      ? vscode.CompletionItemKind.Function
                      : vscode.CompletionItemKind.Variable;
                  const sortPrefix = isFunction ? '2_' : '1_';
                  return buildCompletionItem(doc, kind, sortPrefix, insertText);
              });
        }
      },
      "@"   // Trigger character - provider runs when user types this
    );

  // ------------------------------------------------------------
  // OPERATION COMPLETION (Log-Information, etc.)
  // ------------------------------------------------------------
  // Provides completions for OtterScript operations and keywords.
  //
  // Unlike scalar ($) and vector (@) completions, operations have NO prefix.

  const operationCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position)) return [];

          const line = document.lineAt(position.line).text;
          const cursor = position.character;
          const prefix = line.slice(0, cursor);

          // Match: word at cursor position (letters + hyphens allowed)
          const match = prefix.match(/\b([A-Za-z]+(?:-[A-Za-z]+)*)$/);
          if (!match) return [];

          const typed = match[1];

          // Require at least 3 characters to avoid noise
          if (typed.length < 3) {
            return [];
          }

          const items = [];

          // Operations (priority 0_)
          for (const [name, doc] of Object.entries(operationDocs)) {
              if (name.toLowerCase().startsWith(typed.toLowerCase())) {
                  const snippet = doc.snippet
                      ? new vscode.SnippetString(doc.snippet)
                      : new vscode.SnippetString(`${name} "\${0}";`);
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Function, '0_', snippet);
                  items.push(item);
              }
          }

          // Keywords (priority 1_)
          for (const [name, doc] of Object.entries(keywordDocs)) {
              if (name.toLowerCase().startsWith(typed.toLowerCase())) {
                  const snippet = doc.snippet
                      ? new vscode.SnippetString(doc.snippet)
                      : name;
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Keyword, '1_', snippet);
                  items.push(item);
              }
          }
          return items;
      }
  }
      // Note: No trigger character specified - this provider runs on every keystroke
      // The 3-character minimum prevents excessive triggering
    );

  // ============================================================
  // HOVER PROVIDER
  // ============================================================
  // Shows documentation when user hovers over code elements.
  // Triggered by mouse hover or Ctrl+K Ctrl+I (keyboard).
  //
  // Hover resolution order (MOST specific FIRST):
  //   1. Template tags (<% %>) - Easiest to identify, check first
  //   2. Expression delimiters (%(), @(), $()) - Specific syntax markers
  //   3. Keywords (if, foreach, with, set, etc.) - Control flow
  //   4. Swim-string delimiters (>>, >==8>, >--=>) - Fish sentinels
  //   5. Operations (Log-Information, Log-Error, etc.) - Built-in actions
  //   6. Symbols ($function, @vector, $variable) - Most general, check last

  const hoverProvider = vscode.languages.registerHoverProvider("otterscript", {
    provideHover(document, position) {
      // Check if hover is enabled in settings
      if (!hoverEnabled) {
        return null;
      }

      // Prevent hover inside strings or comments
      const line = document.lineAt(position.line).text;
      if (isInStringOrComment(line, position.character)) {
        return null;
      }

      // 1. TEMPLATE TAGS (<% and %>)
      // OtterScript uses ASP-style template tags for embedding code

      const templateRange = document.getWordRangeAtPosition(position, /<%|%>/);
      if (templateRange) {
        const text = document.getText(templateRange);
        if (text === '<%') {
          return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.templateOpen), templateRange);
        }
        if (text === '%>') {
          return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.templateClose), templateRange);
        }
      }

      // 2. EXPRESSION DELIMITERS (%(), @(), $())
      // These delimiters start special expression types:
      //   %( ) - Map expression (key-value pairs)
      //   @( ) - Vector expression (arrays/lists)
      //   $( ) - Nested evaluation (evaluate inner expression first)

      const exprRange = document.getWordRangeAtPosition(position, /%\(|@\(|\$\(/);
      if (exprRange) {
          const text = document.getText(exprRange);
          if (text === '%(') {
              return new vscode.Hover(
                  buildHoverMarkdown(syntaxDocs.mapExpr), exprRange);
          }
          if (text === '@(') {
              return new vscode.Hover(
                  buildHoverMarkdown(syntaxDocs.vectorExpr),exprRange);
          }
          if (text === '$(') {
              return new vscode.Hover(
                  buildHoverMarkdown(syntaxDocs.nestedEval),exprRange);
          }
      }
      // 3. KEYWORDS (if, foreach, with, set, etc.)
      // Control flow and language keywords.

      // Special-case multi-word keyword: "force normal"
      const forceRange = document.getWordRangeAtPosition(
        position,
        /\bforce\s+normal\b/
      );

      const wordRange = forceRange
        ?? document.getWordRangeAtPosition(
            position,
            /\b[a-zA-Z]+(?:-[a-zA-Z]+)*\b/ // single token, hyphens allowed; NEVER spaces
          );

      if (wordRange) {
        const word = document.getText(wordRange);

        // Check if it's a known keyword
        if (knownKeywords.has(word)) {
          const doc = keywordDocs[word];
          // Make hover
          return new vscode.Hover(buildHoverMarkdown(doc), wordRange);
        }
      }

      // 4. SWIM-STRING DELIMITERS (Fish Sentinels)
      // OtterScript's unique string syntax: >>, >==8>, >--=>
      // Any characters between two identical fish-shaped delimiters

      const swimRange = document.getWordRangeAtPosition(
        position,
        />[^>]{0,5}>/
      );

      if (swimRange) {
        return new vscode.Hover(
          buildHoverMarkdown(syntaxDocs.swimString), swimRange);
      }

      // 5. OPERATIONS (Log-Information, Log-Warning, Log-Error, etc.)
      // Built-in operations. Distinguished by hyphenated names.
      const operationRange = document.getWordRangeAtPosition(
      position,
      operationRegex()
      );

      if (operationRange) {
        const opName = document.getText(operationRange);
        const doc = operationDocs[opName];

        // No documentation found
        if (!doc) return null;

        // Make hover
        return new vscode.Hover(buildHoverMarkdown(doc), operationRange);
      }

      // 6. SYMBOLS ($function, @vector, $variable)
      // Most general case - matches any $ or @ prefixed identifier
      // Checks scalar functions, vector functions, and variables
      // Must be LAST because it matches many things
      const symbolRange = document.getWordRangeAtPosition(
        position,
        /[@$][A-Za-z][A-Za-z0-9]*/  // $Name or @Name (no spaces)
      );
      if (!symbolRange) return null;

      const text = document.getText(symbolRange);
      const prefix = text[0];         // '$' or '@'
      const name = text.substring(1); // The identifier without prefix

      // Look up documentation based on prefix type
      let doc;
      if (prefix === "$") {
        // $ can be either a scalar function OR a variable
        // Check functions first (more specific), then variables
        doc = scalarFunctionDocs[name] || variableDocs[name];
      } else if (prefix === "@") {
        // @ is a vector function
        doc = vectorFunctionDocs[name];
      }

      // No documentation found
      if (!doc) return null;

      // Make hover
      return new vscode.Hover(buildHoverMarkdown(doc), symbolRange);
    }
  });

  // ============================================================
  // DIAGNOSTICS (ERRORS & WARNINGS)
  // ============================================================
  // Provides real-time syntax checking and problem detection.
  // Shows squiggly underlines in the editor for issues like:
  //   - Missing $ before variables in if conditions
  //   - Unknown functions/operations/variables
  //   - Invalid logical operators (& instead of &&)
  //   - Unbalanced braces

  const diagnostics = vscode.languages.createDiagnosticCollection("otterscript");

  context.subscriptions.push(diagnostics);

  /**
   * Updates diagnostics for an OtterScript document.
   * Performs a full scan of the document and reports all issues.
   * Called on document open and on every text change.
   *
   * @param {import('vscode').TextDocument} document - The document to analyze
   */
  function updateDiagnostics(document) {
    if (document.languageId !== "otterscript") return;

    const text = document.getText();

    // Parser state variables (track position and context)
    let braces = 0;           // Current brace depth (0 = balanced)
    let lastPos = 0;          // Position of last unmatched brace (for error reporting)
    let inString = false;     // Currently inside a quoted string?
    let swimDelimiter = null; // Active swim-string delimiter (e.g., ">==8>")
    let stringChar = '';      // Current quote character (' or ")
    const issues = [];        // Collection of diagnostics to report

    // Split into lines for line-by-line processing
    const lines = text.split('\n');

    // ------------------------------------------------------------
    // PASS 1: MISSING '$' IN IF CONDITIONS
    // ------------------------------------------------------------
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: if variableName followed by comparison operator (=, ==, !=, <, >, <=, >=)
      const missingDollarMatch = line.match(/^\s*if\s+([a-zA-Z][a-zA-Z0-9_]*)\s*(=|==|!=|<=|>=|<|>)/);
      if (missingDollarMatch) {
        const varName = missingDollarMatch[1];
        const startIndex = line.indexOf(varName);

        // Skip known literals that don't need '$'
        if (nonVariableIdentifiers.has(varName)) {
          continue;
        }

        // Report error with squiggly underline under the variable name
        issues.push(
          new vscode.Diagnostic(
            new vscode.Range(
              new vscode.Position(i, startIndex),                 // Start of variable
              new vscode.Position(i, startIndex + varName.length) // End of variable
            ),
            `Missing '$' before variable: ${varName}. Use $${varName}`,
            vscode.DiagnosticSeverity.Error   // Red squiggly (must fix)
          )
        );
      }
    }

    // ------------------------------------------------------------
    // PASS 2: FULL LINE-BY-LINE PARSING
    // ------------------------------------------------------------

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const rawLine = lines[lineIndex];

      // CHARACTER-BY-CHARACTER STATE TRACKING
      // Maintains parser state across characters and lines
      for (let col = 0; col < rawLine.length; col++) {
        const ch = rawLine[col];

        // --- Handle regular strings (single/double quoted) ---
        if (swimDelimiter === null && (ch === '"' || ch === "'")) {
          if (!inString) {
            inString = true;
            stringChar = ch;
          } else if (ch === stringChar) {
            // Check if this quote is escaped
            let backslashCount = 0;
            let pos = col - 1;
            while (pos >= 0 && rawLine[pos] === '\\') {
              backslashCount++;
              pos--;
            }
            // If odd number of backslashes, quote is escaped (don't exit string)
            if (backslashCount % 2 === 0) {
              inString = false;
            }
          }
          continue;
        }

        // --- Handle swim-strings (fish sentinels) ---
        // Enter swim-string when finding '>' followed by 0-5 non-'>' chars and another '>'
        // Example: ">>", ">==8>", ">--=>"
        if (!inString && swimDelimiter === null && ch === '>') {
          const m = rawLine.slice(col).match(/^>[^>]{0,5}>/);
          if (m) {
            swimDelimiter = m[0];
            col += swimDelimiter.length - 1;  // Skip ahead past delimiter
            continue;
          }
        }

        // Exit swim-string when finding the matching delimiter
        if (swimDelimiter) {
          if (rawLine.startsWith(swimDelimiter, col)) {
            col += swimDelimiter.length - 1;
            swimDelimiter = null;
          }
          continue;
        }

        // --- Skip line comments (# or //) ---
        // Once a comment starts, ignore the rest of the line
        if (!inString && swimDelimiter === null &&
            (ch === '#' || (ch === '/' && rawLine[col + 1] === '/'))) {
          break;
        }

        // --- Skip block comments (/* ... */) ---
        // Track across line boundaries (simple implementation)
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

        // --- Count braces for balance checking ---
        // Tracks { and } to detect unmatched braces
        if (!inString && swimDelimiter === null) {
          if (ch === '{') {
            braces++;
            lastPos = document.offsetAt(
              new vscode.Position(lineIndex, col)
            );
          }
          if (ch === '}') {
            braces--;
            if (braces < 0) {
              lastPos = document.offsetAt(new vscode.Position(lineIndex, col));
            }
          }
        }
      }

      // SKIP COMMENT-ONLY LINES
      if (/^\s*#/.test(rawLine) || /^\s*\/\//.test(rawLine)) {
        continue;
      }

      // STRIP STRINGS FOR SYMBOL DETECTION
      // Remove string contents to avoid false positives inside strings
      // Example: In $var = "Unknown $Function" - don't flag $Function
      const line = stripStrings(rawLine);

      // --- Detect unknown scalar functions $Func(...) ---
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

      // --- Detect unknown vector functions @Func(...) ---
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

      // --- Detect unknown operations (Log-Information, etc.) ---
      // Only flags hyphenated names that aren't known operations/keywords
      for (const match of line.matchAll(operationCallRegex())) {
        const name = match[1];

        // Filter: hyphenated names only, not $/@ prefixed, not known
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
      // --- Detect invalid logical operators ---
      // Catches '&' or '|' when '&&' or '||' was intended
      // Only checks inside if statements to reduce false positives
      if (/^\s*if\b/.test(line)) {
        for (let j = 0; j < line.length; j++) {
          const ch = line[j];

          if (ch === "&" || ch === "|") {
            const prev = line[j - 1];
            const next = line[j + 1];

            // Valid operators are '&&' and '||' (double characters)
            // Single '&' or '|' is likely a typo
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

    // ============================================================
    // FINAL CHECK: UNBALANCED BRACES
    // ============================================================
    // After scanning the entire file, report if braces don't match
    if (braces !== 0) {
        issues.push(
          new vscode.Diagnostic(
            new vscode.Range(
              document.positionAt(lastPos),
              document.positionAt(lastPos + 1)
            ),
            braces > 0 ? "Unclosed brace(s)" : "Unexpected closing brace",
            vscode.DiagnosticSeverity.Error   // Red squiggly - must fix
          )
        );
    }
    // Update VS Code's diagnostic panel with all found issues
    diagnostics.set(document.uri, issues);
  }

  // ============================================================
  // INITIAL DIAGNOSTICS & SUBSCRIPTION REGISTRATION
  // ============================================================

  // Run initial diagnostics for already-open files
  // This handles files that were open before the extension activated
  // Without this, users would need to retype or reopen files to see errors
  vscode.workspace.textDocuments.forEach(updateDiagnostics);

  // Register all extension subscriptions in a single batch
  // VS Code automatically disposes these when the extension deactivates
  context.subscriptions.push(
    // ---------- Diagnostics Subscriptions ----------
    // Re-run diagnostics whenever text changes (every keystroke)
    vscode.workspace.onDidChangeTextDocument(e => updateDiagnostics(e.document)),

    // Run diagnostics when a new file is opened (handles files opened after activation)
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),

    // Clean up diagnostics when a file is closed to prevent stale error markers
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)),

    // ---------- Language Feature Providers ----------
    // All providers are registered here for cleanup on deactivation
    signatureHelpProvider,
    functionCompletionProvider,
    variableCompletionProvider,
    vectorCompletionProvider,
    operationCompletionProvider,
    hoverProvider
  );
}

// ============================================================
// DEACTIVATION
// ============================================================
// Called when the extension is disabled or VS Code shuts down.
function deactivate() {}

// MODULE EXPORTS
module.exports = {
  activate,  // Called by VS Code when extension activates
  deactivate // Called by VS Code when extension deactivates (graceful cleanup)
};
