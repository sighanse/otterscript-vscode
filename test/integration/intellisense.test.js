// @ts-check
/**
 * @fileoverview Integration tests for hover, completion and signature help,
 * called through VS Code's own `vscode.execute*Provider` commands.
 */

const assert = require("node:assert/strict");
const vscode = require("vscode");
const { closeAllEditors, openContent, positionOf } = require("./helpers");

/**
 * The hover text VS Code would show at a position, or "" when there is none.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Promise<string>}
 */
async function hoverText(document, position) {
  /** @type {vscode.Hover[]} */
  const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, position);
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === "string" ? content : content.value))
    .join("\n");
}

/**
 * The labels of the completion items this extension offers at a position.
 * Items are recognized by their `{ label, description }` label object, which
 * filters out VS Code's own word-based suggestions (plain-string labels drawn
 * from any open document).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {string} [triggerCharacter]
 * @returns {Promise<string[]>}
 */
async function completionLabels(document, position, triggerCharacter) {
  /** @type {vscode.CompletionList} */
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider", document.uri, position, triggerCharacter
  );
  return list.items.flatMap((item) => (typeof item.label === "string" ? [] : [item.label.label]));
}

/**
 * Signature help at a position.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {Thenable<vscode.SignatureHelp | undefined>}
 */
