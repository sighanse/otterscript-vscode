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
 * @see src/diagnostics.js - Diagnostic checks and rules
 * @see package.json - Extension manifest and configuration schema
 * @see syntaxes/otterscript.tmLanguage.json - TextMate grammar (syntax highlighting)
 * @see snippets/otterscript.json - Snippets for structural templates only
 * @see {@link https://github.com/sighanse/otterscript-vscode} - GitHub repository
 */

// -- VS Code Extension API
const vscode = require("vscode");
const { updateDiagnostics } = require("./diagnostics");

// -- Path to the language file for OtterScript (functions, variables, operations, keywords)
const languageFile = "./language-data.js";

// -- Import helpers
const {
  NON_VARIABLE_IDENTIFIERS,
  log,
  buildCompletionItem,
  buildHoverMarkdown,
  createAssignmentInConditionFix,
  createForToForeachFix,
  createInvalidOperatorFix,
  createMissingDollarFix,
  getOutputChannel,
  getDiagnosticCode,
  getActiveParameterIndex,
  getModuleDeclarations,
  getModuleCallReferencesByName,
  findModuleDeclarationRange,
  findModuleReferences,
  isModuleCallContext,
  isModuleDeclarationContext,
  isValidCompletionPosition,
  isInStringOrComment,
  loadConfig,
  MODULE_NAME_TOKEN_REGEX,
  validateDocs,
  createRegexPatterns
} = require('./helpers');

/** @type {ReturnType<typeof setTimeout> | undefined} */
let diagnosticTimer;
const REFRESH_DIAGNOSTICS_COMMAND = "otterscript.refreshDiagnostics";

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
  let { completionEnabled, hoverEnabled, signatureHelpEnabled, codeLensEnabled } = loadConfig();
  log.info(`Settings loaded: completion=${completionEnabled}, hover=${hoverEnabled}, signatureHelp=${signatureHelpEnabled}, codeLens=${codeLensEnabled}`);

  // -- Watch for settings changes while extension is running
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      // -- Only reload if OtterScript settings changed
      if (e.affectsConfiguration("otterscript")) {
        ({ completionEnabled, hoverEnabled, signatureHelpEnabled, codeLensEnabled } = loadConfig());
        log.info(`Settings reloaded: completion=${completionEnabled}, hover=${hoverEnabled}, signatureHelp=${signatureHelpEnabled}, codeLens=${codeLensEnabled}`);
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

          const activeParam = getActiveParameterIndex(args);

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
                    : new vscode.SnippetString(doc.name.replace(/^\$/, ""));
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
                buildHoverMarkdown(syntaxDocs.vectorExpr), exprRange);
            }
            if (text === '$(') {
              return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.nestedEval), exprRange);
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
  // FIX DISPATCH TABLE
  // ============================================================
  // Single source of truth for all quick-fix factories.
  // Add a new entry here to expose a fix in both the lightbulb
  // menu (provideCodeActions) and the "Fix All" command.

  /** @type {Record<string, (doc: vscode.TextDocument, diag: vscode.Diagnostic) => vscode.CodeAction | null>} */
  const FIX_FACTORIES = Object.freeze({
    "missing-dollar":          createMissingDollarFix,
    "invalid-operator":        createInvalidOperatorFix,
    "assignment-in-condition": createAssignmentInConditionFix,
    "incorrect-for-usage":     createForToForeachFix,
  });

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

            const factory = FIX_FACTORIES[getDiagnosticCode(diagnostic)];
            const fix = factory?.(document, diagnostic);
            if (fix) {
              fix.command = {
                command: REFRESH_DIAGNOSTICS_COMMAND,
                title: "Refresh OtterScript diagnostics",
                arguments: [document.uri]
              };
              actions.push(fix);
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
      const docDiagnostics = vscode.languages
        .getDiagnostics(document.uri)
        .filter(diagnostic => diagnostic.source === "OtterScript");
      // -- Filter to fixable diagnostic codes (keys of FIX_FACTORIES)
      const fixableDiagnostics = docDiagnostics.filter(d => getDiagnosticCode(d) in FIX_FACTORIES);

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
        const factory = FIX_FACTORIES[getDiagnosticCode(diagnostic)];
        const action = factory?.(document, diagnostic) ?? null;

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
        updateDiagnostics(document, diagnostics, diagnosticsContext);
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

        const wordRange = document.getWordRangeAtPosition(position, MODULE_NAME_TOKEN_REGEX);
        if (!wordRange) return null;

        const calledName = document.getText(wordRange);
        if (!calledName) return null;

        // -- Verify this is actually a 'call' statement
        const lineText = document.lineAt(position.line).text;
        if (!isModuleCallContext(lineText, wordRange.start.character)) {
          return null;  // Not a 'call' statement - ignore
        }

        const declarationRange = findModuleDeclarationRange(document, calledName);
        return declarationRange ? new vscode.Location(document.uri, declarationRange) : null;
      }
    }
  );

  // ============================================================
  // FIND REFERENCES PROVIDER (Modules)
  // ============================================================
  // Enables Shift+F12 and powers CodeLens reference counts for module calls.

  const referenceProvider = vscode.languages.registerReferenceProvider(
    "otterscript",
    {
      /**
       * Resolves references for a module symbol from either declaration or call sites.
       *
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @param {vscode.ReferenceContext} refContext
       * @returns {vscode.Location[]}
       */
      provideReferences(document, position, refContext) {
        const wordRange = document.getWordRangeAtPosition(position, MODULE_NAME_TOKEN_REGEX);
        if (!wordRange) return [];

        const moduleName = document.getText(wordRange);
        if (!moduleName) return [];

        const currentLine = document.lineAt(position.line).text;
        const isModuleDecl = isModuleDeclarationContext(currentLine, wordRange.start.character);
        const isCallSite = isModuleCallContext(currentLine, wordRange.start.character);
        if (!isModuleDecl && !isCallSite) return [];

        return findModuleReferences(document, moduleName, refContext.includeDeclaration);
      }
    }
  );

  // ============================================================
  // DOCUMENT SYMBOL PROVIDER (Outline / Go to Symbol)
  // ============================================================
  // Populates the Outline panel and breadcrumbs with module declarations.
  // Enables Ctrl+Shift+O (Go to Symbol) to jump to any module in the file.

  const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
    "otterscript",
    {
      /**
       * Scans the document for module declarations and returns them as symbols.
       *
       * @param {vscode.TextDocument} document
       * @returns {vscode.DocumentSymbol[]}
       */
      provideDocumentSymbols(document) {
        return getModuleDeclarations(document).map(entry =>
          new vscode.DocumentSymbol(
            entry.name,
            "",
            vscode.SymbolKind.Module,
            entry.lineRange,
            entry.range
          )
        );
      }
    }
  );

  // ============================================================
  // CODE LENS PROVIDER (Module References)
  // ============================================================
  // Shows reference counts above module declarations and links to
  // VS Code's reference peek UI.

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    "otterscript",
    {
      /**
       * Builds code lenses for module declarations.
       *
       * @param {vscode.TextDocument} document
       * @returns {vscode.CodeLens[]}
       */
      provideCodeLenses(document) {
        if (!codeLensEnabled) return [];
        /** @type {vscode.CodeLens[]} */
        const lenses = [];
        const declarations = getModuleDeclarations(document);
        const declarationNames = new Set(declarations.map(declaration => declaration.name));
        const refsByName = getModuleCallReferencesByName(document, declarationNames);

        for (const declaration of declarations) {
          const range = declaration.range;
          const usageRefs = refsByName.get(declaration.name) ?? [];

          lenses.push(
            new vscode.CodeLens(range, {
              title: `${usageRefs.length} reference${usageRefs.length === 1 ? "" : "s"}`,
              command: "editor.action.showReferences",
              arguments: [document.uri, range.start, usageRefs]
            })
          );
        }

        return lenses;
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
  const diagnosticsContext = {
    nonVariableIdentifiers: NON_VARIABLE_IDENTIFIERS,
    knownKeywords,
    knownScalarFunctions,
    knownVectorFunctions,
    knownOperations,
    scalarCallRegex,
    vectorCallRegex,
    operationCallRegex,
  };

  context.subscriptions.push(diagnostics);

  const refreshDiagnosticsCommand = vscode.commands.registerCommand(
    REFRESH_DIAGNOSTICS_COMMAND,
    async (uri) => {
      if (!uri) return;

      const existing = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
      const document = existing ?? await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== "otterscript") return;

      clearTimeout(diagnosticTimer);
      updateDiagnostics(document, diagnostics, diagnosticsContext);
    }
  );

  // ============================================================
  // INITIAL DIAGNOSTICS & SUBSCRIPTION REGISTRATION
  // ============================================================
  // Run initial diagnostics for already-open files
  // This handles files that were open before the extension activated
  // Without this, users would need to retype or reopen files to see errors
  vscode.workspace.textDocuments.forEach(document => updateDiagnostics(document, diagnostics, diagnosticsContext));

  // Register all extension subscriptions in a single batch
  // VS Code automatically disposes these when the extension deactivates
  context.subscriptions.push(

    // -- Output channel used for logging
    getOutputChannel(),

    // -- Re-run diagnostics whenever text changes (every keystroke)

    vscode.workspace.onDidChangeTextDocument(e => {
      clearTimeout(diagnosticTimer);
      diagnosticTimer = setTimeout(() => updateDiagnostics(e.document, diagnostics, diagnosticsContext), 400);
    }),
    // -- Run diagnostics when a new file is opened (handles files opened after activation)
    vscode.workspace.onDidOpenTextDocument(document => updateDiagnostics(document, diagnostics, diagnosticsContext)),

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
    referenceProvider,
    documentSymbolProvider,
    codeLensProvider,
    fixAllCommand,
    refreshDiagnosticsCommand
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
