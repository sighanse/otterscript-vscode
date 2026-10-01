// @ts-check
/**
 * @fileoverview Integration tests for the diagnostics pipeline as VS Code runs
 * it: diagnostics published for opened files, the otterscript.diagnostics.rules
 * setting, quick fixes, and the Fix All command.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");
const {
  SAMPLES_DIR,
  closeAllEditors,
  codeOf,
  openContent,
  openFile,
  otterDiagnostics,
  positionOf,
  waitFor,
} = require("./helpers");

/**
 * Re-runs diagnostics for a document right away (skipping the typing
 * debounce) and returns the OtterScript ones. The refresh command awaits the
 * scan, so the result is final when it returns.
 *
 * @param {vscode.TextDocument} document
 * @returns {Promise<vscode.Diagnostic[]>}
 */
async function refreshDiagnostics(document) {
  await vscode.commands.executeCommand("otterscript.refreshDiagnostics", document.uri);
  return otterDiagnostics(document);
}

/**
 * Sets `otterscript.diagnostics.rules` in the test workspace's settings;
 * `undefined` removes it.
 *
 * @param {Record<string, string> | undefined} rules
 * @returns {Promise<void>}
 */
async function setRules(rules) {
  await vscode.workspace
    .getConfiguration("otterscript")
    .update("diagnostics.rules", rules, vscode.ConfigurationTarget.Workspace);
}

/**
 * The quick fixes offered for a diagnostic.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {Thenable<vscode.CodeAction[]>}
 */
function quickFixes(document, diagnostic) {
  return vscode.commands.executeCommand(
    "vscode.executeCodeActionProvider", document.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value
  );
}

describe("diagnostics", () => {
  afterEach(closeAllEditors);

  it("publishes the documented number of diagnostics for the sample files", async () => {
    // Same counts as test/unit/fixtures.test.js, but through VS Code itself.
    for (const [file, expected] of [
      ["sample.otter", 18],
      ["sample-valid.otter", 0],
      ["sample-template.otter", 13],
      ["sample-template-valid.otter", 0],
      ["sample-card-version.otter", 5],
    ]) {
      const document = await openFile(path.join(SAMPLES_DIR, /** @type {string} */ (file)));
      assert.equal((await refreshDiagnostics(document)).length, expected, /** @type {string} */ (file));
    }
  });

  it("updates diagnostics after an edit", async () => {
    const document = await openContent("Log-Information \"ok\";\n");
    assert.equal((await refreshDiagnostics(document)).length, 0);

    const editor = /** @type {vscode.TextEditor} */ (vscode.window.activeTextEditor);
    await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), "Log-InformatZZion \"x\";\n"));

    const [diagnostic] = await waitFor(
      () => {
        const found = otterDiagnostics(document);
        return found.length > 0 && found;
      },
      "the unknown-operation diagnostic after the edit"
    );
    assert.equal(codeOf(diagnostic), "unknown-operation");
  });
});

describe("otterscript.diagnostics.rules", () => {
  afterEach(async () => {
    await setRules(undefined);
    await closeAllEditors();
  });

  const source = "Log-InformatZZion \"x\";\nif count == 1 {\n}\n";

  it("hides a diagnostic set to off and restores it when the rule is removed", async () => {
    const document = await openContent(source);
    assert.deepEqual((await refreshDiagnostics(document)).map(codeOf).sort(), ["missing-dollar", "unknown-operation"]);

    await setRules({ "unknown-operation": "off" });
    await waitFor(
      () => otterDiagnostics(document).map(codeOf).join() === "missing-dollar",
      "unknown-operation to disappear"
    );

    await setRules(undefined);
    await waitFor(() => otterDiagnostics(document).length === 2, "unknown-operation to come back");
  });

  it("changes the severity of a diagnostic", async () => {
    const document = await openContent(source);
    await setRules({ "missing-dollar": "hint" });
    const diagnostic = await waitFor(
      () => otterDiagnostics(document).find((d) => codeOf(d) === "missing-dollar" && d.severity === vscode.DiagnosticSeverity.Hint),
      "missing-dollar to become a hint"
    );
    assert.ok(diagnostic);
  });

  it("the 'Turn off' quick fix writes the rule to workspace settings", async () => {
    const document = await openContent(source);
    const diagnostic = (await refreshDiagnostics(document)).find((d) => codeOf(d) === "unknown-operation");
    assert.ok(diagnostic);

    const turnOff = (await quickFixes(document, diagnostic)).find((a) => a.title.startsWith("Turn off 'unknown-operation'"));
    assert.ok(turnOff?.command, "the quick fix is offered");
    await vscode.commands.executeCommand(turnOff.command.command, ...(turnOff.command.arguments ?? []));

    const inspected = vscode.workspace.getConfiguration("otterscript").inspect("diagnostics.rules");
    assert.deepEqual(inspected?.workspaceValue, { "unknown-operation": "off" });
    await waitFor(() => !otterDiagnostics(document).some((d) => codeOf(d) === "unknown-operation"), "the diagnostic to disappear");
  });
});

