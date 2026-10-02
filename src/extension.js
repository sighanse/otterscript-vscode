// @ts-check
/**
 * @fileoverview OtterScript Language Extension entry point.
 *
 * RESPONSIBILITIES
 * 1. Register the language features, each in its own module under
 *    src/providers/ (completion, hover, signature help, quick fixes,
 *    navigation, workspace symbols)
 * 2. Schedule diagnostics runs (the checks themselves live in diagnostics.js)
 * 3. Keep settings, diagnostics and the workspace index current as documents
 *    and settings change
 *
 * DESIGN PRINCIPLES
 * - language-data.js and scanner.js are vscode-free (plain data / plain text)
 * - Each provider module receives what it needs from here (the live settings,
 *   regex patterns, a way to re-run diagnostics) instead of reaching for
 *   shared globals; reusable logic that builds vscode objects lives in
 *   helpers.js / diagnostics.js / adaptivecard.js
 * - Snippets own insertion text; providers never guess prefixes
 *
 * DOCUMENTATION
 * @author Sigurd Hansen <sigurd.hansen@gmail.com>
 * @license MIT
 * @see src/providers/ - One module per group of language features
 * @see src/language-data.js - Plain data documentation module
 * @see src/helpers.js - Helpers, functions, constants
 * @see src/scanner.js - vscode-free text scanning (strings, comments, template tags)
 * @see src/diagnostics.js - Diagnostic checks and rules
 * @see src/adaptivecard.js - Adaptive Card checks for template JSON bodies
 * @see package.json - Extension manifest and configuration schema
 * @see syntaxes/otterscript.tmLanguage.json - TextMate grammar (syntax highlighting)
 * @see snippets/otterscript.json - Snippets for structural templates only
 * @see {@link https://github.com/sighanse/otterscript-vscode} - GitHub repository
 */

// -- VS Code Extension API
const vscode = require("vscode");
const { updateDiagnostics } = require("./diagnostics");

// -- Language documentation (functions, variables, operations, keywords).
const {
  NAMESPACES,
  operationDocs,
  syntaxDocs,
  keywordDocs,
  variableDocs,
  scalarFunctionDocs,
  vectorFunctionDocs,
  mapFunctionDocs
} = require("./language-data");

const {
  NON_VARIABLE_IDENTIFIERS,
  log,
  getOutputChannel,
  clearDocumentCaches,
  clearTimerForUri,
  loadConfig,
  validateDocs,
  scheduleTimerForUri,
  createRegexPatterns,
} = require("./helpers");

