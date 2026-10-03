// @ts-check
/**
 * @fileoverview Quick fixes for OtterScript diagnostics: the lightbulb fixes,
 * the per-code "Turn off" action, the Fix All command, and the internal
 * commands behind them.
 */

const vscode = require("vscode");
const { DIAGNOSTIC_CODES, findArgumentProblems, getDiagnosticCode, parseCallArguments } = require("../diagnostics");
const {
  NAMESPACES,
  mapFunctionDocs,
  operationArguments,
  operationDocs,
  operationForms,
  scalarFunctionDocs,
  vectorFunctionDocs,
} = require("../language-data");
const { findOperationArgumentContext, maskComments, maskNonCodeSpans } = require("../scanner");
const { getLineStartScanState, getMaskedTextBefore, MASKED_CONTEXT_MAX_LINES } = require("../document-index");
const {
  createCardVersionFix,
  createContentTypeFix,
  createInvalidValueFix,
  createTemplatingKeywordFix,
  createToggleTargetFix,
} = require("../adaptivecard");
const {
  closestMatch,
  isAvailableIn,
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
 * reducing duplication across multiple fix providers. The action is
 * preferred (so Fix All applies it); a factory whose fix is a guess sets
 * `isPreferred` back to false.
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
 * Preferred -- so Fix All applies it -- only for a casing difference.
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

  const action = createCodeAction(`Change namespace to '${suggestion}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, suggestion);
  });
  action.isPreferred = suggestion.toLowerCase() === token.toLowerCase();
  return action;
}

/**
 * A "Change to '<suggestion>'" fix that replaces the diagnostic's range.
 * Preferred -- so Fix All applies it -- only when just the casing differs;
 * a name that's merely close is a guess for the user to confirm.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic - Its range covers the name to replace
 * @param {string} suggestion
 * @param {string} [label] - How the title shows it (default: `suggestion`)
 * @returns {vscode.CodeAction}
 */
function createRenameFix(document, diagnostic, suggestion, label = suggestion) {
  const action = createCodeAction(`Change to '${label}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, suggestion);
  });
  action.isPreferred = suggestion.toLowerCase() === document.getText(diagnostic.range).toLowerCase();
  return action;
}

/** The docs table for each function sigil. */
const FUNCTION_TABLES = Object.freeze({ "$": scalarFunctionDocs, "@": vectorFunctionDocs, "%": mapFunctionDocs });

/**
 * Replaces an unknown function's name with the closest one of its sigil that
 * the selected product has (`$Substrng` -> `$Substring`).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic - An unknown-*-function diagnostic; its
 *   range covers the name, right after the sigil
 * @param {string} product - The `otterscript.product` setting
 * @returns {vscode.CodeAction | null} Code action, or null when nothing is close
 */
function createUnknownFunctionFix(document, diagnostic, product) {
  const { start } = diagnostic.range;
  if (start.character === 0) return null;
  const sigil = document.getText(new vscode.Range(start.translate(0, -1), start));
  const table = lookupOwn(FUNCTION_TABLES, sigil);
  if (!table) return null;
  const name = document.getText(diagnostic.range);
  const suggestion = closestMatch(name, Object.keys(table).filter((key) => isAvailableIn(table[key], product)));
  return suggestion && suggestion !== name ? createRenameFix(document, diagnostic, suggestion, `${sigil}${suggestion}`) : null;
}

/**
 * Replaces an unknown operation's name with the closest one the selected
 * product has -- behind `Namespace::`, the closest in that namespace
 * (`Copy-Fils` -> `Copy-Files`).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic - An unknown-operation diagnostic; its
 *   range covers the name
 * @param {string} product - The `otterscript.product` setting
 * @returns {vscode.CodeAction | null} Code action, or null when nothing is close
 */
function createUnknownOperationFix(document, diagnostic, product) {
  const name = document.getText(diagnostic.range);
  const before = document.lineAt(diagnostic.range.start.line).text.slice(0, diagnostic.range.start.character);
  const namespace = /([A-Za-z][A-Za-z0-9]*)::$/.exec(before)?.[1]?.toLowerCase();
  const candidates = Object.keys(operationDocs).filter((key) => operationForms(key).some((doc) =>
    isAvailableIn(doc, product) && (!namespace || (doc.namespace ?? "Core").toLowerCase() === namespace)));
  const suggestion = closestMatch(name, candidates);
  return suggestion && suggestion !== name ? createRenameFix(document, diagnostic, suggestion) : null;
}

/**
 * Replaces a misspelt argument name with the documented argument it's
 * closest to (`Copy-Files(Fomr: ...)` -> `From:`).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic - An unknown-argument diagnostic; its
 *   range covers the argument name
 * @returns {vscode.CodeAction | null} Code action, or null when nothing is close
 */
function createUnknownArgumentFix(document, diagnostic) {
  const context = findOperationArgumentContext(getMaskedTextBefore(document, diagnostic.range.start));
  if (!context || context.module) return null;
  const params = operationArguments(context.operation, context.namespace);
  const name = document.getText(diagnostic.range);
  const suggestion = params && closestMatch(name, params.map((p) => p.name));
  return suggestion && suggestion !== name ? createRenameFix(document, diagnostic, suggestion) : null;
}

