// @ts-check
/**
 * @fileoverview Integration tests for module navigation (definition,
 * references, outline, workspace symbols, CodeLens), folding, and highlight
 * all occurrences, run against test/integration/workspace/main.otter.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");
const { WORKSPACE_DIR, closeAllEditors, openContent, openFile, otterDiagnostics, positionOf, waitFor } = require("./helpers");

describe("navigation and highlighting (main.otter)", () => {
  /** @type {vscode.TextDocument} */
  let document;
  before(async () => {
    document = await openFile(path.join(WORKSPACE_DIR, "main.otter"));
  });
  after(closeAllEditors);

  /** 0-based line of the `module Greet` declaration. */
  const declarationLine = () => positionOf(document, "module Greet").line;

  it("goes to a module's declaration from a call", async () => {
    /** @type {(vscode.Location | vscode.LocationLink)[]} */
    const results = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider", document.uri, positionOf(document, "call Greet(name: $", 6)
    );
    const [location] = results;
    const range = "targetRange" in location ? location.targetRange : location.range;
    assert.equal(range.start.line, declarationLine());
  });

  it("goes to a module declared in another workspace file", async () => {
    const source = await openContent('call Greet(name: "x");\n');
    /** @type {(vscode.Location | vscode.LocationLink)[]} */
    const results = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider", source.uri, positionOf(source, "Greet", 2)
    );
    const uris = results.map((l) => ("targetUri" in l ? l.targetUri : l.uri).fsPath);
    assert.ok(uris.some((p) => p.endsWith("main.otter")), uris.join(", "));
  });

  it("refuses to rename a module the file declares twice", async () => {
    const source = await openContent("module Twice {\n}\nmodule Twice {\n}\ncall Twice;\n");
    await assert.rejects(
      Promise.resolve(vscode.commands.executeCommand(
        "vscode.executeDocumentRenameProvider", source.uri, positionOf(source, "call Twice", 6), "Once"
      )),
      /declares 'Twice' 2 times/
    );
  });

  it("goes to where an operation's output capture assigns a variable", async () => {
    const source = await openContent('Get-Http(Url: "u", ResponseBody => $body);\nLog-Information $body;\n');
    /** @type {vscode.Location[]} */
    const results = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider", source.uri, positionOf(source, "Information $body", 13)
    );
    assert.deepEqual(results.map((l) => l.range.start.line), [0]);
  });

  it("matches module names case-insensitively, also with Go to Symbol in Workspace turned off", async () => {
    const config = vscode.workspace.getConfiguration("otterscript");
    await config.update("workspaceSymbols.enable", false, vscode.ConfigurationTarget.Workspace);
    try {
      const source = await openContent('call greet(name: "x");\n');
      /** @type {(vscode.Location | vscode.LocationLink)[]} */
      const results = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider", source.uri, positionOf(source, "greet", 2)
      );
      const uris = results.map((l) => ("targetUri" in l ? l.targetUri : l.uri).fsPath);
      assert.ok(uris.some((p) => p.endsWith("main.otter")), uris.join(", "));
      /** @type {vscode.SymbolInformation[]} */
      const symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "Greet");
      assert.deepEqual(symbols.filter((s) => s.name === "Greet"), [], "Ctrl+T is off");
    } finally {
      await config.update("workspaceSymbols.enable", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  /**
   * Renames the symbol at `needle` (+ `offset`) and applies the edit.
   *
   * @param {vscode.TextDocument} source
   * @param {string} needle
   * @param {number} offset
   * @param {string} newName
   * @returns {Promise<void>}
   */
  async function rename(source, needle, offset, newName) {
    /** @type {vscode.WorkspaceEdit} */
    const edit = await vscode.commands.executeCommand(
      "vscode.executeDocumentRenameProvider", source.uri, positionOf(source, needle, offset), newName
    );
    await vscode.workspace.applyEdit(edit);
  }

  it("renames a variable everywhere in the file, strings included, adding braces a spaced name needs", async () => {
    const source = await openContent('set $count = 1;\nLog-Information "$count items" ${count};\n');
    await rename(source, "$count =", 2, "total");
    assert.equal(source.getText(), 'set $total = 1;\nLog-Information "$total items" ${total};\n');
    await rename(source, "$total =", 2, "item total");
    assert.equal(source.getText(), 'set ${item total} = 1;\nLog-Information "${item total} items" ${item total};\n');
  });

  it("renames a module's declaration and its calls", async () => {
    const source = await openContent("module Old-Name {\n}\ncall Old-Name;\n");
    await rename(source, "call Old-Name", 6, "New-Name");
    assert.equal(source.getText(), "module New-Name {\n}\ncall New-Name;\n");
  });

  /**
   * The rename edit for the symbol at `needle` (+ `offset`), per file name
   * (`<untitled>` for this test's document): how many edits, not applied.
   *
   * @param {vscode.TextDocument} source
   * @param {string} needle
   * @param {number} offset
   * @param {string} newName
   * @returns {Promise<Map<string, number>>}
   */
  async function renameEditCounts(source, needle, offset, newName) {
    /** @type {vscode.WorkspaceEdit} */
    const edit = await vscode.commands.executeCommand(
      "vscode.executeDocumentRenameProvider", source.uri, positionOf(source, needle, offset), newName
    );
    return new Map(edit.entries().map(([uri, edits]) => [
      uri.toString() === source.uri.toString() ? "<untitled>" : uri.path.split("/").pop() ?? "", edits.length,
    ]));
  }

  it("renames a module in the workspace file that declares it, with its calls there and here", async () => {
    const source = await openContent('call Greet(name: "x");\n');
    const counts = await renameEditCounts(source, "Greet", 2, "Welcome");
    assert.equal(counts.get("main.otter"), 3, "declaration and two calls");
    assert.equal(counts.get("<untitled>"), 1);
  });

  it("finds a module's references across workspace files", async () => {
    const source = await openContent('call Greet(name: "x");\n');
    /** @type {vscode.Location[]} */
    const references = await vscode.commands.executeCommand(
      "vscode.executeReferenceProvider", source.uri, positionOf(source, "Greet", 2)
    );
    const inMain = references.filter((l) => l.uri.path.endsWith("main.otter"));
    assert.equal(inMain.length, 3, "declaration and two calls");
    assert.ok(references.some((l) => l.uri.toString() === source.uri.toString()));
  });

  it("renames only this file's module when it declares one of the same name", async () => {
    const source = await openContent("module Greet {\n}\ncall Greet;\n");
    const counts = await renameEditCounts(source, "call Greet", 6, "Welcome");
    assert.deepEqual([...counts], [["<untitled>", 2]]);
    // While open, this second `module Greet` makes main.otter's ambiguous to
    // the other tests' calls.
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  it("refuses an invalid or already-used name", async () => {
    const source = await openContent("set $a = 1;\nset $b = 2;\n");
    await assert.rejects(rename(source, "$a", 1, "1bad"), /isn't a valid variable name/);
    await assert.rejects(rename(source, "$a", 1, "b"), /already used/);
  });

  it("goes to a variable's assignments, and nowhere for a variable that is only read", async () => {
    const source = await openContent("set $count = 1;\nset $count = 2;\nLog-Information $count $PackageName;\n");
    /** @type {(vscode.Location | vscode.LocationLink)[]} */
    const results = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider", source.uri, positionOf(source, "Information $count", 14)
    );
    const lines = results.map((l) => ("targetRange" in l ? l.targetRange : l.range).start.line).sort();
    assert.deepEqual(lines, [0, 1]);

    /** @type {unknown[]} */
    const none = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider", source.uri, positionOf(source, "$PackageName", 2)
    );
    assert.deepEqual(none, []);
  });

  it("finds a module's declaration and both calls", async () => {
    /** @type {vscode.Location[]} */
    const references = await vscode.commands.executeCommand(
      "vscode.executeReferenceProvider", document.uri, positionOf(document, "module Greet", 8)
    );
    // Calls in the other tests' open documents count too.
    assert.equal(references.filter((l) => l.uri.toString() === document.uri.toString()).length, 3);
  });

  it("lists the module in the outline", async () => {
    /** @type {(vscode.DocumentSymbol | vscode.SymbolInformation)[]} */
    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
    assert.ok(symbols.some((symbol) => symbol.name === "Greet"));
  });

  it("finds the module with Go to Symbol in Workspace", async () => {
    const symbols = await waitFor(async () => {
      /** @type {vscode.SymbolInformation[]} */
      const found = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "Greet");
      return found.length > 0 && found;
    }, "the workspace symbol index");
    assert.ok(symbols.some((symbol) => symbol.name === "Greet" && symbol.location.uri.fsPath.endsWith("main.otter")));
  });

  it("shows a reference count above the module", async () => {
    /** @type {vscode.CodeLens[]} */
    const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", document.uri, 10);
    const lens = lenses.find((l) => l.range.start.line === declarationLine());
    assert.equal(lens?.command?.title, "2 references");
  });

  it("folds #region blocks and { } blocks", async () => {
    /** @type {vscode.FoldingRange[]} */
    const ranges = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", document.uri);
    const regionLine = positionOf(document, "#region Loop").line;
    assert.ok(ranges.some((r) => r.start === regionLine && r.kind === vscode.FoldingRangeKind.Region), "#region");
    assert.ok(ranges.some((r) => r.start === declarationLine()), "module body");
  });

  /**
   * Highlights at a position, as `line:character:kind` with kind `w`/`r`.
   *
   * @param {vscode.Position} position
   * @returns {Promise<string[]>}
   */
  async function highlights(position) {
    /** @type {vscode.DocumentHighlight[] | undefined} */
    const found = await vscode.commands.executeCommand("vscode.executeDocumentHighlights", document.uri, position);
    return (found ?? [])
      .map((h) => `${h.range.start.line}:${h.range.start.character}:${h.kind === vscode.DocumentHighlightKind.Write ? "w" : "r"}`)
      .sort();
  }

  it("highlights every use of a variable, including inside strings", async () => {
    const at = (/** @type {string} */ needle, offset = 0) => positionOf(document, needle, offset);
    const set = at("$greeting =");
    const inString = at("$greeting world");
    const inCall = at("name: $greeting", 6);
    const expected = [
      `${set.line}:${set.character}:w`,
      `${inString.line}:${inString.character}:r`,
      `${inCall.line}:${inCall.character}:r`,
    ].sort();
    assert.deepEqual(await highlights(at("$greeting =", 3)), expected);
  });

  it("highlights a module's declaration and calls", async () => {
    const found = await highlights(positionOf(document, "call Greet(name: world", 6));
    assert.equal(found.length, 3);
    assert.equal(found.filter((h) => h.endsWith(":w")).length, 1);
  });
});

