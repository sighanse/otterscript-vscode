// @ts-check
/**
 * @fileoverview Quick fixes for OtterScript diagnostics: the lightbulb fixes,
 * the per-code "Turn off" action, the Fix All command, and the internal
 * commands behind them.
 */

const vscode = require("vscode");
const { DIAGNOSTIC_CODES, getDiagnosticCode } = require("../diagnostics");
const { NAMESPACES } = require("../language-data");
const {
  createCardVersionFix,
  createContentTypeFix,
  createInvalidValueFix,
  createTemplatingKeywordFix,
  createToggleTargetFix,
} = require("../adaptivecard");
const {
  closestMatch,
  log,
  lookupOwn,
} = require("../helpers");

// ============================================================
// CODE ACTION FACTORY
// ============================================================

/**
 * Generic code action factory for creating quick-fix actions.
 *
 * This factory centralizes the creation of VS Code CodeAction objects,
 * reducing duplication across multiple fix providers.
 *
 * @private
 * @param {string} title - Human-readable action title shown in lightbulb menu
 * @param {vscode.Diagnostic} diagnostic - The diagnostic this action fixes
 * @param {(edit: vscode.WorkspaceEdit) => void} applyFix - Callback that applies the fix to a WorkspaceEdit
 * @returns {vscode.CodeAction} Configured code action ready to be returned to VS Code
 *
 * @example
 * // Create a fix that inserts a character
 * createCodeAction("Insert '$'", diagnostic, (edit) => {
 *   edit.insert(uri, position, "$");
 * });
 *
 */
function createCodeAction(title, diagnostic, applyFix) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  const edit = new vscode.WorkspaceEdit();
  applyFix(edit);
  action.edit = edit;
  return action;
}

/**
 * Creates a quick-fix that inserts a missing '$' at the diagnostic position.
 *
 * This code action appears in the lightbulb menu (💡) when a variable
 * is used without a '$' prefix in an if condition.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the missing '$' error
 * @returns {vscode.CodeAction} A code action that inserts '$' at the diagnostic position
 *
 * @example
 * // For diagnostic on "if x > 5"
 * // The action inserts "$" before "x" -> "if $x > 5"
 */
function createMissingDollarFix(document, diagnostic) {
  const uri = document.uri;
  const start = diagnostic.range.start;

  return createCodeAction("Insert missing '$'", diagnostic, (edit) => {
    edit.insert(uri, start, "$");
  });
}

/**
 * Creates a quick-fix that replaces invalid boolean operators.
 *
 * This code action appears in the lightbulb menu (💡) when a single
 * '&' or '|' is used instead of '&&' or '||'.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the invalid operator
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 *
 * @example
 * // For diagnostic on "&" -> creates action to replace with "&&"
 */
function createInvalidOperatorFix(document, diagnostic) {
  const text = document.getText(diagnostic.range);
  const replacement = text === "&" ? "&&" : text === "|" ? "||" : null;

  if (!replacement) return null;

  return createCodeAction(`Replace '${text}' with '${replacement}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, replacement);
  });
}

/**
 * Creates a quick-fix that replaces assignment-like '=' with '==' in conditions.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with assignment-like usage
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 */
function createAssignmentInConditionFix(document, diagnostic) {
  const text = document.getText(diagnostic.range);
  if (text !== "=") return null;

  return createCodeAction("Replace '=' with '=='", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, "==");
  });
}

/**
 * Creates a quick-fix that replaces incorrect 'for' loop usage with 'foreach'.
 * Only for the `for $item in @list` form, which then reads as a valid
 * `foreach`; the counting form (`for $i = 1 to 10`) has no `foreach`
 * equivalent, so it gets no fix.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the incorrect 'for' usage
 * @returns {vscode.CodeAction | null} A code action that replaces 'for' with
 *   'foreach', or null for the counting form
 */
function createForToForeachFix(document, diagnostic) {
  const line = document.lineAt(diagnostic.range.start.line).text;
  if (!/^\s*for\s+[$@%]?[A-Za-z](?:[\w-]*[A-Za-z0-9])?\s+in\s/i.test(line)) return null;

  return createCodeAction("Replace 'for' with 'foreach'", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, 'foreach');
  });
}

/**
 * Creates a quick-fix that replaces a template block terminator keyword
 * (`<% end %>`, `<% endforeach %>`, ...) with `}`, so it becomes `<% } %>`.
 * The diagnostic range covers exactly the keyword token.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The `template-end-keyword` diagnostic
 * @returns {vscode.CodeAction} A code action that replaces the keyword with `}`
 */
function createTemplateEndFix(document, diagnostic) {
  return createCodeAction("Replace with '}'", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, "}");
  });
}

/**
 * The known namespace closest to `token` (canonical casing for a case-only
 * difference), or null when nothing is close enough to suggest.
 *
 * @param {string} token - The unrecognized namespace as written
 * @returns {string | null}
 */
function nearestNamespace(token) {
  return closestMatch(token, NAMESPACES) ?? null;
}

/**
 * Creates a quick-fix that replaces an unknown namespace token with the closest
 * known one (`Frobnicate::Op` -> `Firewall::Op`, `proget::Op` -> `ProGet::Op`).
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The unknown-namespace diagnostic; its
 *   range covers exactly the namespace token (no `::`)
 * @returns {vscode.CodeAction | null} Code action, or null when nothing is close
 */
function createUnknownNamespaceFix(document, diagnostic) {
  const token = document.getText(diagnostic.range);
  const suggestion = nearestNamespace(token);
  if (!suggestion || suggestion === token) return null;

  return createCodeAction(`Change namespace to '${suggestion}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, suggestion);
  });
}

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

module.exports = {
  createAssignmentInConditionFix,
  createForToForeachFix,
  createInvalidOperatorFix,
  createMissingDollarFix,
  createTemplateEndFix,
  createUnknownNamespaceFix,
  nearestNamespace,
  registerCodeActions,
};