/**
 * Adds the required arguments an operation call leaves out, each as an
 * empty `Name: ` to fill in: after the last argument, on lines of their own
 * when the call puts its `)` on a line of its own. Not preferred, so Fix
 * All leaves it out: the values are the user's to write.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic - A missing-required-argument
 *   diagnostic; its range covers the operation name
 * @returns {vscode.CodeAction | null} Code action, or null when the call
 *   can't be read (no `)` yet) or no longer misses anything
 */
function createMissingArgumentFix(document, diagnostic) {
  // The call's lines -- from the operation's line, as far as a statement
  // goes -- masked twice: for brackets and argument names (strings and
  // comments blanked), and for where the last argument ends (comments only).
  // Both start from the cached scan state at that line, so a lightbulb
  // request doesn't rescan the whole document. Offsets below are relative to
  // `base`, the start of the operation's line.
  const firstLine = diagnostic.range.start.line;
  const windowEnd = Math.min(document.lineCount - 1, firstLine + MASKED_CONTEXT_MAX_LINES);
  const base = document.offsetAt(new vscode.Position(firstLine, 0));
  const text = document.getText(new vscode.Range(firstLine, 0, windowEnd, document.lineAt(windowEnd).text.length));
  const lines = text.split("\n");
  const codeState = getLineStartScanState(document, firstLine);
  const commentState = { ...codeState };
  /** @type {boolean[]} Per line, whether it ends inside a block comment that goes on */
  const endsInComment = [];
  const masked = lines.map((line) => {
    const lineMasked = maskNonCodeSpans(line, codeState);
    endsInComment.push(codeState.inBlockComment);
    return lineMasked;
  }).join("\n");
  const withStrings = lines.map((line) => maskComments(line, commentState)).join("\n");

  const nameStart = document.offsetAt(diagnostic.range.start) - base;
  const nameEnd = document.offsetAt(diagnostic.range.end) - base;
  const open = /^\s*\(/.exec(masked.slice(nameEnd))?.[0].length;
  if (!open) return null;
  const namespace = /([A-Za-z][A-Za-z0-9]*)::$/.exec(masked.slice(0, nameStart))?.[1] ?? null;
  const call = parseCallArguments(masked, text, nameEnd + open - 1);
  const missing = call && findArgumentProblems(text.slice(nameStart, nameEnd), namespace, call)?.missing;
  if (!call || !missing?.length) return null;

  // Insert after the last argument: when the `)` is on a later line, on new
  // lines indented like it (after any comment ending its line, with the `,`
  // before that comment); else -- or when a block comment opened on that line
  // goes on, which new lines would land in -- on the same line.
  const inside = withStrings.slice(nameEnd + open, call.close).trimEnd();
  const lastEnd = nameEnd + open + inside.length;
  const lastLine = document.positionAt(base + lastEnd).line;
  const comma = inside.endsWith(",");
  const added = missing.map((name) => `${name}: `);
  /** @type {[number, string][]} */
  const inserts = [];
  if (!inside.trim()) {
    inserts.push([lastEnd, added.join(", ")]);
  } else if (text.slice(lastEnd, call.close).includes("\n") && !endsInComment[lastLine - firstLine]) {
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const indent = /^[ \t]*/.exec(document.lineAt(lastLine).text)?.[0] ?? "";
    if (!comma) inserts.push([lastEnd, ","]);
    inserts.push([document.offsetAt(document.lineAt(lastLine).range.end) - base, `${eol}${indent}${added.join(`,${eol}${indent}`)}`]);
  } else {
    inserts.push([lastEnd, `${comma ? " " : ", "}${added.join(", ")}`]);
  }

  const title = `Add missing argument${missing.length === 1 ? "" : "s"} ${missing.map((m) => `'${m}'`).join(", ")}`;
  const action = createCodeAction(title, diagnostic, (edit) => {
    for (const [offset, insertText] of inserts) edit.insert(document.uri, document.positionAt(base + offset), insertText);
  });
  action.isPreferred = false;
  return action;
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
    "unknown-scalar-function": (document, diagnostic) => createUnknownFunctionFix(document, diagnostic, settings.product),
    "unknown-vector-function": (document, diagnostic) => createUnknownFunctionFix(document, diagnostic, settings.product),
    "unknown-map-function":    (document, diagnostic) => createUnknownFunctionFix(document, diagnostic, settings.product),
    "unknown-operation":       (document, diagnostic) => createUnknownOperationFix(document, diagnostic, settings.product),
    "unknown-argument":        createUnknownArgumentFix,
    "missing-required-argument": createMissingArgumentFix,
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
   * Command to fix all auto-fixable diagnostics in the current OtterScript
   * document: every fix that is preferred (see the comment in the loop).
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

        // A fix that isn't preferred is left to the user: it guesses a name
        // that's merely close, needs values only the user knows (missing
        // arguments), or trades this problem for another (a card version
        // above the host's maximum).
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
  createMissingArgumentFix,
  createMissingDollarFix,
  createTemplateEndFix,
  createUnknownArgumentFix,
  createUnknownFunctionFix,
  createUnknownNamespaceFix,
  createUnknownOperationFix,
  nearestNamespace,
  registerCodeActions,
};
