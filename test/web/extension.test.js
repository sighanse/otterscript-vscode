// @ts-check
/**
 * @fileoverview Web tests: the extension's browser bundle (package.json
 * `browser`, dist/web/extension.js) loads and works in VS Code in the
 * browser, as on vscode.dev and github.dev. The workspace is
 * test/integration/workspace, served as a virtual file system.
 *
 * The desktop integration tests (test/integration/) cover the features in
 * depth; these check that each kind works here at all: activation, reading
 * workspace files, diagnostics, hover, completion and navigation. No Node
 * modules are available, not even `assert`.
 */

const vscode = require("vscode");

/** `publisher.name` from package.json. */
const EXTENSION_ID = "sighanse.otterscript-vscode";

/**
 * Fails the test with `message` unless `value` is truthy.
 *
 * @param {unknown} value
 * @param {string} message
 * @returns {asserts value}
 */
function ok(value, message) {
  if (!value) throw new Error(message);
}

/**
 * Opens a document in an editor and waits for the extension to activate.
 *
 * @param {vscode.Uri | { language: string, content: string }} source - A
 *   workspace file, or the content of an untitled OtterScript document
 * @returns {Promise<vscode.TextDocument>}
 */
async function open(source) {
  const document = source instanceof vscode.Uri
    ? await vscode.workspace.openTextDocument(source)
    : await vscode.workspace.openTextDocument(source);
  await vscode.window.showTextDocument(document);
  await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  return document;
}

/**
 * The position of `needle` in the document, plus `offset` characters into it.
 *
 * @param {vscode.TextDocument} document
 * @param {string} needle
 * @param {number} [offset]
 * @returns {vscode.Position}
 */
function positionOf(document, needle, offset = 0) {
  const index = document.getText().indexOf(needle);
  ok(index !== -1, `'${needle}' not found`);
  return document.positionAt(index + offset);
}

/**
 * test/integration/workspace/main.otter, as the browser's VS Code sees it.
 *
 * @returns {vscode.Uri}
 */
function mainOtter() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  ok(folder, "a workspace folder is open");
  return vscode.Uri.joinPath(folder.uri, "main.otter");
}

describe("the extension in VS Code for the web", () => {
  after(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("runs its browser bundle", async () => {
    const document = await open(mainOtter());
    ok(document.languageId === "otterscript", `language is ${document.languageId}`);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    ok(extension?.isActive, "the extension is active");
    ok(extension.extensionKind === vscode.ExtensionKind.UI, "it runs in the browser's extension host");
  });

  it("publishes diagnostics", async () => {
    const document = await open({ language: "otterscript", content: "if count == 1 {\n}\n" });
    await vscode.commands.executeCommand("otterscript.refreshDiagnostics", document.uri);
    const codes = vscode.languages.getDiagnostics(document.uri)
      .filter((d) => d.source === "OtterScript")
      .map((d) => (typeof d.code === "object" ? d.code.value : d.code));
    ok(codes.includes("missing-dollar"), `diagnostics: ${codes.join(", ")}`);
  });

  it("shows hovers and completions", async () => {
    const document = await open({ language: "otterscript", content: "set $json = $ToJson(%(a: 1));\n" });
    /** @type {vscode.Hover[]} */
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, positionOf(document, "$ToJson", 2));
    const text = hovers.flatMap((h) => h.contents).map((c) => (typeof c === "string" ? c : c.value)).join("\n");
    ok(/\$ToJson\(data\)/.test(text), `hover: ${text}`);

    /** @type {vscode.CompletionList} */
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, positionOf(document, "$ToJson", 1), "$");
    const labels = list.items.map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    ok(labels.includes("$ToJson"), "$ToJson is offered");
  });

  it("finds a module declared in another workspace file", async () => {
    const source = await open({ language: "otterscript", content: 'call Greet(name: "x");\n' });
    /** @type {(vscode.Location | vscode.LocationLink)[]} */
    const results = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", source.uri, positionOf(source, "Greet", 2));
    const uris = results.map((l) => ("targetUri" in l ? l.targetUri : l.uri).toString());
    ok(uris.includes(mainOtter().toString()), `definitions: ${uris.join(", ")}`);
  });
});
