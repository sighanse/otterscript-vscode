// @ts-check
/**
 * @fileoverview Unit tests for src/providers/navigation.js: the folding
 * ranges and their kinds, and the providers -- Go to Definition, Rename,
 * Find References (across the files of a fake workspace), highlights, the
 * Outline and the reference-count CodeLens.
 *
 * Requires the vscode stub before navigation.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");

const stub = require("../vscode-stub");
const { DocumentHighlightKind, FoldingRangeKind } = stub;
const { makeDocument } = require("./fake-document");
const { captureRegistrations, stubProperty, useWorkspace } = require("./fake-workspace");
const { computeFoldingRanges, registerNavigation } = require("../../src/providers/navigation.js");
const { registerWorkspaceSymbols } = require("../../src/providers/workspace-symbols.js");

/**
 * A fake `vscode.TextDocument` backed by a plain string (see fake-document.js).
 *
 * @param {string} text
 * @returns {any}
 */
const makeDoc = (text) => makeDocument(text);

// ============================================================
// computeFoldingRanges
// ============================================================

describe("computeFoldingRanges", () => {
  /** @param {string} src */
  const run = (src) => computeFoldingRanges(makeDoc(src));

  it("folds a multi-line brace block", () => {
    const ranges = run(["if $x {", "  Log-Info foo;", "}"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 2);
    assert.equal(ranges[0].kind, undefined, "not a Region: Fold All Regions is for #region");
  });

  it("does not fold a single-line brace block", () => {
    assert.deepEqual(run("if $x { Log-Info foo; }"), []);
  });

  it("folds a #region / #endregion pair", () => {
    const ranges = run(["#region setup", "$x = 1;", "$y = 2;", "#endregion"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
    assert.equal(ranges[0].kind, FoldingRangeKind.Region);
  });

  it("folds a multi-line block comment as a Comment range", () => {
    const ranges = run(["/* first", " * second", " */ code"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 2);
    assert.equal(ranges[0].kind, FoldingRangeKind.Comment);
  });

  it("folds a multi-line swim-string, with no kind", () => {
    const ranges = run(["$s = >END>", "line one", "line two", ">END>;"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
    assert.equal(ranges[0].kind, undefined);
  });

  it("ignores braces that live inside string literals", () => {
    const ranges = run(['$open = "{";', "$mid = 1;", '$close = "}";'].join("\n"));
    assert.deepEqual(ranges, []);
  });

  it("folds a multi-line map literal", () => {
    const ranges = run(["$m = %(", "  a: 1,", "  b: 2", ")"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
  });

  it("folds a multi-line <% %> template tag", () => {
    const ranges = run(["<%", "  Log-Information $x;", "%>"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 2);
    assert.equal(ranges[0].kind, undefined);
  });

  it("returns nested brace ranges, innermost first", () => {
    const ranges = run(["a {", "  b {", "    c;", "  }", "}"].join("\n"));
    assert.equal(ranges.length, 2);
    // inner block closes first, so it is pushed first
    assert.deepEqual(ranges.map((r) => [r.start, r.end]), [
      [1, 3],
      [0, 4],
    ]);
  });
});

// ============================================================
// The providers
// ============================================================

/**
 * Registers the navigation providers on the current fake workspace, with
 * the real module index (workspace-symbols.js) behind them.
 *
 * @param {{ codeLensEnabled?: boolean }} [settings]
 * @returns {Record<string, any>} The providers by kind (`RenameProvider`, ...)
 */
function registerProviders(settings = {}) {
  const { providers } = captureRegistrations(() => {
    const index = registerWorkspaceSymbols(/** @type {any} */ ({ workspaceSymbolsEnabled: true }));
    registerNavigation(/** @type {any} */ ({ codeLensEnabled: true, ...settings }), index);
  });
  return Object.fromEntries(Object.entries(providers).map(([kind, [provider]]) => [kind, provider]));
}

/**
 * The position `offset` characters into the `n`th (0-based) occurrence of
 * `needle` in `document`.
 *
 * @param {any} document
 * @param {string} needle
 * @param {number} [offset]
 * @param {number} [n]
 * @returns {any}
 */
function at(document, needle, offset = 1, n = 0) {
  const text = document.getText();
  let index = -1;
  for (let i = 0; i <= n; i++) {
    index = text.indexOf(needle, index + 1);
    assert.ok(index >= 0, `'${needle}' #${n} isn't in the document`);
  }
  return document.positionAt(index + offset);
}

/**
 * Each location (or anything with a `uri` and `range`) as
 * `"<uri> <line>:<start>-<end>"`, sorted, for comparing.
 *
 * @param {any[]} locations
 * @returns {string[]}
 */
const where = (locations) => locations
  .map((l) => `${(l.uri ?? "").toString()} ${l.range.start.line}:${l.range.start.character}-${l.range.end.character}`)
  .sort();

/**
 * The text each edit in `edit` writes, with the place, sorted.
 *
 * @param {any} edit - A stub WorkspaceEdit
 * @returns {string[]}
 */
const edits = (edit) => edit.edits
  .map((/** @type {any} */ [, uri, range, text]) => `${uri.toString()} ${range.start.line}:${range.start.character}-${range.end.character} ${text}`)
  .sort();

/** @type {ReturnType<typeof useWorkspace> | undefined} */
let disk;
afterEach(() => {
  disk?.restore();
  disk = undefined;
});

/** Each test's document is a new version of main.otter, so no cache answers for another's. */
let mainVersion = 0;

/**
 * A document that is open in the fake workspace, with `files` on disk.
 *
 * @param {string} text
 * @param {Record<string, string>} [files]
 * @param {string} [uri]
 * @returns {any}
 */
function openDocument(text, files = {}, uri = "file:///main.otter") {
  const document = makeDocument(text, { uri, version: ++mainVersion });
  disk = useWorkspace({ files: { [uri]: text, ...files }, open: [document] });
  return document;
}

describe("Go to Definition", () => {
  it("goes from a variable to every assignment of it in the file", async () => {
    const doc = openDocument(["set $x = 1;", "Log-Information $x;", "set $x = 2;"].join("\n"));
    const { DefinitionProvider } = registerProviders();
    const found = await DefinitionProvider.provideDefinition(doc, at(doc, "$x;"));
    assert.deepEqual(where(found), ["file:///main.otter 0:4-6", "file:///main.otter 2:4-6"]);
  });

  it("has nowhere to go for a variable the file only reads, or a `$` in a comment", async () => {
    const doc = openDocument(["Log-Information $PackageName;", "# $x"].join("\n"));
    const { DefinitionProvider } = registerProviders();
    assert.equal(await DefinitionProvider.provideDefinition(doc, at(doc, "$PackageName")), null);
    assert.equal(await DefinitionProvider.provideDefinition(doc, at(doc, "$x")), null);
  });

  it("goes from a call to the module the file declares", async () => {
    const doc = openDocument(["module Deploy {", "}", "call Deploy;"].join("\n"));
    const { DefinitionProvider } = registerProviders();
    const found = await DefinitionProvider.provideDefinition(doc, at(doc, "Deploy;"));
    assert.deepEqual(where([found]), ["file:///main.otter 0:7-13"]);
  });

  it("goes from a call to the modules other files declare, case-insensitively", async () => {
    const doc = openDocument("call deploy;", {
      "file:///a.otter": "module Deploy {\n}",
      "file:///b.otter": "\nmodule DEPLOY {\n}",
      "file:///c.otter": "module Other {\n}",
    });
    const { DefinitionProvider } = registerProviders();
    const found = await DefinitionProvider.provideDefinition(doc, at(doc, "deploy"));
    assert.deepEqual(where(found), ["file:///a.otter 0:7-13", "file:///b.otter 1:7-13"]);
  });

  it("has nowhere to go from a declaration, an undeclared module, or other code", async () => {
    const doc = openDocument(["module Deploy {", "}", "call Missing;", "Log-Information hi;"].join("\n"));
    const { DefinitionProvider } = registerProviders();
    assert.equal(await DefinitionProvider.provideDefinition(doc, at(doc, "Deploy")), null);
    assert.equal(await DefinitionProvider.provideDefinition(doc, at(doc, "Missing")), null);
    assert.equal(await DefinitionProvider.provideDefinition(doc, at(doc, "Information")), null);
  });
});

describe("Rename: preparing", () => {
  it("selects a variable's name without its sigil or braces", () => {
    const doc = openDocument(["set $count = 1;", "Log-Information ${count};"].join("\n"));
    const { RenameProvider } = registerProviders();
    const plain = RenameProvider.prepareRename(doc, at(doc, "$count"));
    assert.equal(plain.placeholder, "count");
    assert.deepEqual(where([plain]), [" 0:5-10"]);
    const braced = RenameProvider.prepareRename(doc, at(doc, "${count}"));
    assert.deepEqual(where([braced]), [" 1:18-23"]);
  });

  it("selects a module's name, from its declaration or a call", () => {
    const doc = openDocument(["module Deploy {", "}", "call Deploy;"].join("\n"));
    const { RenameProvider } = registerProviders();
    const fromCall = RenameProvider.prepareRename(doc, at(doc, "Deploy;"));
    assert.equal(fromCall.placeholder, "Deploy");
    assert.deepEqual(where([fromCall]), [" 2:5-11"]);
  });

  it("refuses a module the file declares twice, and anything else", () => {
    const doc = openDocument(["module Deploy {", "}", "module deploy {", "}", "Log-Information hi;"].join("\n"));
    const { RenameProvider } = registerProviders();
    assert.throws(() => RenameProvider.prepareRename(doc, at(doc, "Deploy")), /declares 'Deploy' 2 times/);
    assert.throws(() => RenameProvider.prepareRename(doc, at(doc, "Information")), /Only a variable or a module/);
  });
});

describe("Rename: variables", () => {
  const text = ["set $count = 1;", "Log-Information \"n: $count\";", "Log-Information ${count};"].join("\n");

  it("renames every occurrence in the file, keeping braces where they were", async () => {
    const doc = openDocument(text);
    const { RenameProvider } = registerProviders();
    const edit = await RenameProvider.provideRenameEdits(doc, at(doc, "$count"), "total");
    assert.deepEqual(edits(edit), [
      "file:///main.otter 0:4-10 $total",
      "file:///main.otter 1:20-26 $total",
      "file:///main.otter 2:16-24 ${total}",
    ]);
  });

  it("accepts the sigil or braces typed with the new name, and braces a name with spaces", async () => {
    const doc = openDocument(text);
    const { RenameProvider } = registerProviders();
    assert.deepEqual(edits(await RenameProvider.provideRenameEdits(doc, at(doc, "$count"), "$total"))[0], "file:///main.otter 0:4-10 $total");
    assert.deepEqual(edits(await RenameProvider.provideRenameEdits(doc, at(doc, "$count"), "${total}"))[0], "file:///main.otter 0:4-10 $total");
    assert.deepEqual(
      edits(await RenameProvider.provideRenameEdits(doc, at(doc, "$count"), "item count")).map((e) => e.split(" ").slice(2).join(" ")),
      ["${item count}", "${item count}", "${item count}"]
    );
  });

  it("refuses an invalid name, or one the file already uses", async () => {
    const doc = openDocument(["set $count = 1;", "set $other = 2;"].join("\n"));
    const { RenameProvider } = registerProviders();
    const position = at(doc, "$count");
    for (const bad of ["1st", "ends-", "has.dot", "x".repeat(51)]) {
      await assert.rejects(RenameProvider.provideRenameEdits(doc, position, bad), /isn't a valid variable name/, bad);
    }
    await assert.rejects(RenameProvider.provideRenameEdits(doc, position, "OTHER"), /'\$OTHER' is already used/);
    // A new casing of its own name is fine.
    assert.equal(edits(await RenameProvider.provideRenameEdits(doc, position, "Count")).length, 1);
  });
});

describe("Rename: modules", () => {
  it("renames a module's declaration and calls in the file", async () => {
    const doc = openDocument(["module Deploy {", "}", "call Deploy;", "call Core::Deploy;"].join("\n"));
    const { RenameProvider } = registerProviders();
    const edit = await RenameProvider.provideRenameEdits(doc, at(doc, "Deploy"), " Release ");
    assert.deepEqual(edits(edit), [
      "file:///main.otter 0:7-13 Release",
      "file:///main.otter 2:5-11 Release",
      "file:///main.otter 3:11-17 Release",
    ]);
  });

  it("renames the calls in other files, but not those of a file that declares its own", async () => {
    const doc = openDocument("module Deploy {\n}", {
      "file:///caller.otter": "call Deploy;",
      "file:///own.otter": "module Deploy {\n}\ncall Deploy;",
      "file:///unrelated.otter": "call Other;",
    });
    const { RenameProvider } = registerProviders();
    const edit = await RenameProvider.provideRenameEdits(doc, at(doc, "Deploy"), "Release");
    // own.otter declares Deploy too: the rename can't tell whose calls are
    // whose, so it stays within this file.
    assert.deepEqual(edits(edit), ["file:///main.otter 0:7-13 Release"]);
  });

  it("renames, from a call, the one other file's declaration and every caller", async () => {
    const doc = openDocument("call Deploy;", {
      "file:///lib.otter": "module Deploy {\n}\ncall Deploy;",
      "file:///caller.otter": "call deploy;",
      "file:///unrelated.otter": "call Other;",
    });
    const { RenameProvider } = registerProviders();
    const edit = await RenameProvider.provideRenameEdits(doc, at(doc, "Deploy"), "Release");
    assert.deepEqual(edits(edit), [
      "file:///caller.otter 0:5-11 Release",
      "file:///lib.otter 0:7-13 Release",
      "file:///lib.otter 2:5-11 Release",
      "file:///main.otter 0:5-11 Release",
    ]);
    assert.ok(!disk?.opened.includes("file:///unrelated.otter"), "a file that doesn't mention the name isn't opened");
  });

  it("refuses an invalid name, or a clash with a module declared here or in another file", async () => {
    const doc = openDocument(["module Deploy {", "}", "module Build {", "}"].join("\n"), {
      "file:///caller.otter": "call Deploy;",
      "file:///lib.otter": "module Release {\n}",
    });
    const { RenameProvider } = registerProviders();
    const position = at(doc, "Deploy");
    await assert.rejects(RenameProvider.provideRenameEdits(doc, position, "two words"), /isn't a valid module name/);
    await assert.rejects(RenameProvider.provideRenameEdits(doc, position, "build"), /already declared in this file/);
    await assert.rejects(RenameProvider.provideRenameEdits(doc, position, "Release"), /already declared in lib\.otter/);
    // A new casing of its own name is fine.
    assert.equal(edits(await RenameProvider.provideRenameEdits(doc, position, "DEPLOY")).length, 2);
  });

  it("refuses a call no single declaration answers, a duplicated module, or other code", async () => {
    const doc = openDocument(["call Missing;", "call Twice;", "call Split;", "Log-Information hi;"].join("\n"), {
      "file:///twice.otter": "module Twice {\n}\nmodule twice {\n}",
      "file:///a.otter": "module Split {\n}",
      "file:///b.otter": "module Split {\n}",
    });
    const { RenameProvider } = registerProviders();
    await assert.rejects(RenameProvider.provideRenameEdits(doc, at(doc, "Missing"), "New"), /no one module declaration/);
    await assert.rejects(RenameProvider.provideRenameEdits(doc, at(doc, "Split"), "New"), /no one module declaration/);
    await assert.rejects(RenameProvider.provideRenameEdits(doc, at(doc, "Twice"), "New"), /declares 'Twice' 2 times/);
    await assert.rejects(RenameProvider.provideRenameEdits(doc, at(doc, "Information"), "New"), /Only a variable or a module/);
  });

  it("finds no uses in a file that can't be read", async (t) => {
    const doc = openDocument("module Deploy {\n}", { "file:///caller.otter": "call Deploy;" });
    const workspace = /** @type {any} */ (stub.workspace);
    const { RenameProvider } = registerProviders();
    const stat = workspace.fs.stat;
    stubProperty(t, workspace.fs, "stat", async (/** @type {any} */ uri) => {
      if (uri.toString() === "file:///caller.otter") throw new Error("gone");
      return stat(uri);
    });
    const edit = await RenameProvider.provideRenameEdits(doc, at(doc, "Deploy"), "Release");
    assert.deepEqual(edits(edit), ["file:///main.otter 0:7-13 Release"]);
  });
});

describe("Find References", () => {
  const files = { "file:///caller.otter": "call Deploy;" };
  const text = ["module Deploy {", "}", "call Deploy;"].join("\n");

  it("lists a module's declaration and calls across files", async () => {
    const doc = openDocument(text, files);
    const { ReferenceProvider } = registerProviders();
    const found = await ReferenceProvider.provideReferences(doc, at(doc, "Deploy;"), { includeDeclaration: true });
    assert.deepEqual(where(found), ["file:///caller.otter 0:5-11", "file:///main.otter 0:7-13", "file:///main.otter 2:5-11"]);
  });

  it("leaves out the declaration when asked to", async () => {
    const doc = openDocument(text, files);
    const { ReferenceProvider } = registerProviders();
    const found = await ReferenceProvider.provideReferences(doc, at(doc, "Deploy"), { includeDeclaration: false });
    assert.deepEqual(where(found), ["file:///caller.otter 0:5-11", "file:///main.otter 2:5-11"]);
  });

  it("leaves out a file whose unsaved text declares the module, before the index has caught up", async () => {
    const doc = openDocument(text, files);
    const { ReferenceProvider } = registerProviders();
    const position = at(doc, "Deploy");
    await ReferenceProvider.provideReferences(doc, position, { includeDeclaration: true }); // builds the index
    stub.workspace.textDocuments.push(makeDocument("module Deploy {\n}\ncall Deploy;", { uri: "file:///caller.otter", version: 2 }));
    const found = await ReferenceProvider.provideReferences(doc, position, { includeDeclaration: true });
    assert.deepEqual(where(found), ["file:///main.otter 0:7-13", "file:///main.otter 2:5-11"]);
  });

  it("lists only this file's calls of a module nothing declares, and nothing for other code", async () => {
    const doc = openDocument(["call Missing;", "call Missing;", "Log-Information hi;"].join("\n"));
    const { ReferenceProvider } = registerProviders();
    const found = await ReferenceProvider.provideReferences(doc, at(doc, "Missing"), { includeDeclaration: false });
    assert.deepEqual(where(found), ["file:///main.otter 0:5-12", "file:///main.otter 1:5-12"]);
    assert.deepEqual(await ReferenceProvider.provideReferences(doc, at(doc, "Information"), { includeDeclaration: true }), []);
  });
});

describe("Highlights", () => {

  it("marks a variable's assignments as writes and its other uses as reads", () => {
    const doc = openDocument(["set $x = 1;", "Log-Information $x;"].join("\n"));
    const { DocumentHighlightProvider } = registerProviders();
    const found = DocumentHighlightProvider.provideDocumentHighlights(doc, at(doc, "$x;"));
    assert.deepEqual(found.map((/** @type {any} */ h) => [h.range.start.line, h.kind]), [
      [0, DocumentHighlightKind.Write],
      [1, DocumentHighlightKind.Read],
    ]);
  });

  it("marks a module's declaration as a write and its calls as reads", () => {
    const doc = openDocument(["call Deploy;", "module Deploy {", "}"].join("\n"));
    const { DocumentHighlightProvider } = registerProviders();
    const found = DocumentHighlightProvider.provideDocumentHighlights(doc, at(doc, "Deploy"));
    assert.deepEqual(found.map((/** @type {any} */ h) => [h.range.start.line, h.kind]).sort(), [
      [0, DocumentHighlightKind.Read],
      [1, DocumentHighlightKind.Write],
    ]);
  });

  it("marks only calls when the file doesn't declare the module", () => {
    const doc = openDocument("call Deploy;");
    const { DocumentHighlightProvider } = registerProviders();
    const found = DocumentHighlightProvider.provideDocumentHighlights(doc, at(doc, "Deploy"));
    assert.deepEqual(found.map((/** @type {any} */ h) => h.kind), [DocumentHighlightKind.Read]);
  });

  it("highlights nothing for a `$` in a comment, or other code", () => {
    const doc = openDocument(["# $x", "Log-Information hi;"].join("\n"));
    const { DocumentHighlightProvider } = registerProviders();
    assert.equal(DocumentHighlightProvider.provideDocumentHighlights(doc, at(doc, "$x")), undefined);
    assert.equal(DocumentHighlightProvider.provideDocumentHighlights(doc, at(doc, "Information")), undefined);
  });
});

describe("Outline", () => {
  it("lists each module, spanning its declaration line and selecting its name", () => {
    const doc = openDocument(["module Deploy {", "}", "module Build<$x> {", "}"].join("\n"));
    const { DocumentSymbolProvider } = registerProviders();
    const symbols = DocumentSymbolProvider.provideDocumentSymbols(doc);
    assert.deepEqual(symbols.map((/** @type {any} */ s) => s.name), ["Deploy", "Build"]);
    assert.equal(symbols[1].kind, stub.SymbolKind.Module);
    assert.deepEqual(where([{ range: symbols[1].selectionRange }]), [" 2:7-12"]);
    assert.deepEqual(where([{ range: symbols[1].range }]), [" 2:0-18"]);
  });
});

describe("Reference counts (CodeLens)", () => {
  const text = ["module Deploy {", "}", "module Build {", "}", "call deploy;", "call Deploy;", "call Build;"].join("\n");

  it("counts each module's calls in the file, with a link to them", () => {
    const doc = openDocument(text);
    const { CodeLensProvider } = registerProviders();
    const lenses = CodeLensProvider.provideCodeLenses(doc);
    assert.deepEqual(lenses.map((/** @type {any} */ l) => l.command.title), ["2 references", "1 reference"]);
    const [uri, position, locations] = lenses[0].command.arguments;
    assert.equal(lenses[0].command.command, "editor.action.showReferences");
    assert.equal(uri, doc.uri);
    assert.deepEqual([position.line, position.character], [0, 7]);
    assert.deepEqual(where(locations), ["file:///main.otter 4:5-11", "file:///main.otter 5:5-11"]);
  });

  it("shows none when turned off", () => {
    const doc = openDocument(text);
    const { CodeLensProvider } = registerProviders({ codeLensEnabled: false });
    assert.deepEqual(CodeLensProvider.provideCodeLenses(doc), []);
  });

  it("asks VS Code for new lenses when the CodeLens setting changes, and only then", () => {
    const workspace = /** @type {any} */ (stub.workspace);
    workspace.configurationListeners.length = 0;
    const { CodeLensProvider } = registerProviders();
    let fired = 0;
    CodeLensProvider.onDidChangeCodeLenses(() => fired++);
    for (const listener of workspace.configurationListeners) {
      listener({ affectsConfiguration: (/** @type {string} */ s) => s === "otterscript.hover" });
      listener({ affectsConfiguration: (/** @type {string} */ s) => s === "otterscript.codeLens" });
    }
    assert.equal(fired, 1);
  });
});

describe("Folding (provider)", () => {
  it("folds what computeFoldingRanges folds", () => {
    const doc = openDocument(["if $x {", "  Log-Information foo;", "}"].join("\n"));
    const { FoldingRangeProvider } = registerProviders();
    assert.deepEqual(FoldingRangeProvider.provideFoldingRanges(doc), computeFoldingRanges(doc));
  });
});
