// @ts-check
/**
 * @fileoverview Unit tests for src/providers/workspace-symbols.js: the
 * workspace's module index (built on first use, kept current by the file
 * watcher and the extension's document events), Go to Symbol in Workspace
 * on it, and the file list the cross-file features search.
 *
 * Requires the vscode stub before workspace-symbols.js (which pulls in
 * vscode) loads.
 */

require("../vscode-stub");

const { afterEach, beforeEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");

const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { captureRegistrations, useWorkspace } = require("./fake-workspace");
const { MAX_WORKSPACE_FILE_BYTES } = require("../../src/helpers.js");
const { matchesQuery, registerWorkspaceSymbols } = require("../../src/providers/workspace-symbols.js");

/**
 * Registers the index on the current fake workspace.
 *
 * @param {{ workspaceSymbolsEnabled?: boolean }} [settings]
 * @returns {{
 *   index: ReturnType<typeof registerWorkspaceSymbols>,
 *   query: (text: string) => Promise<any[]>,
 *   watcher: any
 * }} The index operations, Go to Symbol in Workspace, and the file watcher
 */
function register(settings = {}) {
  /** @type {any} */
  let index;
  const { providers } = captureRegistrations(() => {
    index = registerWorkspaceSymbols(/** @type {any} */ ({ workspaceSymbolsEnabled: true, ...settings }));
  });
  const [provider] = providers.WorkspaceSymbolProvider;
  return { index, query: (text) => provider.provideWorkspaceSymbols(text), watcher: stub.watchers.at(-1) };
}

/**
 * The names and files of `symbols`, sorted, for comparing.
 *
 * @param {any[]} symbols - SymbolInformation or WorkspaceModule entries
 * @returns {string[]}
 */
const names = (symbols) => symbols.map((s) => `${s.name} @ ${(s.location?.uri ?? s.uri).toString()}`).sort();

/**
 * Lets pending promise callbacks (a file read the watcher started) run.
 *
 * @returns {Promise<void>}
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A URI as the stub makes one, typed as VS Code's.
 *
 * @param {string} value
 * @returns {any}
 */
const uri = (value) => stub.Uri.parse(value);

/**
 * Fakes `setTimeout` for the test `t`. Typed loosely: the Node types (18, for
 * VS Code's Node) know only the older form of `enable`.
 *
 * @param {import("node:test").TestContext} t
 * @returns {void}
 */
const fakeTimers = (t) => /** @type {any} */ (t.mock.timers).enable({ apis: ["setTimeout"] });

/** @type {ReturnType<typeof useWorkspace>} */
let disk;
afterEach(() => disk?.restore());

// ============================================================
// matchesQuery
// ============================================================

describe("matchesQuery", () => {
  it("matches the query's characters in order, ignoring case and spaces", () => {
    assert.ok(matchesQuery("Deploy-Module", ""));
    assert.ok(matchesQuery("Deploy-Module", "deploy"));
    assert.ok(matchesQuery("Deploy-Module", "dpm"));
    assert.ok(matchesQuery("Deploy-Module", "DM"));
    assert.ok(matchesQuery("Deploy-Module", "dep mod"));
  });

  it("rejects characters missing or out of order", () => {
    assert.ok(!matchesQuery("Deploy-Module", "mdp"));
    assert.ok(!matchesQuery("Deploy-Module", "deployx"));
  });
});

// ============================================================
// Go to Symbol in Workspace
// ============================================================

describe("Go to Symbol in Workspace", () => {
  beforeEach(() => {
    disk = useWorkspace({
      files: {
        "file:///a.otter": "module Deploy-App {\n}\nmodule Build {\n}",
        "file:///b.otter": "module Clean-Up {\n}",
        "file:///none.otter": "Log-Information hi;",
      },
    });
  });

  it("reads nothing until it's first asked", async () => {
    const { query } = register();
    assert.deepEqual(disk.reads, []);
    await query("");
    assert.equal(disk.reads.length, 3);
    await query("b");
    assert.equal(disk.reads.length, 3, "the index is built once");
  });

  it("lists every module whose name matches the query, at its name", async () => {
    const { query } = register();
    assert.deepEqual(names(await query("")), ["Build @ file:///a.otter", "Clean-Up @ file:///b.otter", "Deploy-App @ file:///a.otter"]);
    const [deploy] = await query("dpa");
    assert.equal(deploy.name, "Deploy-App");
    assert.equal(deploy.kind, stub.SymbolKind.Module);
    assert.deepEqual([deploy.location.range.start.line, deploy.location.range.start.character, deploy.location.range.end.character], [0, 7, 17]);
  });

  it("lists nothing, and reads nothing, when turned off", async () => {
    const { query } = register({ workspaceSymbolsEnabled: false });
    assert.deepEqual(await query(""), []);
    assert.deepEqual(disk.reads, []);
  });

  it("includes the open documents: an unsaved one's live text, not the old side of a diff", async () => {
    disk.restore();
    disk = useWorkspace({
      files: { "file:///a.otter": "module Old {\n}" },
      open: [
        makeDocument("module New {\n}", { uri: "file:///a.otter" }),
        makeDocument("module Draft {\n}", { uri: "untitled:Untitled-1" }),
        makeDocument("module Previous {\n}", { uri: "git:/a.otter" }),
        makeDocument("module NotOtter {\n}", { uri: "file:///notes.txt", languageId: "plaintext" }),
      ],
    });
    const { query } = register();
    assert.deepEqual(names(await query("")), ["Draft @ untitled:Untitled-1", "New @ file:///a.otter"]);
  });

  it("tries again on the next query when building the index failed", async () => {
    const workspace = /** @type {any} */ (stub.workspace);
    const findFiles = workspace.findFiles;
    workspace.findFiles = async () => { throw new Error("search failed"); };
    const { query } = register();
    assert.deepEqual(await query(""), []);
    workspace.findFiles = findFiles;
    assert.equal((await query("")).length, 3);
  });
});

// ============================================================
// The index operations
// ============================================================

describe("module index", () => {
  beforeEach(() => {
    disk = useWorkspace({ files: { "file:///a.otter": "module A {\n}" } });
  });

  it("listModules builds the index and lists each module with its file", async () => {
    const { index } = register();
    const modules = await index.listModules();
    assert.deepEqual(names(modules), ["A @ file:///a.otter"]);
    assert.equal(modules[0].range.start.character, "module ".length);
  });

  it("setModuleIndexEntry replaces a file's modules, and drops a file that declares none", async () => {
    const { index } = register();
    await index.listModules(); // a first build would start from the disk again
    const a = uri("file:///a.otter");
    index.setModuleIndexEntry(a, "module A2 {\n}\nmodule A3 {\n}");
    assert.deepEqual(names(await index.listModules()), ["A2 @ file:///a.otter", "A3 @ file:///a.otter"]);
    index.setModuleIndexEntry(a, "Log-Information gone;");
    assert.deepEqual(await index.listModules(), []);
  });

  it("indexes a virtual workspace's files, but no other view of a file", async () => {
    const { index } = register();
    await index.listModules();
    index.setModuleIndexEntry(uri("git:/a.otter"), "module Old {\n}");
    assert.deepEqual(names(await index.listModules()), ["A @ file:///a.otter"]);

    const workspace = /** @type {any} */ (stub.workspace);
    workspace.getWorkspaceFolder = (/** @type {any} */ u) => (u.scheme === "vscode-vfs" ? {} : undefined);
    try {
      index.setModuleIndexEntry(uri("vscode-vfs://github/repo/b.otter"), "module B {\n}");
    } finally {
      workspace.getWorkspaceFolder = () => undefined;
    }
    assert.deepEqual(names(await index.listModules()), ["A @ file:///a.otter", "B @ vscode-vfs://github/repo/b.otter"]);
  });

  it("removeModuleIndexEntry drops a file's modules", async () => {
    const { index } = register();
    await index.listModules();
    index.removeModuleIndexEntry(uri("file:///a.otter"));
    assert.deepEqual(await index.listModules(), []);
  });

  it("indexModuleFile re-reads a file, and drops one that is gone or too large", async () => {
    const { index } = register();
    await index.listModules();
    const big = uri("file:///big.otter");
    disk.restore();
    disk = useWorkspace({
      files: {
        "file:///a.otter": "module A {\n}\nmodule A2 {\n}",
        "file:///big.otter": `module Big {\n}\n${" ".repeat(MAX_WORKSPACE_FILE_BYTES)}`,
      },
    });
    await index.indexModuleFile(uri("file:///a.otter"));
    assert.deepEqual(names(await index.listModules()), ["A @ file:///a.otter", "A2 @ file:///a.otter"]);

    index.setModuleIndexEntry(big, "module Big {\n}");
    await index.indexModuleFile(big);
    assert.deepEqual(names(await index.listModules()), ["A @ file:///a.otter", "A2 @ file:///a.otter"], "a file over the limit has no modules");

    await index.indexModuleFile(uri("file:///gone.otter"));
    index.setModuleIndexEntry(uri("file:///gone.otter"), "module Gone {\n}");
    await index.indexModuleFile(uri("file:///gone.otter"));
    assert.ok(!names(await index.listModules()).some((n) => n.startsWith("Gone")));

    await index.indexModuleFile(uri("git:/a.otter"));
    assert.ok(!disk.reads.includes("git:/a.otter"), "another view of a file isn't read");
  });

  it("listFiles lists the files on disk and the open OtterScript documents, once each", async () => {
    disk.restore();
    disk = useWorkspace({
      files: { "file:///a.otter": "", "file:///b.otter": "" },
      open: [
        makeDocument("", { uri: "file:///a.otter" }),
        makeDocument("", { uri: "untitled:Untitled-1" }),
        makeDocument("", { uri: "git:/a.otter" }),
        makeDocument("", { uri: "file:///notes.txt", languageId: "plaintext" }),
      ],
    });
    const { index } = register();
    assert.deepEqual((await index.listFiles()).map(String).sort(), ["file:///a.otter", "file:///b.otter", "untitled:Untitled-1"]);
  });
});

// ============================================================
// The file watcher
// ============================================================

describe("module index file watcher", () => {
  beforeEach(() => {
    disk = useWorkspace({ files: { "file:///a.otter": "module A {\n}", "file:///b.otter": "module B {\n}" } });
  });

  it("ignores created and changed files until the index is built", async () => {
    const { watcher } = register();
    watcher.fire("create", uri("file:///a.otter"));
    watcher.fire("change", uri("file:///a.otter"));
    await settle();
    assert.deepEqual(disk.reads, []);
  });

  it("indexes a created file, and forgets a deleted one", async () => {
    disk.restore();
    disk = useWorkspace({ files: { "file:///a.otter": "module A {\n}" } });
    const { index, watcher } = register();
    await index.listModules();

    disk.restore();
    disk = useWorkspace({ files: { "file:///a.otter": "module A {\n}", "file:///b.otter": "module B {\n}" } });
    watcher.fire("create", uri("file:///b.otter"));
    await settle();
    assert.deepEqual(names(await index.listModules()), ["A @ file:///a.otter", "B @ file:///b.otter"]);

    watcher.fire("delete", uri("file:///a.otter"));
    assert.deepEqual(names(await index.listModules()), ["B @ file:///b.otter"]);
  });

  it("re-reads a changed file once, 400 ms after its last change", async (t) => {
    const { index, watcher } = register();
    await index.listModules();
    const readsBefore = disk.reads.length;
    fakeTimers(t);

    const a = uri("file:///a.otter");
    watcher.fire("change", a);
    t.mock.timers.tick(300);
    watcher.fire("change", a);
    t.mock.timers.tick(300);
    assert.equal(disk.reads.length, readsBefore, "the first change's timer was replaced");
    t.mock.timers.tick(100);
    await settle();
    assert.deepEqual(disk.reads.slice(readsBefore), ["file:///a.otter"]);
  });

  it("cancels a changed file's pending re-read when it's deleted, or on dispose", async (t) => {
    const { index, watcher } = register();
    await index.listModules();
    const readsBefore = disk.reads.length;
    fakeTimers(t);

    watcher.fire("change", uri("file:///a.otter"));
    watcher.fire("delete", uri("file:///a.otter"));
    watcher.fire("change", uri("file:///b.otter"));
    for (const disposable of index.disposables) disposable.dispose();
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(disk.reads.length, readsBefore);
  });
});
