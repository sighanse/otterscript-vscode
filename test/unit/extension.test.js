// @ts-check
/**
 * @fileoverview Unit tests for src/extension.js: what `activate` registers,
 * when it runs diagnostics (documents open at activation, open, a pause
 * after an edit, save, a settings change), keeping the workspace module
 * index on the live buffers, cleaning up on close, and `deactivate`.
 *
 * Requires the vscode stub before extension.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { beforeEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");

const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { captureRegistrations, stubProperty, useWorkspace } = require("./fake-workspace");
const { activate, deactivate } = require("../../src/extension.js");

/** The stub's workspace, typed loosely to call its listeners. */
const workspace = /** @type {any} */ (stub.workspace);

/** A line with a `missing-dollar` warning. */
const WITH_WARNING = "if count == 1 {\n}\n";

/**
 * Fakes `setTimeout` for the test `t`. Typed loosely: the Node types (18, for
 * VS Code's Node) know only the older form of `enable`.
 *
 * @param {import("node:test").TestContext} t
 * @returns {void}
 */
const fakeTimers = (t) => /** @type {any} */ (t.mock.timers).enable({ apis: ["setTimeout"] });

/**
 * Lets pending promise callbacks (a workspace scan, a file read) run.
 *
 * @returns {Promise<void>}
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Activates the extension on the current fake workspace, with these
 * `otterscript.*` settings, and returns what it registered.
 *
 * @param {import("node:test").TestContext} t
 * @param {Record<string, unknown>} [config] - Settings by key (`hover.enable`)
 */
function activateWith(t, config = {}) {
  const values = { ...config };
  stubProperty(t, workspace, "getConfiguration", () => ({
    /**
     * @param {string} key
     * @param {unknown} fallback
     */
    get: (key, fallback) => (key in values ? values[key] : fallback),
  }));
  const context = /** @type {any} */ ({
    extension: { packageJSON: { displayName: "OtterScript", version: "0.0.0" } },
    subscriptions: [],
  });
  const { providers, commands } = captureRegistrations(() => activate(context));
  const diagnostics = context.subscriptions.find((/** @type {any} */ s) => s.name === "otterscript");
  /** @param {any} document */
  const codes = (document) => (diagnostics.get(document.uri) ?? []).map((/** @type {any} */ d) => d.code.value);
  /**
   * Changes settings and tells the extension which keys changed.
   *
   * @param {Record<string, unknown>} changed
   */
  const changeSettings = (changed) => {
    Object.assign(values, changed);
    const keys = Object.keys(changed).map((key) => `otterscript.${key}`);
    for (const listener of workspace.configurationListeners) {
      listener({ affectsConfiguration: (/** @type {string} */ section) => keys.some((key) => key === section || key.startsWith(`${section}.`)) });
    }
  };
  /**
   * Go to Symbol in Workspace's names for `query`. The first query builds
   * the module index; the document events keep it current after that.
   *
   * @param {string} query
   */
  const symbols = async (query) => (await providers.WorkspaceSymbolProvider[0].provideWorkspaceSymbols(query)).map((/** @type {any} */ s) => s.name);
  return { context, providers, commands, diagnostics, codes, changeSettings, symbols };
}

/**
 * Plays a document event to the extension's listeners.
 *
 * @param {"open" | "change" | "save" | "close"} event
 * @param {any} document
 * @returns {void}
 */
function fire(event, document) {
  for (const listener of workspace.documentListeners[event]) listener(event === "change" ? { document } : document);
}

