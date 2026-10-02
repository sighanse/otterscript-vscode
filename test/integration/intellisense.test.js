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
    assert.match(await hoverText(document, positionOf(document, "@Split", 2)), /@Split\(Text, Separator/);
  });

  it("documents the map form of FromJson", async () => {
    assert.match(await hoverText(document, positionOf(document, "%FromJson", 2)), /%FromJson\(json\)/);
  });

  it("documents an operation that only Inedo's generated reference describes", async () => {
    const reference = await openContent('Extract-ZipFile (Name: "a.zip");');
    const text = await hoverText(reference, positionOf(reference, "Extract-ZipFile", 3));
    assert.match(text, /Extracts a zip file/);
    assert.match(text, /From Inedo's/);
  });

  it("documents an operation's argument name, and lists the arguments on the operation", async () => {
    const source = await openContent('Copy-Files(\n    From: "a",\n    To: "b"\n);\n');
    assert.match(await hoverText(source, positionOf(source, "To:", 1)), /Argument of `Copy-Files`: `To` \(required, text\) - Target directory/);
    assert.equal(await hoverText(source, positionOf(source, '"b"', 1)), "", "not in a value");
    assert.match(await hoverText(source, positionOf(source, "Copy-Files", 2)), /\*\*Arguments:\*\*\n- `Include`/);
  });

  it("shows a called module's declaration and its comment, also from another workspace file", async () => {
    const local = await openContent("# Says hello.\n# Twice.\nmodule Hi<$who> {\n}\ncall Hi(who: x);\n");
    const text = await hoverText(local, positionOf(local, "call Hi", 6));
    assert.match(text, /module Hi<\$who>/);
    assert.match(text, /Says hello\. {2}\nTwice\./);
    const elsewhere = await openContent('call Greet(name: "x");\n');
    assert.match(await hoverText(elsewhere, positionOf(elsewhere, "Greet", 2)), /module Greet<\$name>[\s\S]*Declared in `main\.otter`/);
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

  it("notes when an entry isn't in the otterscript.product setting's product", async () => {
    const config = vscode.workspace.getConfiguration("otterscript");
    const source = await openContent("set $x = $ReleaseName;\n");
    const at = positionOf(source, "$ReleaseName", 2);
    try {
      assert.doesNotMatch(await hoverText(source, at), /Not in/, "nothing with 'any'");
      await config.update("product", "Otter", vscode.ConfigurationTarget.Global);
      assert.match(await hoverText(source, at), /Not in Otter:\*\* only in BuildMaster/);
    } finally {
      await config.update("product", undefined, vscode.ConfigurationTarget.Global);
    }
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
    // Not a one-line document: "Log-Inf" has a quick fix, and VS Code 1.85's
    // lightbulb reads the line below it unchecked ("Illegal value for lineNumber").
    const document = await openContent("Log-Inf\n");
    const labels = await completionLabels(document, positionOf(document, "Log-Inf", 7));
    assert.ok(labels.includes("Log-Information"));
  });

  it("offers built-in operations after Core::, but not after another namespace", async () => {
    const core = await openContent("Core::Log-Inf");
    assert.ok((await completionLabels(core, positionOf(core, "Log-Inf", 7))).includes("Log-Information"));
    const proget = await openContent("ProGet::Log-Inf");
    assert.ok(!(await completionLabels(proget, positionOf(proget, "Log-Inf", 7))).includes("Log-Information"));
  });

  it("offers the file's own variables after $, @ and %, but not the one being typed", async () => {
    const document = await openContent("set $myCount = 1;\nset @myList = @(1);\nforeach %myItem in @maps {\n}\nLog-Information $my");
    const scalars = await completionLabels(document, positionOf(document, "Information $my", 15), "$");
    assert.ok(scalars.includes("$myCount"), scalars.join(" "));
    assert.ok(!scalars.includes("$my"), "not the token being typed");
    const vectors = await completionLabels(document, positionOf(document, "set @myList", 5), "@");
    assert.ok(vectors.includes("@maps"));
    const maps = await completionLabels(document, positionOf(document, "foreach %", 9), "%");
    assert.ok(maps.includes("%myItem"));
  });

  it("offers module names after call, from this file and other workspace files", async () => {
    const document = await openContent("module LocalHelper {\n}\ncall ");
    const labels = await completionLabels(document, positionOf(document, "call ", 5));
    assert.ok(labels.includes("LocalHelper"), labels.join(" "));
    assert.ok(labels.includes("Greet"), "declared in the workspace's main.otter");
    assert.ok(!labels.includes("Log-Information"), "no operations after call");
  });

  it("leaves out what the otterscript.product setting's product doesn't have", async () => {
    const config = vscode.workspace.getConfiguration("otterscript");
    const document = await openContent("set $x = $Rel");
    const at = positionOf(document, "$Rel", 4);
    try {
      assert.ok((await completionLabels(document, at)).includes("$ReleaseName"), "BuildMaster's, offered with 'any'");
      await config.update("product", "ProGet", vscode.ConfigurationTarget.Global);
      const labels = await completionLabels(document, at);
      assert.ok(!labels.includes("$ReleaseName"), "BuildMaster-only, left out for ProGet");
      assert.ok(labels.includes("$ReleaseNumber"), "ProGet's own variable stays");
    } finally {
      await config.update("product", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("offers an operation's arguments inside its call, leaving out the ones given", async () => {
    const document = await openContent('Copy-Files(\n    From: "a",\n    \n);\n');
    const labels = await completionLabels(document, new vscode.Position(2, 4));
    assert.ok(labels.includes("To") && labels.includes("Include"), labels.join(" "));
    assert.ok(!labels.includes("From"), "already given");
    assert.ok(!labels.includes("Log-Information"), "no operations in an argument list");

    const opened = await openContent("Copy-Files(");
    assert.ok((await completionLabels(opened, positionOf(opened, "(", 1), "(")).includes("To"), "on '('");
    const fn = await openContent("set $s = $Substring(");
    assert.deepEqual(await completionLabels(fn, positionOf(fn, "(", 1), "("), [], "nothing for a function's '('");
  });

  it("offers Adaptive Card values inside a card in a text template", async () => {
    const document = await openContent(
      "<% if $Notify { %>\n" +
      '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "weight": "" } ] }\n' +
      "<% } %>\n"
    );
    const weights = await completionLabels(document, positionOf(document, '"weight": "', 11), '"');
    assert.deepEqual(weights, ["default", "lighter", "bolder"]);
    const types = await completionLabels(document, positionOf(document, '"TextBlock"', 1), '"');
    assert.ok(types.includes("TextBlock") && !types.includes("Table"), types.join(" "));
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
    assert.equal(help.signatures[0].label, "$Substring(Text, Offset, [Length])");
    assert.equal(help.activeParameter, 2);
  });

  it("still finds the outer call after a nested call or a '(' in a string", async () => {
    for (const source of ["set $s = $Substring($Trim($x), ", 'set $s = $Substring("a(b", ']) {
      const document = await openContent(source);
      const help = await signatureHelp(document, document.positionAt(source.length));
      assert.equal(help?.signatures[0].label, "$Substring(Text, Offset, [Length])", source);
      assert.equal(help?.activeParameter, 1, source);
    }
  });

  it("works for the map form of FromJson", async () => {
    const document = await openContent("set %m = %FromJson(");
    const help = await signatureHelp(document, positionOf(document, "%FromJson(", 10));
    assert.equal(help?.signatures[0].label, "%FromJson(json)");
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
