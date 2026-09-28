// @ts-check
/**
 * @fileoverview Integration tests: the extension loads and activates in a
 * real VS Code, and registers its commands.
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");
const { EXTENSION_ID, WORKSPACE_DIR, closeAllEditors, openFile } = require("./helpers");

describe("activation", () => {
  after(closeAllEditors);

  it("activates when an .otter file is opened", async () => {
    const document = await openFile(path.join(WORKSPACE_DIR, "main.otter"));
    assert.equal(document.languageId, "otterscript");
    assert.equal(vscode.extensions.getExtension(EXTENSION_ID)?.isActive, true);
  });

  it("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ["otterscript.fixAll", "otterscript.refreshDiagnostics", "otterscript.disableDiagnosticRule"]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
  });
});