describe("quick fixes", () => {
  afterEach(closeAllEditors);

  it("offers and applies the missing-$ fix", async () => {
    const document = await openContent("if count == 1 {\n}\n");
    const [diagnostic] = await refreshDiagnostics(document);
    assert.equal(codeOf(diagnostic), "missing-dollar");

    const fix = (await quickFixes(document, diagnostic)).find((a) => a.title === "Insert missing '$'");
    assert.ok(fix?.edit, "the fix is offered");
    await vscode.workspace.applyEdit(fix.edit);
    assert.equal(document.lineAt(0).text, "if $count == 1 {");
  });

  it("Fix All works on the text as it is now, not on diagnostics from before an edit", async () => {
    const document = await openContent("if count == 1 {\n}\n");
    assert.equal((await refreshDiagnostics(document)).length, 1);

    // Shift the line, then run Fix All at once -- before the debounced
    // diagnostics run would have caught up with the edit.
    const editor = /** @type {vscode.TextEditor} */ (vscode.window.activeTextEditor);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "# note\n"));
    await vscode.commands.executeCommand("otterscript.fixAll");
    assert.equal(document.getText(), "# note\nif $count == 1 {\n}\n");
  });

  it("Fix All fixes every fixable diagnostic in one step", async () => {
    const document = await openContent("if count == 1 {\n}\nif $a & $b {\n}\n");
    assert.equal((await refreshDiagnostics(document)).length, 2);

    await vscode.commands.executeCommand("otterscript.fixAll");
    assert.equal(document.getText(), "if $count == 1 {\n}\nif $a && $b {\n}\n");
    assert.equal((await refreshDiagnostics(document)).length, 0);
  });

  it("'Change card version' raises the card version to what the card needs", async () => {
    const document = await openFile(path.join(SAMPLES_DIR, "sample-card-version.otter"));
    const diagnostics = await refreshDiagnostics(document);
    assert.equal(diagnostics.length, 5);

    const fix = (await quickFixes(document, diagnostics[0])).find((a) => a.title === "Change card version to 1.5");
    assert.ok(fix?.edit, "the fix is offered");
    // The edit is never saved: afterEach reverts and closes the editor.
    await vscode.workspace.applyEdit(fix.edit);
    assert.ok(document.lineAt(positionOf(document, "\"version\": \"").line).text.includes("\"1.5\""));
    assert.equal((await refreshDiagnostics(document)).length, 0);
  });

  it("'Change to' replaces an Adaptive Card value that isn't allowed", async () => {
    const document = await openContent(
      "<% if $Notify { %>\n" +
      '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "weight": "bold" } ] }\n' +
      "<% } %>\n"
    );
    const [diagnostic] = await refreshDiagnostics(document);
    assert.equal(diagnostic?.code, "adaptivecard-invalid-value");

    const fix = (await quickFixes(document, diagnostic)).find((a) => a.title === "Change to 'bolder'");
    assert.ok(fix?.edit, "the fix is offered");
    await vscode.workspace.applyEdit(fix.edit);
    assert.ok(document.lineAt(1).text.includes('"weight": "bolder"'));
    assert.equal((await refreshDiagnostics(document)).length, 0);
  });
});
