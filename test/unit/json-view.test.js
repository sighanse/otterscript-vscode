// @ts-check
/**
 * @fileoverview Unit tests for src/json-view.js -- the error-tolerant, one-pass
 * view of JSON text the Adaptive Card checks are built on. vscode-free.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeJson,
  findJsonStringTokens,
  findStringProperties,
  hasOwnKeyProperty,
  valueStartAfterKey,
  scanJsonPrefix,
} = require("../../src/json-view.js");

describe("findJsonStringTokens", () => {
  it("keeps an escaped quote inside its string", () => {
    const tokens = findJsonStringTokens(String.raw`{ "a": "say \"hi\"" }`);
    assert.deepEqual(tokens.map((t) => t.value), ["a", String.raw`say \"hi\"`]);
  });

  it("drops an unterminated string", () => {
    assert.deepEqual(findJsonStringTokens('{ "a": "open').map((t) => t.value), ["a"]);
  });
});

describe("analyzeJson", () => {
  it("records the innermost enclosing '{' of each token and matches brackets", () => {
    const text = '{ "a": { "b": [1, "}"] } }';
    const view = analyzeJson(text);
    const inner = text.indexOf("{", 1);
    assert.deepEqual(view.tokens.map((t) => t.value), ["a", "b", "}"]);
    assert.deepEqual(view.enclosing, [0, inner, inner]);
    assert.equal(view.closeOf.get(0), text.length - 1);
    assert.equal(view.closeOf.get(text.indexOf("[")), text.indexOf("]"));
  });
});

describe("key lookups", () => {
  const text = '{ "type": "x", "inner": { "version": 2 }, "note": "version" }';
  const view = analyzeJson(text);

  it("finds string-valued properties with the object they belong to", () => {
    assert.deepEqual(findStringProperties(view, "type").map((p) => [p.value, p.objectStart]), [["x", 0]]);
    assert.deepEqual(findStringProperties(view, "version"), [], "a number value isn't a string property");
  });

  it("tells a key from a string value with the same text", () => {
    const valueToken = view.tokens.find((t) => t.value === "version" && t.start > text.indexOf("note"));
    assert.ok(valueToken);
    assert.equal(valueStartAfterKey(text, valueToken), -1);
  });

  it("hasOwnKeyProperty only counts the root object's keys", () => {
    assert.equal(hasOwnKeyProperty(view, "type"), true);
    assert.equal(hasOwnKeyProperty(view, "version"), false);
  });
});

describe("scanJsonPrefix", () => {
  it("finds the containers still open and the unclosed string at the end", () => {
    const text = '{ "a": [ { "b": "x" }, "c\\"d';
    assert.deepEqual(scanJsonPrefix(text), { open: [0, 7], openString: text.indexOf('"c') });
  });

  it("skips brackets in strings and recovers from a stray closer", () => {
    assert.deepEqual(scanJsonPrefix('{ "}": [ ] ] '), { open: [0], openString: -1 });
  });
});
