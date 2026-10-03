// @ts-check
/**
 * @fileoverview Unit tests for the parameter-name inlay hints
 * (src/providers/inlay-hints.js): where each hint goes and which arguments
 * get none.
 *
 * Requires the vscode stub before the provider module (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { findParameterNameHints } = require("../../src/providers/inlay-hints.js");

/**
 * `text` with each hint written in at its place, `‹Name:›`.
 *
 * @param {string} text
 * @returns {string}
 */
function withHints(text) {
  let out = text;
  for (const { offset, label } of findParameterNameHints(text).reverse()) {
    out = `${out.slice(0, offset)}‹${label}›${out.slice(offset)}`;
  }
  return out;
}

describe("findParameterNameHints", () => {
  it("names each positional argument, before strings and nested calls too", () => {
    assert.equal(withHints("set $s = $Substring($x, 2, 3);"), "set $s = $Substring(‹Text:›$x, ‹Offset:›2, ‹Length:›3);");
    assert.equal(withHints('set $s = $Substring("a,b", $Len($y), 1);'),
      'set $s = $Substring(‹Text:›"a,b", ‹Offset:›$Len($y), ‹Length:›1);');
  });

  it("names no argument that is already a variable of that name, nor past a ... tail", () => {
    assert.equal(withHints("set $s = $Substring($Text, ${offset});"), "set $s = $Substring($Text, ${offset});");
    assert.equal(withHints('set $p = $PathCombine("a", "b", "c");'), 'set $p = $PathCombine(‹Path1:›"a", ‹Path2:›"b", "c");');
  });

  it("leaves out one-parameter functions, unknown ones, comments and template literal text", () => {
    assert.equal(withHints("set $j = $ToJson($x);\nset $t = $Trim($x, \"-\");\nset $f = $Frob(1, 2);"),
      "set $j = $ToJson($x);\nset $t = $Trim($x, \"-\");\nset $f = $Frob(1, 2);");
    assert.equal(withHints("# $Substring($x, 1)"), "# $Substring($x, 1)");
    assert.equal(withHints('<% set $x = $Substring($y, 1); %>\n{ "a": "b" }'), '<% set $x = $Substring(‹Text:›$y, ‹Offset:›1); %>\n{ "a": "b" }');
  });

  it("puts a hint before the argument, not before a comment in front of it", () => {
    assert.equal(withHints("set $s = $Substring(\n  # the text\n  $x,\n  /* from */ 1);"),
      "set $s = $Substring(\n  # the text\n  ‹Text:›$x,\n  /* from */ ‹Offset:›1);");
    assert.equal(withHints("set $s = $Substring(\n  # just $Text\n  $Text, 1);"),
      "set $s = $Substring(\n  # just $Text\n  $Text, ‹Offset:›1);", "a commented variable of the name still counts as named");
  });

  it("stops an unclosed call at its statement", () => {
    assert.equal(withHints('set $s = $Substring($x,\nLog-Information "a, b";'), 'set $s = $Substring(‹Text:›$x,\nLog-Information "a, b";');
  });
});
