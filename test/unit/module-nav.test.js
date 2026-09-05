// @ts-check
/**
 * @fileoverview Unit tests for the module-navigation surface of src/helpers.js
 * (`getModuleInfo` and friends): declaration discovery, `call` reference
 * discovery, raft-qualified calls, and the per-document-version cache.
 *
 * Guards the behaviour before/after `getModuleInfo` is refactored to reuse
 * `scanner.findModuleDeclarations`.
 *
 * Requires the vscode stub before helpers.js loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position, Range } = require("../vscode-stub");
const {
  getModuleDeclarations,
  findModuleReferences,
  findModuleDeclarationRange,
  getModuleCallReferencesByName,
  clearModuleInfoCache,
} = require("../../src/helpers.js");

let nextDocId = 0;

/**
 * Minimal `vscode.TextDocument` stand-in for the module-nav helpers.
 *
 * @param {string} text
 * @param {number} [version]
 * @returns {any}
 */
function makeDoc(text, version = 1) {
  const lines = text.split("\n");
  const uriString = `file:///module-nav-${nextDocId++}.otter`;
  return {
    version,
    uri: { toString: () => uriString },
    lineCount: lines.length,
    getText: () => text,
    /** @param {number} i */
    lineAt: (i) => ({
      text: lines[i],
      range: new Range(new Position(i, 0), new Position(i, lines[i].length)),
    }),
  };
}

// ============================================================
// getModuleDeclarations
// ============================================================

describe("getModuleDeclarations", () => {
  it("returns each declaration with a name range and a full-line range", () => {
    const doc = makeDoc(["Log-Information 'x';", "module DeployApp {", "}"].join("\n"));
    const decls = getModuleDeclarations(doc);
    assert.equal(decls.length, 1);
    assert.equal(decls[0].name, "DeployApp");
    assert.equal(decls[0].range.start.line, 1);
    assert.equal(decls[0].range.start.character, 7);
    assert.equal(decls[0].range.end.character, 7 + "DeployApp".length);
    assert.equal(decls[0].lineRange.start.line, 1);
    assert.equal(decls[0].lineRange.end.character, "module DeployApp {".length);
  });

  it("finds multiple declarations and preserves order", () => {
    const doc = makeDoc(["module A {", "}", "  module Be-Two {", "}"].join("\n"));
    assert.deepEqual(
      getModuleDeclarations(doc).map((d) => [d.name, d.range.start.line, d.range.start.character]),
      [["A", 0, 7], ["Be-Two", 2, 9]]
    );
  });

  it("ignores 'module' text inside strings and comments", () => {
    const doc = makeDoc(['$s = "module Nope";', "# module AlsoNope", "module Real {"].join("\n"));
    assert.deepEqual(getModuleDeclarations(doc).map((d) => d.name), ["Real"]);
  });
});

// ============================================================
// findModuleDeclarationRange
// ============================================================

describe("findModuleDeclarationRange", () => {
  it("returns the name range for a known module, null otherwise", () => {
    const doc = makeDoc("module Widget {\n}");
    const range = findModuleDeclarationRange(doc, "Widget");
    assert.ok(range);
    assert.equal(range.start.line, 0);
    assert.equal(range.start.character, 7);
    assert.equal(findModuleDeclarationRange(doc, "Nonexistent"), null);
  });
});

// ============================================================
// findModuleReferences
// ============================================================

describe("findModuleReferences", () => {
  const source = [
    "module Helper {",       // 0
    "}",                     // 1
    "call Helper;",          // 2
    "call MyRaft::Helper;",  // 3 raft-qualified
    "Log-Information 'call Helper';", // 4 inside string -> not a ref
  ].join("\n");

  it("finds every call site, excluding the declaration by default", () => {
    const refs = findModuleReferences(makeDoc(source), "Helper", false);
    assert.deepEqual(refs.map((r) => r.range.start.line).sort(), [2, 3]);
  });

  it("includes the declaration when asked", () => {
    const refs = findModuleReferences(makeDoc(source), "Helper", true);
    assert.deepEqual(refs.map((r) => r.range.start.line).sort(), [0, 2, 3]);
  });

  it("points the range at the module name, not the 'call' keyword or raft prefix", () => {
    const refs = findModuleReferences(makeDoc(source), "Helper", false);
    const line3 = refs.find((r) => r.range.start.line === 3);
    assert.ok(line3);
    assert.equal(line3.range.start.character, "call MyRaft::".length);
    assert.equal(line3.range.end.character, "call MyRaft::".length + "Helper".length);
  });

  it("returns nothing for an unreferenced module", () => {
    assert.deepEqual(findModuleReferences(makeDoc(source), "Ghost", true), []);
  });
});

// ============================================================
// getModuleCallReferencesByName
// ============================================================

describe("getModuleCallReferencesByName", () => {
  const doc = makeDoc(["call A;", "call B;", "call A;"].join("\n"));

  it("returns all call references grouped by name when unfiltered", () => {
    const map = getModuleCallReferencesByName(doc);
    assert.equal(map.get("A")?.length, 2);
    assert.equal(map.get("B")?.length, 1);
  });

  it("filters to the requested names", () => {
    const map = getModuleCallReferencesByName(doc, new Set(["A"]));
    assert.deepEqual([...map.keys()], ["A"]);
  });
});

// ============================================================
// per-document-version cache
// ============================================================

describe("module info cache", () => {
  it("reuses the analysis for the same document version", () => {
    const doc = makeDoc("module A {\n}", 5);
    assert.equal(getModuleDeclarations(doc), getModuleDeclarations(doc), "same array instance on a cache hit");
  });

  it("re-scans when the document version changes", () => {
    const doc = makeDoc("module A {\n}", 1);
    const first = getModuleDeclarations(doc);
    doc.version = 2;
    const second = getModuleDeclarations(doc);
    assert.notEqual(first, second);
    assert.deepEqual(second.map((d) => d.name), ["A"]);
  });

  it("clearModuleInfoCache forces a fresh scan for a uri", () => {
    const doc = makeDoc("module A {\n}", 9);
    const first = getModuleDeclarations(doc);
    clearModuleInfoCache(doc.uri);
    assert.notEqual(getModuleDeclarations(doc), first);
  });
});