// -- Language features
const { registerCodeActions } = require("./providers/code-actions");
const { registerCompletion } = require("./providers/completion");
const { registerHover } = require("./providers/hover");
const { registerNavigation } = require("./providers/navigation");
const { registerSignatureHelp } = require("./providers/signature-help");
const { registerWorkspaceSymbols } = require("./providers/workspace-symbols");

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const diagnosticTimers = new Map();

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

  // -- Settings. One object, shared with every provider module and updated
  //    in place by the settings listener below (SETTINGS CHANGES), so a
  //    provider always reads the current value.
  /** @type {import("./helpers").Settings} */
  const settings = loadConfig();
  /** @returns {string} */
  const describeSettings = () =>
    `completion=${settings.completionEnabled}, hover=${settings.hoverEnabled}, ` +
    `signatureHelp=${settings.signatureHelpEnabled}, codeLens=${settings.codeLensEnabled}, ` +
    `workspaceSymbols=${settings.workspaceSymbolsEnabled}`;
  log.info(`Settings loaded: ${describeSettings()}`);

  // -- Validate all documentation sources (intentionally ignore return value)
  for (const [label, table] of Object.entries({
    scalarFunctionDocs,  // $ToJson, $Trim, etc.
    operationDocs,       // Log-Information, Log-Warning, Log-Error, etc.
    vectorFunctionDocs,  // @Split, @Join, etc.
    mapFunctionDocs,     // %FromJson, %ListItem
    variableDocs,        // $BuildId, $FeedName, etc.
    syntaxDocs,          // Template tags, swim strings, expression delimiters, etc.
    keywordDocs,         // if, foreach, with, set, etc.
  })) {
    void validateDocs(label, table);
  }

  // -- Knowledge bases (fast lookup sets) and the regex patterns built from them
  const knownOperations = new Set(Object.keys(operationDocs));
  const patterns = createRegexPatterns(knownOperations);

  // ============================================================
  // DIAGNOSTICS
  // ============================================================
  // The checks live in diagnostics.js (see there for the full list); this
  // only decides when they run: on open and save at once, on edits after a
  // 400 ms pause, and on demand (quick fixes, Fix All, settings changes).

  const diagnostics = vscode.languages.createDiagnosticCollection("otterscript");
  /** @type {import("./diagnostics").DiagnosticsContext} */
  const diagnosticsContext = {
    nonVariableIdentifiers: NON_VARIABLE_IDENTIFIERS,
    knownKeywords: new Set(Object.keys(keywordDocs)),
    knownScalarFunctions: new Set(Object.keys(scalarFunctionDocs)),
    knownVectorFunctions: new Set(Object.keys(vectorFunctionDocs)),
    scalarFunctionDocs,
    vectorFunctionDocs,
    mapFunctionDocs,
    knownOperations,
    knownNamespaces: NAMESPACES,
    operationNamespaces: new Set(Object.values(operationDocs).map((doc) => doc.namespace ?? "Core")),
    scalarCallRegex: patterns.scalarCallRegex,
    vectorCallRegex: patterns.vectorCallRegex,
    operationCallRegex: patterns.operationCallRegex,
    diagnosticRules: settings.diagnosticRules,
    adaptiveCardMaxVersion: settings.adaptiveCardMaxVersion,
  };

  /**
   * Checks a document now, cancelling any pending debounced run for it.
   *
   * @param {vscode.TextDocument} document
   * @returns {void}
   */
  const runDiagnostics = (document) => {
    clearTimerForUri(diagnosticTimers, document.uri);
    updateDiagnostics(document, diagnostics, diagnosticsContext);
  };

  // ============================================================
  // LANGUAGE FEATURES
  // ============================================================

  const workspaceSymbols = registerWorkspaceSymbols(settings);
  context.subscriptions.push(
    diagnostics,
    ...registerCodeActions(settings, diagnostics, runDiagnostics),
    ...registerCompletion(settings, workspaceSymbols.listModules),
    ...registerHover(settings, patterns.operationRegex()),
    ...registerNavigation(settings),
    ...registerSignatureHelp(settings, patterns),
    ...workspaceSymbols.disposables,
  );

  // ============================================================
  // SETTINGS CHANGES
  // ============================================================
  // The one listener for `otterscript.*` settings: reloads them all at once,
  // then does what a particular change needs -- reset the workspace index, or
  // re-run diagnostics in every open file so new rules or a new Adaptive Card
  // version limit apply without an edit.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration("otterscript")) return;
      Object.assign(settings, loadConfig());
      log.info(`Settings reloaded: ${describeSettings()}`);

      if (e.affectsConfiguration("otterscript.workspaceSymbols.enable")) workspaceSymbols.resetWorkspaceIndex();

      if (e.affectsConfiguration("otterscript.diagnostics.rules") ||
          e.affectsConfiguration("otterscript.adaptiveCards.maxVersion")) {
        diagnosticsContext.diagnosticRules = settings.diagnosticRules;
        diagnosticsContext.adaptiveCardMaxVersion = settings.adaptiveCardMaxVersion;
        for (const document of vscode.workspace.textDocuments) runDiagnostics(document);
      }
    })
  );

  // ============================================================
  // DOCUMENT EVENTS
  // ============================================================
  // Run initial diagnostics for files that were open before the extension
  // activated; without this, they'd show nothing until edited or reopened.
  vscode.workspace.textDocuments.forEach(runDiagnostics);

  context.subscriptions.push(
    // -- Output channel used for logging
    getOutputChannel(),

    // -- After a pause in typing, re-run diagnostics and refresh the
    //    document's entry in the workspace module index, so Go to Symbol in
    //    Workspace follows unsaved edits (an added, renamed or removed module)
    //    without waiting for a save.
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId !== "otterscript") return;
      scheduleTimerForUri(diagnosticTimers, e.document.uri, 400, () => {
        updateDiagnostics(e.document, diagnostics, diagnosticsContext);
        workspaceSymbols.setModuleIndexEntry(e.document.uri, e.document.getText());
      });
    }),

    // -- Run diagnostics when a file is opened after activation, and index
    //    its modules for Go to Symbol in Workspace
    vscode.workspace.onDidOpenTextDocument(document => {
      runDiagnostics(document);
      if (document.languageId === "otterscript") {
        workspaceSymbols.setModuleIndexEntry(document.uri, document.getText());
      }
    }),

    // -- Re-run diagnostics (and refresh the module index) on save. The change
    //    handler above is debounced, so this gives an immediate refresh on
    //    explicit/auto save and covers a save that reconciles the buffer with
    //    on-disk changes.
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.languageId === "otterscript") {
        runDiagnostics(document);
        workspaceSymbols.setModuleIndexEntry(document.uri, document.getText());
      }
    }),

    // -- Clean up diagnostics and per-document caches when a file is closed.
    vscode.workspace.onDidCloseTextDocument(doc => {
      // A file stays in the index (it's still on disk), but its entry came
      // from the live buffer, so re-read it from disk: closing without saving
      // must drop unsaved module declarations. An untitled document's entry
      // goes with it.
      if (doc.uri.scheme !== "file") workspaceSymbols.removeModuleIndexEntry(doc.uri);
      else if (doc.languageId === "otterscript") void workspaceSymbols.indexModuleFile(doc.uri);
      diagnostics.delete(doc.uri);
      clearDocumentCaches(doc.uri);
      clearTimerForUri(diagnosticTimers, doc.uri);
    }),
  );
}

// ============================================================
// DEACTIVATION
// ============================================================
/**
 * Called when the extension is disabled or VS Code shuts down: cancels any
 * pending debounced diagnostics runs. Everything registered in
 * `context.subscriptions` is disposed by VS Code itself.
 *
 * @returns {void}
 */
function deactivate() {
  for (const timer of diagnosticTimers.values()) {
    clearTimeout(timer);
  }
  diagnosticTimers.clear();
}

// MODULE EXPORTS
module.exports = {
  activate,  // Called by VS Code when extension activates
  deactivate // Called by VS Code when extension deactivates (graceful cleanup)
};
