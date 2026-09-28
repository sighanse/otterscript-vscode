// @ts-check
/**
 * @fileoverview Shared helpers for the integration tests, which run inside a
 * real VS Code via `vscode-test` (see .vscode-test.mjs).
 *
 * Tests drive the extension the way VS Code itself does: they open documents
 * and call the built-in `vscode.execute*Provider` commands, then check what
 * the extension's providers returned.
 */

const path = require("node:path");
const vscode = require("vscode");

/** `publisher.name` from package.json. */
const EXTENSION_ID = "sighanse.otterscript-vscode";

/** The fixture folder opened as the test workspace. */
const WORKSPACE_DIR = path.resolve(__dirname, "workspace");

/** test/, where the manual-review `.otter` sample files live. */
const SAMPLES_DIR = path.resolve(__dirname, "..");

/**
 * Opens a file and shows it in an editor. Opening an OtterScript file is what
 * activates the extension, so this also waits for activation.
 *
 * @param {string} filePath - Absolute path
 * @returns {Promise<vscode.TextDocument>}
 */
async function openFile(filePath) {
  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document);
  await activateExtension();
  return document;
}

/**
 * Opens an untitled OtterScript document with the given content and shows it.
 *
 * @param {string} content
 * @returns {Promise<vscode.TextDocument>}
 */
async function openContent(content) {
  const document = await vscode.workspace.openTextDocument({ language: "otterscript", content });
  await vscode.window.showTextDocument(document);
  await activateExtension();
  return document;
}

/**
 * Activates the extension (a no-op once active) and returns it.
 *
 * @returns {Promise<vscode.Extension<unknown>>}
 */
async function activateExtension() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error(`Extension ${EXTENSION_ID} is not loaded`);
  await extension.activate();
  return extension;
}

/**
 * The position of `needle` in the document, plus `offset` characters into it.
 * Throws when the needle is missing, so a stale fixture fails loudly.
 *
 * @param {vscode.TextDocument} document
 * @param {string} needle
 * @param {number} [offset]
 * @returns {vscode.Position}
 */
function positionOf(document, needle, offset = 0) {
  const index = document.getText().indexOf(needle);
  if (index === -1) throw new Error(`'${needle}' not found in ${document.uri.toString()}`);
  return document.positionAt(index + offset);
}

/**
 * Polls `check` until it returns a truthy value, then returns that value.
 * Used for results that arrive asynchronously, such as debounced diagnostics.
 *
 * @template T
 * @param {() => T | false | undefined | Thenable<T | false | undefined>} check
 * @param {string} description - Shown in the error if it times out
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The OtterScript diagnostics currently published for a document.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function otterDiagnostics(document) {
  return vscode.languages.getDiagnostics(document.uri).filter((d) => d.source === "OtterScript");
}

/**
 * The diagnostic's code as a string (VS Code may wrap it in `{ value }`).
 *
 * @param {vscode.Diagnostic} diagnostic
 * @returns {string}
 */
function codeOf(diagnostic) {
  const { code } = diagnostic;
  return typeof code === "object" && code !== null ? String(code.value) : String(code ?? "");
}

/**
 * Closes every editor, discarding unsaved changes, so each test starts from a
 * clean window and no sample file on disk is ever modified. (A plain "close
 * all" would stop at a "Save changes?" prompt for an edited document.)
 *
 * @returns {Promise<void>}
 */
async function closeAllEditors() {
  for (let i = 0; i < 50 && vscode.window.visibleTextEditors.length > 0; i++) {
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

module.exports = {
  EXTENSION_ID,
  WORKSPACE_DIR,
  SAMPLES_DIR,
  activateExtension,
  closeAllEditors,
  codeOf,
  openContent,
  openFile,
  otterDiagnostics,
  positionOf,
  waitFor,
};
