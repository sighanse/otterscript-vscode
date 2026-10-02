// @ts-check
/**
 * @fileoverview Quick fixes for OtterScript diagnostics: the lightbulb fixes,
 * the per-code "Turn off" action, the Fix All command, and the internal
 * commands behind them.
 */

const vscode = require("vscode");
const { DIAGNOSTIC_CODES } = require("../diagnostics");
const {
  createCardVersionFix,
  createContentTypeFix,
  createInvalidValueFix,
  createTemplatingKeywordFix,
  createToggleTargetFix,
} = require("../adaptivecard");
const {
  createAssignmentInConditionFix,
  createForToForeachFix,
  createInvalidOperatorFix,
  createMissingDollarFix,
  createTemplateEndFix,
  createUnknownNamespaceFix,
  getDiagnosticCode,
  log,
  lookupOwn,
} = require("../helpers");

const REFRESH_DIAGNOSTICS_COMMAND = "otterscript.refreshDiagnostics";
/** Internal command behind the "Turn off '<code>'" quick fix; not in the palette. */
const DISABLE_DIAGNOSTIC_RULE_COMMAND = "otterscript.disableDiagnosticRule";

/**
 * Registers the quick fixes, Fix All and their commands.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {vscode.DiagnosticCollection} diagnostics - This extension's diagnostics
 * @param {(document: vscode.TextDocument) => void} runDiagnostics - Re-checks a
 *   document now (cancelling any pending debounced run)
 * @returns {vscode.Disposable[]}
 */
function registerCodeActions(settings, diagnostics, runDiagnostics) {
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
    "unknown-namespace":       createUnknownNamespaceFix,
    "template-end-keyword":    createTemplateEndFix,
    "adaptivecard-version-too-low": (document, diagnostic) =>
      createCardVersionFix(document, diagnostic, { maxVersion: settings.adaptiveCardMaxVersion }),
    "adaptivecard-invalid-value":   createInvalidValueFix,
    "adaptivecard-templating-keyword": createTemplatingKeywordFix,
    "adaptivecard-content-type":    createContentTypeFix,
    "adaptivecard-unknown-target":  createToggleTargetFix,
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

            const factory = lookupOwn(FIX_FACTORIES, getDiagnosticCode(diagnostic));
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

          // -- One "Turn off '<code>'" action per distinct code under the
          //    cursor, listed after the real fixes. Writes to the workspace
          //    settings when a folder is open, otherwise to user settings.
          const scope = vscode.workspace.workspaceFolders?.length ? "workspace" : "user";
          const offeredCodes = new Set();
          for (const diagnostic of codeActionContext.diagnostics) {
            if (diagnostic.source !== "OtterScript") continue;
            const code = getDiagnosticCode(diagnostic);
            if (!DIAGNOSTIC_CODES.includes(code) || offeredCodes.has(code)) continue;
            offeredCodes.add(code);

            const action = new vscode.CodeAction(
              `Turn off '${code}' diagnostics in ${scope} settings`,
              vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diagnostic];
            action.command = {
              command: DISABLE_DIAGNOSTIC_RULE_COMMAND,
              title: action.title,
              arguments: [code]
            };
            actions.push(action);
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
   * @see FIX_FACTORIES - the diagnostic-code -> fix-factory dispatch table
   */
  const fixAllCommand = vscode.commands.registerCommand(
    'otterscript.fixAll',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "otterscript") return;

      const document = editor.document;
      // -- Re-run the checks first: the published diagnostics lag 400 ms
      // behind typing, and a fix built from a stale range would edit the
      // wrong place.
      runDiagnostics(document);
      const docDiagnostics = diagnostics.get(document.uri) ?? [];
      // -- Filter to fixable diagnostic codes (keys of FIX_FACTORIES)
      const fixableDiagnostics = docDiagnostics.filter(d => Object.hasOwn(FIX_FACTORIES, getDiagnosticCode(d)));

      /** @param {string} msg */
      const report = (msg) => {
        vscode.window.showInformationMessage(msg);
        log.info(msg);
      };
      if (fixableDiagnostics.length === 0) {
        report(`No fixable OtterScript issues found in ${document.fileName}`);
        return;
      }

      // -- Sort from end to start to avoid position shifts
      const sorted = [...fixableDiagnostics].sort((a, b) => b.range.start.compareTo(a.range.start));
      const workspaceEdit = new vscode.WorkspaceEdit();
      // Several diagnostics can share one fix (e.g. every version-too-low in
      // a card raises the same "version" value); applying an identical edit
      // twice would be rejected as overlapping, so each is added once.
      const addedEdits = new Set();
      let fixedCount = 0;

      for (const diagnostic of sorted) {
        const factory = lookupOwn(FIX_FACTORIES, getDiagnosticCode(diagnostic));
        const action = factory?.(document, diagnostic) ?? null;

        // A fix that isn't preferred trades this problem for another (e.g.
        // a card version above the host's maximum), so it's left to the user.
        if (!action?.edit || action.isPreferred === false) continue;

        // -- Copy the action's edits into the combined edit. entries() yields
        // TextEdits; an insert is a TextEdit with an empty range, so replace()
        // reproduces inserts and replacements alike.
        let hasEdits = false;
        for (const [uri, uriEdits] of action.edit.entries()) {
          if (uriEdits.length) hasEdits = true;
          for (const { range, newText } of uriEdits) {
            const key = `${uri.toString()}:${document.offsetAt(range.start)}:${document.offsetAt(range.end)}:${newText}`;
            if (addedEdits.has(key)) continue;
            addedEdits.add(key);
            workspaceEdit.replace(uri, range, newText);
          }
        }
        if (hasEdits) fixedCount++;
      }

      // -- Every fix may have been skipped (none preferred, or no edit);
      // say so rather than doing nothing silently.
      if (fixedCount === 0) {
        report(`No issues in ${document.fileName} can be fixed automatically; see the lightbulb for the remaining fixes`);
        return;
      }
      await vscode.workspace.applyEdit(workspaceEdit);
      runDiagnostics(document);
      report(`Fixed ${fixedCount} issue(s) in ${document.fileName}`);
    }
  );

  /**
   * Sets one diagnostic code to "off" in `otterscript.diagnostics.rules`,
   * keeping the other rules already at that settings level. The
   * settings listener in extension.js then refreshes every open file.
   */
  const disableDiagnosticRuleCommand = vscode.commands.registerCommand(
    DISABLE_DIAGNOSTIC_RULE_COMMAND,
    async (code) => {
      if (typeof code !== "string" || !DIAGNOSTIC_CODES.includes(code)) return;

      const config = vscode.workspace.getConfiguration("otterscript");
      const useWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
      const target = useWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      const inspected = config.inspect("diagnostics.rules");
      const current = (useWorkspace ? inspected?.workspaceValue : inspected?.globalValue) ?? {};

      await config.update("diagnostics.rules", { ...current, [code]: "off" }, target);
      log.info(`Turned off '${code}' diagnostics in ${useWorkspace ? "workspace" : "user"} settings`);
    }
  );

  const refreshDiagnosticsCommand = vscode.commands.registerCommand(
    REFRESH_DIAGNOSTICS_COMMAND,
    async (uri) => {
      if (!uri) return;

      const existing = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
      const document = existing ?? await vscode.workspace.openTextDocument(uri);
      if (document.languageId !== "otterscript") return;

      runDiagnostics(document);
    }
  );

  return [codeActionsProvider, fixAllCommand, disableDiagnosticRuleCommand, refreshDiagnosticsCommand];
}

module.exports = { registerCodeActions };