function signatureHelp(document, position) {
  return vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", document.uri, position, "(");
}

describe("hover", () => {
  after(closeAllEditors);

  /** @type {vscode.TextDocument} */
  let document;
  before(async () => {
    document = await openContent([
      "set $json = $ToJson(%(a: 1));",
      "set @parts = @Split(\"a,b\", \",\");",
      "set %map = %FromJson('{}');",
      "Log-Information \"done\";",
      "#region Setup",
      "# a comment mentioning $ToJson",
      "#endregion",
      "set $x = $constructor;",
      'Log-Information "#region in a string"; # #endregion in a comment',
    ].join("\n"));
  });

  it("documents a scalar function", async () => {
    assert.match(await hoverText(document, positionOf(document, "$ToJson(%", 2)), /\$ToJson\(data\)/);
  });

  it("documents a vector function", async () => {
    assert.match(await hoverText(document, positionOf(document, "@Split", 2)), /@Split\(text, separator/);
  });

  it("documents the map form of FromJson", async () => {
    assert.match(await hoverText(document, positionOf(document, "%FromJson", 2)), /%FromJson\(jsonString\)/);
  });

  it("documents an operation that only Inedo's generated reference describes", async () => {
    const reference = await openContent('Extract-ZipFile (Name: "a.zip");');
    const text = await hoverText(reference, positionOf(reference, "Extract-ZipFile", 3));
    assert.match(text, /Extracts a zip file/);
    assert.match(text, /From Inedo's/);
  });

  it("documents an operation", async () => {
    assert.match(await hoverText(document, positionOf(document, "Log-Information", 3)), /Log-Information/);
  });

  it("documents a #region directive, but only on the directive itself", async () => {
    assert.match(await hoverText(document, positionOf(document, "#region", 2)), /region/i);
    assert.equal(await hoverText(document, positionOf(document, "Setup", 1)), "");
  });

  it("documents #region only at the start of a line, not in a string or trailing comment", async () => {
    assert.equal(await hoverText(document, positionOf(document, '"#region in', 3)), "");
    assert.equal(await hoverText(document, positionOf(document, "# #endregion", 4)), "");
  });

  it("shows nothing for names that are only inherited Object members", async () => {
    assert.equal(await hoverText(document, positionOf(document, "$constructor", 2)), "");
  });

  it("shows nothing for a function name inside a comment", async () => {
    assert.equal(await hoverText(document, positionOf(document, "mentioning $ToJson", 13)), "");
  });
});

describe("completion", () => {
  after(closeAllEditors);

  it("offers scalar functions and variables after $", async () => {
    const document = await openContent("set $x = $");
    const labels = await completionLabels(document, positionOf(document, "= $", 3), "$");
    assert.ok(labels.includes("$ToJson"), "offers $ToJson");
    assert.ok(labels.includes("$Substring"), "offers $Substring");
  });

  it("narrows scalar functions to what has been typed", async () => {
    const document = await openContent("set $x = $ToJ");
    const labels = await completionLabels(document, positionOf(document, "$ToJ", 4));
    assert.ok(labels.includes("$ToJson"));
    assert.ok(!labels.includes("$Substring"));
  });

  it("offers vector functions after @", async () => {
    const document = await openContent("set @x = @");
    const labels = await completionLabels(document, positionOf(document, "= @", 3), "@");
    assert.ok(labels.includes("@Split"), "offers @Split");
    assert.ok(labels.includes("@FromJson"), "offers @FromJson");
  });

  it("offers map functions and the %( ) literal after %", async () => {
    const document = await openContent("set %x = %");
    const labels = await completionLabels(document, positionOf(document, "= %", 3), "%");
    assert.ok(labels.includes("%FromJson"), "offers %FromJson");
    assert.ok(labels.includes("%ListItem"), "offers %ListItem");
    assert.ok(labels.includes("Map Expression"), "offers the %( ) snippet");
  });

  it("offers operations and keywords by name", async () => {
    const document = await openContent("Log-Inf");
    const labels = await completionLabels(document, positionOf(document, "Log-Inf", 7));
    assert.ok(labels.includes("Log-Information"));
  });

  it("offers built-in operations after Core::, but not after another namespace", async () => {
    const core = await openContent("Core::Log-Inf");
    assert.ok((await completionLabels(core, positionOf(core, "Log-Inf", 7))).includes("Log-Information"));
    const proget = await openContent("ProGet::Log-Inf");
    assert.ok(!(await completionLabels(proget, positionOf(proget, "Log-Inf", 7))).includes("Log-Information"));
  });

  it("offers nothing from this extension inside a comment", async () => {
    const document = await openContent("# $");
    const labels = await completionLabels(document, positionOf(document, "# $", 3), "$");
    assert.ok(!labels.includes("$ToJson"));
  });
});

describe("signature help", () => {
  after(closeAllEditors);

  it("shows the signature and tracks the active parameter", async () => {
    const document = await openContent("set $s = $Substring($text, 2, ");
    const help = await signatureHelp(document, positionOf(document, "2, ", 3));
    assert.ok(help, "signature help is shown");
    assert.equal(help.signatures[0].label, "$Substring(text, startIndex, [length])");
    assert.equal(help.activeParameter, 2);
  });

  it("still finds the outer call after a nested call or a '(' in a string", async () => {
    for (const source of ["set $s = $Substring($Trim($x), ", 'set $s = $Substring("a(b", ']) {
      const document = await openContent(source);
      const help = await signatureHelp(document, document.positionAt(source.length));
      assert.equal(help?.signatures[0].label, "$Substring(text, startIndex, [length])", source);
      assert.equal(help?.activeParameter, 1, source);
    }
  });

  it("works for the map form of FromJson", async () => {
    const document = await openContent("set %m = %FromJson(");
    const help = await signatureHelp(document, positionOf(document, "%FromJson(", 10));
    assert.equal(help?.signatures[0].label, "%FromJson(jsonString)");
  });

  it("shows nothing outside a call", async () => {
    const document = await openContent("set $s = 1;");
    const help = await signatureHelp(document, positionOf(document, "1;", 1));
    assert.equal(help?.signatures.length ?? 0, 0);
  });
});

describe("snippets", () => {
  afterEach(closeAllEditors);

  /**
   * Inserts a snippet into a new document and returns the resulting text.
   *
   * @param {(editor: vscode.TextEditor) => Thenable<unknown>} insert
   * @returns {Promise<{ text: string, editor: vscode.TextEditor }>}
   */
  async function insertInto(insert) {
    const document = await openContent("");
    const editor = /** @type {vscode.TextEditor} */ (vscode.window.activeTextEditor);
    await insert(editor);
    return { text: document.getText().replace(/\r\n/g, "\n"), editor };
  }

  it("inserts completion snippets with their literal $ and } intact", async () => {
    const { operationDocs } = require("../../src/language-data.js");
    const powerShell = await insertInto((e) => e.insertSnippet(new vscode.SnippetString(operationDocs["Execute-PowerShell"].snippet)));
    assert.ok(powerShell.text.includes('Where-Object { $_.Status -eq "Running" } | Out-String'), powerShell.text);
    await closeAllEditors();

    const acquire = await insertInto((e) => e.insertSnippet(new vscode.SnippetString(operationDocs["Acquire-Server"].snippet)));
    assert.ok(acquire.text.includes("ServerName => $AcquiredServerName"), acquire.text);
  });

  it("a snippets-file snippet has only its intended tab stops", async () => {
    const { text, editor } = await insertInto(() =>
      vscode.commands.executeCommand("editor.action.insertSnippet", { langId: "otterscript", name: "If Match Regex" })
    );
    assert.ok(text.startsWith('if $MatchesRegex(text, "pattern") {'), text);

    const visited = [editor.document.getText(editor.selection)];
    for (let i = 0; i < 4; i++) {
      await vscode.commands.executeCommand("jumpToNextSnippetPlaceholder");
      visited.push(editor.document.getText(editor.selection));
    }
    assert.ok(!visited.includes("MatchesRegex"), `tab stops visited: ${JSON.stringify(visited)}`);
  });
});