describe("highlighting braced variable names", () => {
  after(closeAllEditors);

  it("highlights ${name with spaces} and @{name} forms from the cursor", async () => {
    const document = await openContent("set ${my var} = 1;\nLog ${my var};\nforeach $i in @{list} {}\nset @list = @(1);\n");
    /** @type {vscode.DocumentHighlight[] | undefined} */
    const braced = await vscode.commands.executeCommand(
      "vscode.executeDocumentHighlights", document.uri, positionOf(document, "Log ${my var}", 8)
    );
    assert.equal(braced?.length, 2);

    /** @type {vscode.DocumentHighlight[] | undefined} */
    const list = await vscode.commands.executeCommand(
      "vscode.executeDocumentHighlights", document.uri, positionOf(document, "@{list}", 3)
    );
    assert.equal(list?.length, 2);
  });
});

describe("documents that aren't files on disk", () => {
  afterEach(closeAllEditors);

  /**
   * The URI schemes of the workspace symbols named `name`.
   *
   * @param {string} name
   * @returns {Promise<string[]>}
   */
  async function symbolSchemes(name) {
    /** @type {vscode.SymbolInformation[]} */
    const found = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", name);
    return found.filter((s) => s.name === name).map((s) => s.location.uri.scheme);
  }

  it("a read-only review/diff view gets no diagnostics and no workspace symbols", async () => {
    // "pr" is one of the read-only view schemes (the old side of a Git diff
    // uses "git", which the built-in Git extension already owns here).
    const registration = vscode.workspace.registerTextDocumentContentProvider("pr", {
      provideTextDocumentContent: () => "module ReviewOnly {\n}\nif count == 1 {\n}\n",
    });
    try {
      let document = await vscode.workspace.openTextDocument(vscode.Uri.parse("pr:/review.otter"));
      document = await vscode.languages.setTextDocumentLanguage(document, "otterscript");
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("otterscript.refreshDiagnostics", document.uri);

      assert.deepEqual(otterDiagnostics(document), []);
      assert.deepEqual(await symbolSchemes("ReviewOnly"), []);
    } finally {
      registration.dispose();
    }
  });

  it("Go to Symbol in Workspace follows unsaved edits to an open document", async () => {
    await openContent("module BeforeRename {\n}\n");
    await waitFor(async () => (await symbolSchemes("BeforeRename")).length === 1, "the module in the index");

    const editor = /** @type {vscode.TextEditor} */ (vscode.window.activeTextEditor);
    const name = positionOf(editor.document, "BeforeRename");
    await editor.edit((edit) => edit.replace(new vscode.Range(name, name.translate(0, "BeforeRename".length)), "AfterRename"));

    await waitFor(async () => (await symbolSchemes("AfterRename")).length === 1, "the renamed module in the index");
    assert.deepEqual(await symbolSchemes("BeforeRename"), []);
  });

  it("an untitled document's modules leave Go to Symbol in Workspace when it closes", async () => {
    await openContent("module UntitledOnly {\n}\n");
    assert.deepEqual(await symbolSchemes("UntitledOnly"), ["untitled"]);

    await closeAllEditors();
    await waitFor(async () => (await symbolSchemes("UntitledOnly")).length === 0, "the untitled module to leave the index");
  });
});
