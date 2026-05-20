// @ts-check
/**
 * @fileoverview OtterScript Language Extension entry point.
 *
 * RESPONSIBILITIES
 * 1. Register language features (completion, hover, signature help)
 * 2. Bridge plain languageData (language-data.js) into VS Code UI objects
 * 3. Provide lightweight diagnostics (syntax sanity checks)
 *
 * DESIGN PRINCIPLES
 * - language-data.js contains ONLY plain data (no vscode imports)
 * - extension.js is the only place that creates VS Code objects
 * - Snippets own insertion text; providers never guess prefixes
 *
 * DOCUMENTATION
 * @author Sigurd Hansen <sigurd.hansen@gmail.com>
 * @license MIT
 * @see src/language-data.js - Plain data documentation module
 * @see src/helpers.js - Helpers, functions, constants
 * @see package.json - Extension manifest and configuration schema
 * @see syntaxes/otterscript.tmLanguage.json - TextMate grammar (syntax highlighting)
 * @see snippets/otterscript.json - Snippets for structural templates only
 * @see {@link https://github.com/sighanse/otterscript-vscode} - GitHub repository
 */

// -- VS Code Extension API
const vscode = require("vscode");

// -- Path to the language file for OtterScript (functions, variables, operations, keywords)
const languageFile = "./language-data.js";

// -- Import helpers
const {
  NON_VARIABLE_IDENTIFIERS,
  log,
  buildCompletionItem,
  buildHoverMarkdown,
  checkMissingDollar,
  findDuplicateMapKeyDiagnostics,
  createAssignmentInConditionFix,
  createForToForeachFix,
  createInvalidOperatorFix,
  createMissingDollarFix,
  createUnbalancedDiagnostic,
  getOutputChannel,
  getDiagnosticCode,
  isValidCompletionPosition,
  isInStringOrComment,
  loadConfig,
  stripStrings,
  validateDocs,
  createRegexPatterns
} = require('./helpers');

/** @type {ReturnType<typeof setTimeout> | undefined} */
let diagnosticTimer;