describe("activate", () => {
  beforeEach(() => {
    workspace.configurationListeners.length = 0;
    for (const listeners of Object.values(workspace.documentListeners)) /** @type {any[]} */ (listeners).length = 0;
  });

  it("registers every language feature and command, each disposed with the extension", (t) => {
    const { context, providers, commands } = activateWith(t);
    assert.deepEqual(Object.keys(providers).sort(), [
      "CodeActionsProvider", "CodeLensProvider", "CompletionItemProvider", "DefinitionProvider",
      "DocumentHighlightProvider", "DocumentSymbolProvider", "FoldingRangeProvider", "HoverProvider",
      "InlayHintsProvider", "ReferenceProvider", "RenameProvider", "SignatureHelpProvider",
      "WorkspaceSymbolProvider",
    ]);
    for (const command of ["otterscript.fixAll", "otterscript.refreshDiagnostics", "otterscript.disableDiagnosticRule"]) {
      assert.ok(commands[command], command);
    }
    assert.ok(context.subscriptions.every((/** @type {any} */ s) => typeof s?.dispose === "function"), "everything is disposable");
  });

  it("checks the documents already open, but no other language's", (t) => {
    const otter = makeDocument(WITH_WARNING);
    const other = makeDocument(WITH_WARNING, { languageId: "plaintext" });
    const fake = useWorkspace({ open: [otter, other] });
    t.after(fake.restore);
    const { codes, diagnostics } = activateWith(t);
    assert.deepEqual(codes(otter), ["missing-dollar"]);
    assert.equal(diagnostics.has(other.uri), false);
  });

  it("checks a document when it's opened, and indexes its modules", async (t) => {
    const { codes, symbols } = activateWith(t);
    await symbols("");
    const document = makeDocument(`module Opened {\n}\n${WITH_WARNING}`, { uri: "untitled:Untitled-1" });
    fire("open", document);
    assert.deepEqual(codes(document), ["missing-dollar"]);
    await settle();
    assert.deepEqual(await symbols("Opened"), ["Opened"]);
  });

  it("checks an edited document after a 400 ms pause, then re-indexes it", async (t) => {
    fakeTimers(t);
    const { codes, symbols } = activateWith(t);
    await symbols("");
    const document = makeDocument(`module Edited {\n}\n${WITH_WARNING}`, { uri: "untitled:Untitled-2" });
    fire("change", document);
    fire("change", makeDocument(WITH_WARNING, { languageId: "plaintext" }));
    /** @type {any} */ (t.mock.timers).tick(399);
    assert.deepEqual(codes(document), [], "not yet");
    /** @type {any} */ (t.mock.timers).tick(1);
    assert.deepEqual(codes(document), ["missing-dollar"]);
    assert.deepEqual(await symbols("Edited"), ["Edited"]);
  });

  it("checks a saved document at once, cancelling the pending check", (t) => {
    fakeTimers(t);
    const { codes, diagnostics } = activateWith(t);
    const document = makeDocument(WITH_WARNING);
    fire("change", document);
    fire("save", document);
    assert.deepEqual(codes(document), ["missing-dollar"]);
    diagnostics.delete(document.uri);
    /** @type {any} */ (t.mock.timers).tick(400);
    assert.equal(diagnostics.has(document.uri), false, "the debounced check was cancelled");
    fire("save", makeDocument(WITH_WARNING, { languageId: "plaintext" }));
  });

  it("on close, drops the document's diagnostics, and an untitled document's modules", async (t) => {
    const { codes, diagnostics, symbols } = activateWith(t);
    await symbols("");
    const untitled = makeDocument(`module Unsaved {\n}\n${WITH_WARNING}`, { uri: "untitled:Untitled-3" });
    fire("open", untitled);
    assert.deepEqual(codes(untitled), ["missing-dollar"]);
    fire("close", untitled);
    assert.equal(diagnostics.has(untitled.uri), false);
    await settle();
    assert.deepEqual(await symbols("Unsaved"), []);
  });

  it("on close, re-reads a file's modules from disk, dropping unsaved ones", async (t) => {
    const fake = useWorkspace({ files: { "file:///saved.otter": "module OnDisk {\n}\n" } });
    t.after(fake.restore);
    const { symbols } = activateWith(t);
    assert.deepEqual(await symbols("OnDisk"), ["OnDisk"]);
    const edited = makeDocument("module OnlyInBuffer {\n}\n", { uri: "file:///saved.otter", version: 2 });
    fire("open", edited);
    await settle();
    assert.deepEqual(await symbols("OnlyInBuffer"), ["OnlyInBuffer"]);
    fire("close", edited);
    await settle();
    assert.deepEqual(await symbols("OnlyInBuffer"), []);
    assert.deepEqual(await symbols("OnDisk"), ["OnDisk"]);
    fire("close", makeDocument("", { uri: "file:///notes.txt", languageId: "plaintext" }));
  });

  it("applies changed settings to the providers, and re-checks open documents when the rules change", async (t) => {
    const document = makeDocument(WITH_WARNING);
    const fake = useWorkspace({ open: [document] });
    t.after(fake.restore);
    const { codes, changeSettings, providers } = activateWith(t);
    assert.deepEqual(codes(document), ["missing-dollar"]);

    changeSettings({ "hover.enable": false });
    const hover = await providers.HoverProvider[0].provideHover(makeDocument("set $x = $ToJson(1);"), new stub.Position(0, 11));
    assert.equal(hover, null, "hover is off");

    changeSettings({ "diagnostics.rules": { "missing-dollar": "off" } });
    assert.deepEqual(codes(document), [], "re-checked with the new rules");
    // Another extension's setting changes nothing here.
    for (const listener of workspace.configurationListeners) listener({ affectsConfiguration: () => false });
  });
});

describe("deactivate", () => {
  it("cancels the pending checks", (t) => {
    fakeTimers(t);
    workspace.documentListeners.change.length = 0;
    const { diagnostics } = activateWith(t);
    const document = makeDocument(WITH_WARNING);
    fire("change", document);
    deactivate();
    /** @type {any} */ (t.mock.timers).tick(400);
    assert.equal(diagnostics.has(document.uri), false);
  });
});
