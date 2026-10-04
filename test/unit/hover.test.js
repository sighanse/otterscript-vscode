// @ts-check
/**
 * @fileoverview Unit tests for src/providers/hover.js. The hovers themselves
 * are tested in VS Code (test/integration/intellisense.test.js); here, the
 * markdown helper.
 *
 * Requires the vscode stub before hover.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { inlineCode } = require("../../src/providers/hover.js");

describe("inlineCode", () => {
  it("fences a name in one backtick", () => {
    assert.equal(inlineCode("scripts/main.otter"), "`scripts/main.otter`");
  });

  it("fences a name with backticks in more of them than its longest run", () => {
    assert.equal(inlineCode("a`b``c.otter"), "```a`b``c.otter```");
  });

  it("pads a name that starts or ends with a backtick", () => {
    assert.equal(inlineCode("`x.otter"), "`` `x.otter ``");
    assert.equal(inlineCode("x`"), "`` x` ``");
  });
});