// ============================================================
// ACTIVATION
// ============================================================

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const pkg = context.extension.packageJSON;
  const extensionName = pkg.displayName || pkg.name;
  const version = pkg.version;

  log.info(`${extensionName} v${version} activated`);

  // -- Load initial configuration
  let { completionEnabled, hoverEnabled, signatureHelpEnabled } = loadConfig();
  log.info(`Settings loaded: completion=${completionEnabled}, hover=${hoverEnabled}, signatureHelp=${signatureHelpEnabled}`);

  // -- Watch for settings changes while extension is running
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      // -- Only reload if OtterScript settings changed
      if (e.affectsConfiguration("otterscript")) {
        ({ completionEnabled, hoverEnabled, signatureHelpEnabled } = loadConfig());
        log.info(`Settings reloaded: completion=${completionEnabled}, hover=${hoverEnabled}, signatureHelp=${signatureHelpEnabled}`);
      }
    })
  );

  // -- Loads language documentation from language-data.js.
  // Objects contain plain strings only.
  // Any conversion to MarkdownString happens in this file.
  let languageData;
  // -- Attempt to load the documentation module with error handling
  try {
    languageData = require(languageFile);

    // -- Quick validation to ensure languageData loaded correctly
    if (!languageData || typeof languageData !== "object") {
      throw new Error(`${languageFile} did not export an object`);
    }
    log.debug(`${languageFile} loaded successfully`);
  } catch (err) {
    // -- Log errors
    log.error(`Failed to load ${languageFile}`, err);

    // -- Show user-friendly error message
    vscode.window.showErrorMessage(
      `${extensionName} failed to load ${languageFile}. ` +
      "The extension could not be activated. Check the developer console for details."
    );

    // -- Abort activation cleanly - don't register any providers
    // Without languageData, completions/hover/signature help would show nothing
    return;
  }
  // -- Extract each documentation category into its own variable.
  const {
    operationDocs,
    syntaxDocs,
    keywordDocs,
    variableDocs,
    scalarFunctionDocs,
    vectorFunctionDocs
  } = languageData;

  // -- Validate all documentation sources (intentionally ignore return value)
  void validateDocs("scalarFunctionDocs", scalarFunctionDocs); // $ToJson, $Base64Encode, etc.
  void validateDocs("operationDocs", operationDocs);           // Log-Information, Log-Warning, Log-Error, etc.
  void validateDocs("vectorFunctionDocs", vectorFunctionDocs); // @Split, @Join, etc.
  void validateDocs("variableDocs", variableDocs);             // $BuildId, $FeedName, etc.
  void validateDocs("syntaxDocs", syntaxDocs);                 // Template tags, swim strings, expression delimiters, etc.
  void validateDocs("keywordDocs", keywordDocs);               // if, foreach, with, set, etc.

  // -- Knowledge bases (Fast Lookup Sets)
  const knownKeywords = new Set(Object.keys(keywordDocs));
  const knownScalarFunctions = new Set(Object.keys(scalarFunctionDocs));
  const knownVectorFunctions = new Set(Object.keys(vectorFunctionDocs));
  const knownOperations = new Set(Object.keys(operationDocs));

  // -- Regex pattern for symbol detection
  const {
    scalarCallRegex,
    vectorCallRegex,
    operationCallRegex,
    scalarSignatureRegex,
    vectorSignatureRegex,
    operationSignatureRegex,
    operationRegex,
  } = createRegexPatterns(knownOperations);

  const cachedOperationRegex = operationRegex();

  // ============================================================
  // SIGNATURE HELP PROVIDER
  // ============================================================
  // Shows parameter hints for:
  //   - Scalar functions: $ToJson(value)
  //   - Vector functions: @Split(text, delimiter)
  //   - Operations: Post-Http(Url: ..., [options...])

  const signatureHelpProvider =
    vscode.languages.registerSignatureHelpProvider(
      "otterscript",
      {
        provideSignatureHelp(document, position) {
          // -- Check if the signature help provider is enabled in settings
          if (!signatureHelpEnabled) return null;

          // -- Get all text from document start to cursor position
          // This enables multi-line function call detection
          const textBeforeCursor = document.getText(new vscode.Range(
            new vscode.Position(Math.max(0, position.line - 10), 0),  // Last 10 lines max
            position
          ));
          // -- Try each pattern to find the function call
          let match = null;
          let fn = null;
          let args = null;

          const candidates = [
            { regex: scalarSignatureRegex,    table: scalarFunctionDocs }, // ($Func)
            { regex: vectorSignatureRegex,    table: vectorFunctionDocs }, // (@Func)
            { regex: operationSignatureRegex, table: operationDocs },      // (Log-Information etc...)
          ];

          for (const { regex, table } of candidates) {
            const m = textBeforeCursor.match(regex());
            if (m && table[m[1]]) { match = m; fn = table[m[1]]; args = m[2]; break; }
          }

          // -- Validate we have everything needed
          if (!fn?.signature || !match) return null;
          if (typeof args !== 'string') return null;

          // ------------------------------------------------------------
          // Active parameter detection
          // ------------------------------------------------------------

          let activeParam = 0;
          let inString = false;
          let quote = null;
          let parenDepth = 0;   // Track ( ) nesting
          let braceDepth = 0;   // Track [ ] nesting
          let curlyDepth = 0;   // Track { } nesting

          for (let i = 0; i < args.length; i++) {
            const ch = args[i];

            // -- Handle string literals
            // Toggle string state when encountering unescaped quotes
            if ((ch === '"' || ch === "'") && !inString) {
              inString = true;
              quote = ch;
              continue;
            }

            if (inString && ch === quote) {
              // -- Check if quote is escaped (odd number of backslashes before it)
              let backslashCount = 0;
              let j = i - 1;
              while (j >= 0 && args[j] === '\\') {
                backslashCount++;
                j--;
              }
              if (backslashCount % 2 === 0) {
                inString = false;
              }
              continue;
            }

            // -- Skip all processing inside strings
            if (inString) continue;

            // -- Track nesting depth for different bracket types
            if (ch === '(') parenDepth++;
            if (ch === ')') parenDepth--;
            if (ch === '[') braceDepth++;
            if (ch === ']') braceDepth--;
            if (ch === '{') curlyDepth++;
            if (ch === '}') curlyDepth--;

            // -- Count commas as parameter separators
            if (ch === ',' && parenDepth === 0 && braceDepth === 0 && curlyDepth === 0) {
              activeParam++;
            }
          }

          // ------------------------------------------------------------
          // Build signature help UI
          // ------------------------------------------------------------
          // Parse signature to extract individual parameters
          // Handles nested parentheses in signature (e.g., "Func(a, (b + c), d)")

          const sig = new vscode.SignatureInformation(fn.signature, fn.documentation);

          const paramMatch = fn.signature.match(/\(([\s\S]*)\)/);
          if (paramMatch) {
            const paramText = paramMatch[1];
            const params = [];
            let depth = 0;
            let start = 0;

            for (let i = 0; i < paramText.length; i++) {
              const ch = paramText[i];
              if (ch === '(') depth++;
              if (ch === ')') depth--;
              if (ch === ',' && depth === 0) {
                params.push(paramText.substring(start, i).trim());
                start = i + 1;
              }
            }
            params.push(paramText.substring(start).trim());

            sig.parameters = params.map(p => new vscode.ParameterInformation(p));
          }

          // -- Prepare the response
          const help = new vscode.SignatureHelp();
          help.signatures = [sig];
          help.activeSignature = 0;

          // -- Only set activeParameter when parameters were extracted
          if (sig.parameters.length > 0) {
            help.activeParameter = Math.min(activeParam, sig.parameters.length - 1);
          }

          return help;
        }
      },
      "(",  // -- Trigger on opening parenthesis
      ","   // -- Trigger on comma (when moving to next parameter)
    );

  // ============================================================
  // SCALAR FUNCTION COMPLETION PROVIDER ($Function)
  // ============================================================
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
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, completionEnabled)) return [];

          const linePrefix = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          // -- Match: $ followed by optional letters (partial function name)
          const match = linePrefix.match(/\$([a-zA-Z]*)$/);
          if (!match) return [];

          const typed = match[1];

          return Object.entries(scalarFunctionDocs)
              .filter(([key]) => key.toLowerCase().startsWith(typed.toLowerCase()))
              .map(([_key, doc]) => {
                  const snippet = doc.snippet
                    ? new vscode.SnippetString(doc.snippet.replace(/^\\\$/, ""))
                    : new vscode.SnippetString(doc.name.replace(/^\$/, ""));
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Function, '1_', snippet, true);
                  return item;
              });
        }
      },
      "$"   // Trigger on dollar
    );

  // ============================================================
  // VARIABLE COMPLETION PROVIDER ($Variable)
  // ============================================================
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
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, completionEnabled)) return [];

          const text = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          // -- Match: $ followed by optional letters (partial variable name)
          const match = text.match(/\$([A-Za-z]*)$/);
          if (!match) return [];

          const typed = match[1];

          // -- Filter variables by what user typed and create completion items
          return Object.entries(variableDocs)
              .filter(([key]) => key.toLowerCase().startsWith(typed.toLowerCase()))
              .map(([_key, doc]) => {
                  // -- Remove leading $ for insertion (user already typed it)
                  const snippet = doc.snippet
                    ? new vscode.SnippetString(doc.snippet?.replace(/^\$/, ""))
                    : new vscode.SnippetString(doc.name?.replace(/^\$/, ""));
                  return buildCompletionItem(doc, vscode.CompletionItemKind.Variable, '2_', snippet, false);
          });
        }
      },
      "$"   // Trigger character - same as scalar function provider
    );

  // ============================================================
  // VECTOR COMPLETION PROVIDER (@Function / @Variable)
  // ============================================================
  // Triggered after typing '@'.

  const vectorCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, completionEnabled)) return [];

          // -- Get text from line start to cursor
          const linePrefix = document
            .lineAt(position.line)
            .text.substring(0, position.character);

          // -- Match: @ followed by optional letters (partial name)
          const match = linePrefix.match(/@([a-zA-Z]*)$/);
          if (!match) return [];

          const typed = match[1];

          // -- Filter vector languageData by what user typed
          return Object.entries(vectorFunctionDocs)
              .filter(([key]) => key.toLowerCase().startsWith(typed.toLowerCase()))
              .map(([_key, doc]) => {
                  const isFunction = doc.signature?.includes("(");
                  const insertName = doc.name.replace(/^@/, "");
                  // -- Prefer doc.snippet if it exists, otherwise fall back to default pattern
                  const insertText = isFunction
                      ? new vscode.SnippetString(
                          (doc.snippet?.replace(/^@/, "") || `${insertName}(\${0})`))
                      : new vscode.SnippetString(
                          (doc.snippet?.replace(/^@/, "") || `${insertName}\${0}`));
                  const kind = isFunction
                      ? vscode.CompletionItemKind.Function
                      : vscode.CompletionItemKind.Variable;
                  const sortPrefix = isFunction ? '2_' : '1_';
                  return buildCompletionItem(doc, kind, sortPrefix, insertText, true);
              });
        }
      },
      "@"   // Trigger character - provider runs when user types this
    );

  // ============================================================
  // MAP EXPRESSION COMPLETION PROVIDER (%)
  // ============================================================
  // Map variables are user-defined and cannot be enumerated

  const mapCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, completionEnabled)) return [];

          // -- Ensure syntaxDocs and mapExpr exist
          if (!syntaxDocs?.mapExpr) {
            return [];
          }

          const snippet = syntaxDocs.mapExpr.snippet
            ? new vscode.SnippetString(syntaxDocs.mapExpr.snippet)
            : new vscode.SnippetString(`${syntaxDocs.mapExpr.name} "(\${0})"`);
          const kind = vscode.CompletionItemKind.Snippet;
          const sortPrefix = "~";

          return [buildCompletionItem(syntaxDocs.mapExpr, kind, sortPrefix, snippet, false)];
        }
      },
      "%"
    );

  // ============================================================
  // OPERATION COMPLETION PROVIDER
  // ============================================================
  // Provides completions for OtterScript operations and keywords.
  //
  // Unlike scalar ($) and vector (@) completions, operations have NO prefix.

  const operationCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position, _token, localContext) {
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, completionEnabled)) return [];

          const line = document.lineAt(position.line).text;
          const cursor = position.character;
          const prefix = line.slice(0, cursor);

          // -- Match the identifier fragment immediately before cursor (letters + hyphens)
          // Manual invoke (Ctrl+Space) should still return suggestions even when typed is empty.
          const match = prefix.match(/([A-Za-z][A-Za-z-]*)$/);
          const typed = match ? match[1] : "";
          const isManualInvoke = localContext.triggerKind === vscode.CompletionTriggerKind.Invoke;

          // -- For auto-triggered suggestions, require at least 2 typed characters to avoid noise.
          if (!isManualInvoke && typed.length < 2) {
            return [];
          }

          const lowerTyped = typed.toLowerCase();
          const replaceRange = new vscode.Range(
            new vscode.Position(position.line, cursor - typed.length),
            position
          );

          const items = [];

          // -- Operations (priority 0_)
          for (const [name, doc] of Object.entries(operationDocs)) {
              if (!typed || name.toLowerCase().startsWith(lowerTyped)) {
                  const snippet = doc.snippet
                    ? new vscode.SnippetString(doc.snippet)
                    : new vscode.SnippetString(`${name} "\${0}";`);
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Function, '0_', snippet, true);
                  item.range = replaceRange;
                  items.push(item);
              }
          }

          // -- Keywords (priority 1_)
          for (const [name, doc] of Object.entries(keywordDocs)) {
              if (!typed || name.toLowerCase().startsWith(lowerTyped)) {
                  const snippet = doc.snippet
                    ? new vscode.SnippetString(doc.snippet)
                    : name;
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Keyword, '1_', snippet, false);
                  item.range = replaceRange;
                  items.push(item);
              }
          }

          return items;
        }
      }
      // Manual invoke (Ctrl+Space) can return all operations/keywords.
      // Auto-trigger still requires a short typed prefix to reduce noise.
    );

  // ============================================================
  // HOVER PROVIDER
  // ============================================================
  // Shows documentation when user hovers over code elements.
  // Triggered by mouse hover or Ctrl+K Ctrl+I (keyboard).
  //
  // Hover resolution order matter (MOST specific FIRST)

  const hoverProvider = vscode.languages.registerHoverProvider(
    "otterscript",
    {
      provideHover(document, position) {
        // -- Check if hover is enabled in settings
        if (!hoverEnabled) {
          return null;
        }

        const line = document.lineAt(position.line).text;

        // -- Match #region / #endregion at the cursor position
        const regionMatch = line.match(/#(end)?region\b/);
        if (regionMatch) {
          const start = line.indexOf(regionMatch[0]);
          const end = start + regionMatch[0].length;

          const range = new vscode.Range(
            new vscode.Position(position.line, start),
            new vscode.Position(position.line, end)
          );

          const doc = keywordDocs[regionMatch[0]];
          if (doc) {
            return new vscode.Hover(buildHoverMarkdown(doc), range);
          }
        }

        // -- Prevent hover inside strings or comments
        if (isInStringOrComment(line, position.character)) {
          return null;
        }

        // -- Template tags (<% and %>)
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

        // -- Expression Delimiters (%(), @(), $())
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
        // -- Keywords (if, foreach, with, set, etc.)
        // Control flow and language keywords.

        // -- Special-case multi-word keyword: "force normal"
        const forceRange = document.getWordRangeAtPosition(
          position,
          /\bforce\s+normal\b/
        );

        const wordRange = forceRange
          ?? document.getWordRangeAtPosition(
              position,
              /\b[a-zA-Z]+(?:-[a-zA-Z]+)*\b/ // Single token, hyphens allowed; NEVER spaces
            );

        if (wordRange) {
          const word = document.getText(wordRange);

          // -- Check if it's a known keyword
          if (knownKeywords.has(word)) {
            const doc = keywordDocs[word];
            // -- Make hover
            return new vscode.Hover(buildHoverMarkdown(doc), wordRange);
          }
        }

        // -- Swim-string delimiters (Fish Sentinels)
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

        // -- Operations (Log-Information, Log-Warning, Log-Error, etc.)
        // Built-in operations. Distinguished by hyphenated names.
        const operationRange = document.getWordRangeAtPosition(
        position,
        cachedOperationRegex
        );

        if (operationRange) {
          const opName = document.getText(operationRange);
          const doc = operationDocs[opName];

          // -- No documentation found
          if (!doc) return null;

          // -- Make hover
          return new vscode.Hover(buildHoverMarkdown(doc), operationRange);
        }

        // -- Symbols ($function, @vector, $variable)
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

        // -- Look up documentation based on prefix type
        let doc;
        if (prefix === "$") {
          // -- $ can be either a scalar function OR a variable
          // Check functions first (more specific), then variables
          doc = scalarFunctionDocs[name] || variableDocs[name];
        } else if (prefix === "@") {
          // -- @ is a vector function
          doc = vectorFunctionDocs[name];
        }

        // -- No documentation found
        if (!doc) return null;

        // -- Make hover
        return new vscode.Hover(buildHoverMarkdown(doc), symbolRange);
      }
    }
  );

  // ============================================================
  // QUICK FIX CODE ACTION PROVIDER
  // ============================================================
  // Provides lightbulb (💡) quick-fix actions for selected
  // diagnostics emitted by this extension.

  const codeActionsProvider = vscode.languages.registerCodeActionsProvider(
      "otterscript",
      {
        provideCodeActions(document, _range, codeActionContext) {
          /** @type {vscode.CodeAction[]} */
          const actions = [];

          for (const diagnostic of codeActionContext.diagnostics) {
            if (diagnostic.source !== "OtterScript") continue;

            const code = getDiagnosticCode(diagnostic);

            if (code === "missing-dollar") {
              actions.push(createMissingDollarFix(document, diagnostic));
            }

            if (code === "invalid-operator") {
              const fix = createInvalidOperatorFix(document, diagnostic);
              if (fix) actions.push(fix);
            }

            if (code === "assignment-in-condition") {
              const fix = createAssignmentInConditionFix(document, diagnostic);
              if (fix) actions.push(fix);
            }

            if (code === "incorrect-for-usage") {
              const fix = createForToForeachFix(document, diagnostic);
              if (fix) actions.push(fix);
            }
          }

          return actions;
        }
      },
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
      }
  );

  // ============================================================
  // FIX ALL COMMAND
  // ============================================================
  /**
   * Command to fix all auto-fixable diagnostics in the current OtterScript document.
   * All fixes are applied in a single WorkspaceEdit (single undo step).
   *
   * Triggered by: Command Palette or Ctrl+Shift+Alt+F
   *
   * @see createMissingDollarFix
   * @see createInvalidOperatorFix
   * @see createForToForeachFix
   */
  const fixAllCommand = vscode.commands.registerCommand(
    'otterscript.fixAll',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "otterscript") return;

      const document = editor.document;
      const diagnostics = vscode.languages
        .getDiagnostics(document.uri)
        .filter(diagnostic => diagnostic.source === "OtterScript");
      // -- Filter to fixable diagnostic codes
      const fixableCodes = new Set(["missing-dollar", "invalid-operator", "assignment-in-condition", "incorrect-for-usage"]);
      const fixableDiagnostics = diagnostics.filter(d => fixableCodes.has(getDiagnosticCode(d)));

      if (fixableDiagnostics.length === 0) {
        const msg = `No fixable OtterScript issues found in ${document.fileName}`;
        vscode.window.showInformationMessage(msg);
        log.info(msg);
        return;
      }

      // -- Sort from end to start to avoid position shifts
      const sorted = [...fixableDiagnostics].sort((a, b) => b.range.start.compareTo(a.range.start));
      const workspaceEdit = new vscode.WorkspaceEdit();
      let fixedCount = 0;

      for (const diagnostic of sorted) {
        const code = getDiagnosticCode(diagnostic);
        const action = code === "missing-dollar" ? createMissingDollarFix(document, diagnostic)
          : code === "invalid-operator" ? createInvalidOperatorFix(document, diagnostic)
          : code === "assignment-in-condition" ? createAssignmentInConditionFix(document, diagnostic)
          : code === "incorrect-for-usage" ? createForToForeachFix(document, diagnostic)
          : null;

        if (!action?.edit) continue;

        let hasEdits = false;
        for (const [uri, uriEdits] of action.edit.entries()) {
          if (uriEdits.length) hasEdits = true;
          for (const uriEdit of uriEdits) {
            const edit = /** @type {{ range?: vscode.Range, newText?: string, position?: vscode.Position, text?: string }} */ (uriEdit);
            if (edit.range && edit.newText) {
              workspaceEdit.replace(uri, edit.range, edit.newText);
            } else if (edit.position && edit.text) {
              workspaceEdit.insert(uri, edit.position, edit.text);
            }
          }
        }
        if (hasEdits) fixedCount++;
      }

      if (fixedCount) {
        await vscode.workspace.applyEdit(workspaceEdit);
        const msg = `Fixed ${fixedCount} issue(s) in ${document.fileName}`;
        vscode.window.showInformationMessage(msg);
        log.info(msg);
      }
    }
  );

  // ============================================================
  // GO TO DEFINITION PROVIDER (Modules)
  // ============================================================
  // Enables Go-to-Definition (F12 / Ctrl+Click) for calls like:
  // call MyHelper(...) by navigating to the corresponding module MyHelper

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    "otterscript", {
      provideDefinition(document, position) {

        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return null;

        const calledName = document.getText(wordRange);
        if (!calledName) return null;

        // -- Verify this is actually a 'call' statement
        const lineText = document.lineAt(position.line).text;
        const textBeforeWord = lineText.slice(0, wordRange.start.character);

        // -- Check if 'call' appears immediately before the word (with whitespace)
        if (!/\bcall\s+$/i.test(textBeforeWord)) {
          return null;  // Not a 'call' statement - ignore
        }

        // -- Match: module <Name>
        const escaped = calledName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const moduleRegex = new RegExp(`^\\s*module\\s+(${escaped})\\b`);

        for (let line = 0; line < document.lineCount; line++) {
          const text = document.lineAt(line).text;

          const match = moduleRegex.exec(text);
          if (match) {
            // -- Calculate start position from regex match
            const nameStartInMatch = match[0].indexOf(match[1]);
            const start = match.index + nameStartInMatch;

            const range = new vscode.Range(
              new vscode.Position(line, start),
              new vscode.Position(line, start + calledName.length)
            );

            return new vscode.Location(document.uri, range);
          }
        }

        return null;
      }
    }
  );

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

    // -- Parser state variables (track position and context)
    let braces = 0;           // { } balance
    let parens = 0;           // ( ) balance
    let brackets = 0;         // [ ] balance
    let lastBracePos = 0;     // Position of last unmatched brace
    let lastParenPos = 0;     // Position of last unmatched parens
    let lastBracketPos = 0;   // Position of last unmatched bracket
    let inString = false;     // Currently inside a quoted string?
    let inBlockComment = false; // Currently inside a block comment?
    let swimDelimiter = null; // Active swim-string delimiter (e.g., ">==8>")
    let stringChar = '';      // Current quote character (' or ")
    const issues = [];        // Collection of diagnostics to report

    // -- Split into lines for line-by-line processing
    const lines = text.split('\n');

    // -- Process all lines
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const rawLine = lines[lineIndex];

      // ------------------------------------------------------------
      // Missing '$' in if conditions
      // ------------------------------------------------------------
      if (!inBlockComment) {
        const diagnostic = checkMissingDollar(rawLine, lineIndex, NON_VARIABLE_IDENTIFIERS);
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
          if (ch === '*' && rawLine[col + 1] === '/') {
            inBlockComment = false;
            col++;  // Skip the '/'
          }
          continue;  // Skip everything else while in block comment
        }

        // -- Check for opening /*
        if (!inString && swimDelimiter === null &&
            ch === '/' && rawLine[col + 1] === '*') {
          inBlockComment = true;
          col++;  // Skip the '*'
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
            while (pos >= 0 && rawLine[pos] === '\\') {
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
        if (!inString && swimDelimiter === null && ch === '>') {
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
            (ch === '#' || (ch === '/' && rawLine[col + 1] === '/'))) {
          break;  // Skip rest of line
        }

        // -- Count braces for balance checking
        if (!inString && swimDelimiter === null) {

          // -- Braces { }
          if (ch === '{') {
            braces++;
            if (braces === 1) lastBracePos = document.offsetAt(new vscode.Position(lineIndex, col));
          } else if (ch === '}') {
            if (braces === 0) {
              // Unexpected closing - report immediately
              const pos = document.offsetAt(new vscode.Position(lineIndex, col));
              const diag = createUnbalancedDiagnostic(-1, pos, '{', '}', 'brace', document);
              if (diag) issues.push(diag);
            } else {
              braces--;
            }
          }

          // -- Parenthesis ( )
          else if (ch === '(') {
            parens++;
            if (parens === 1) lastParenPos = document.offsetAt(new vscode.Position(lineIndex, col));
          } else if (ch === ')') {
            if (parens === 0) {
              // Unexpected closing - report immediately
              const pos = document.offsetAt(new vscode.Position(lineIndex, col));
              const diag = createUnbalancedDiagnostic(-1, pos, '(', ')', 'parenthesis', document);
              if (diag) issues.push(diag);
            } else {
              parens--;
            }
          }

          // -- Brackets [ ]
          else if (ch === '[') {
            brackets++;
            if (brackets === 1) lastBracketPos = document.offsetAt(new vscode.Position(lineIndex, col));
          } else if (ch === ']') {
            if (brackets === 0) {
              // Unexpected closing - report immediately
              const pos = document.offsetAt(new vscode.Position(lineIndex, col));
              const diag = createUnbalancedDiagnostic(-1, pos, '[', ']', 'bracket', document);
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
              .replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, m => m[0] + ' '.repeat(m.length - 2) + m[0])
              .replace(/(#|\/\/).*$/, m => ' '.repeat(m.length));

            for (let j = 0; j < maskedLine.length; j++) {
              if (maskedLine[j] !== '=') continue;

              const prev = maskedLine[j - 1];
              const next = maskedLine[j + 1];
              const isSingleEquals = prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>'
                && next !== '=' && next !== '>';

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
            const startIndex = line.indexOf('for');
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
      { count: braces, lastPos: lastBracePos, open: '{', close: '}', name: 'brace' },
      { count: parens, lastPos: lastParenPos, open: '(', close: ')', name: 'parenthesis' },
      { count: brackets, lastPos: lastBracketPos, open: '[', close: ']', name: 'bracket' }
    ];

    for (const sym of symbols) {
      if (sym.count > 0) {
        const diag = createUnbalancedDiagnostic(sym.count, sym.lastPos, sym.open, sym.close, sym.name, document);
        if (diag) issues.push(diag);
      }
    }

    // -- Detect duplicate keys inside map expressions: %( key: value, key: value )
    issues.push(...findDuplicateMapKeyDiagnostics(document, text));

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

    // -- Output channel used for logging
    getOutputChannel(),

    // -- Re-run diagnostics whenever text changes (every keystroke)

    vscode.workspace.onDidChangeTextDocument(e => {
      clearTimeout(diagnosticTimer);
      diagnosticTimer = setTimeout(() => updateDiagnostics(e.document), 400);
    }),
    // -- Run diagnostics when a new file is opened (handles files opened after activation)
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),

    // -- Clean up diagnostics when a file is closed to prevent stale error markers
    vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)),

    // -- All providers are registered here for cleanup on deactivation
    signatureHelpProvider,
    functionCompletionProvider,
    variableCompletionProvider,
    vectorCompletionProvider,
    mapCompletionProvider,
    operationCompletionProvider,
    hoverProvider,
    codeActionsProvider,
    definitionProvider,
    fixAllCommand
  );
}

// ============================================================
// DEACTIVATION
// ============================================================
// Called when the extension is disabled or VS Code shuts down.
function deactivate() {
  clearTimeout(diagnosticTimer);
}

// MODULE EXPORTS
module.exports = {
  activate,  // Called by VS Code when extension activates
  deactivate // Called by VS Code when extension deactivates (graceful cleanup)
};
