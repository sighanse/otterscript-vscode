// @ts-check
/**
 * @fileoverview Unit tests for the module-navigation surface of src/document-index.js
 * (`getModuleInfo` and friends): declaration discovery, `call` reference
 * discovery, raft-qualified calls, and the per-document-version cache --
 * plus the matching per-version cache of the variable index used by
 * highlight all occurrences.
 *
 * Guards the behavior before/after `getModuleInfo` is refactored to reuse
 * `scanner.findModuleDeclarations`.
 *
 * Requires the vscode stub before document-index.js loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { makeDocument } = require("./fake-document");
const {
  getModuleDeclarations,
  findModuleReferences,
  findModuleDeclarationRange,
  getModuleCallReferencesByName,
  clearDocumentCaches,
  getDocumentVariables,
  getVariableAt,
  getVariableOccurrences,
} = require("../../src/document-index.js");
const { Position } = require("../vscode-stub");
/**
 * A stub Position, typed loosely so it can stand in for vscode's.
 *
 * @param {number} line
 * @param {number} character
 * @returns {any}
 */
const pos = (line, character) => new Position(line, character);

/**
 * A fake `vscode.TextDocument` (see fake-document.js), each with its own URI.
 *
 * @param {string} text
 * @param {number} [version]
 * @returns {any}
 */
const makeDoc = (text, version = 1) => makeDocument(text, { version });

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
  it("returns all call references grouped by name (case-insensitively)", () => {
    const map = getModuleCallReferencesByName(makeDoc(["call A;", "call B;", "call a;"].join("\n")));
    assert.equal(map.get("a")?.length, 2);
    assert.equal(map.get("b")?.length, 1);
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

  it("clearDocumentCaches forces a fresh scan for a uri", () => {
    const doc = makeDoc("module A {\n}", 9);
    const first = getModuleDeclarations(doc);
    clearDocumentCaches(doc.uri);
    assert.notEqual(getModuleDeclarations(doc), first);
  });
});

// ============================================================
// getVariableOccurrences (per-version cache of the variable index)
// ============================================================

describe("getVariableAt", () => {
  it("returns the variable under the cursor with all its occurrences", () => {
    const doc = makeDoc("set $count = 1;\nLog $count;");
    const at = getVariableAt(doc, pos(1, 6));
    assert.ok(at?.isReference);
    assert.equal(at.name, "count");
    assert.deepEqual(at.occurrences.map((o) => [o.line, o.write]), [[0, true], [1, false]]);
  });

  it("marks a token that isn't a real reference, and returns null away from any variable", () => {
    const doc = makeDoc("# $count in a comment\nLog x;");
    assert.equal(getVariableAt(doc, pos(0, 4))?.isReference, false);
    assert.equal(getVariableAt(doc, pos(1, 1)), null);
  });
});

describe("getDocumentVariables", () => {
  it("lists each variable of a sigil once, named as first assigned", () => {
    const doc = makeDoc("set $MyVar = 1;\nLog $myvar;\nset @list = @(1);\nforeach %item in @maps { Log $(%item.x); }");
    const scalars = getDocumentVariables(doc, "$");
    assert.deepEqual(scalars.map((v) => [v.name, v.assigned, v.line]), [["MyVar", true, 0]]);
    assert.deepEqual(getDocumentVariables(doc, "@").map((v) => v.name).sort(), ["list", "maps"]);
    assert.deepEqual(getDocumentVariables(doc, "%").map((v) => [v.name, v.assigned]), [["item", true]]);
  });

  it("keeps a braced name's spaces", () => {
    assert.deepEqual(getDocumentVariables(makeDoc("set ${my var} = 1;"), "$").map((v) => v.name), ["my var"]);
  });
});

describe("getVariableOccurrences", () => {
  it("reuses the index while the document version is unchanged", () => {
    const doc = makeDoc("set $x = 1;\nLog $x;");
    const first = getVariableOccurrences(doc, "$", "x");
    assert.deepEqual(first.map((o) => o.line), [0, 1]);
    assert.equal(getVariableOccurrences(doc, "$", "X"), first, "same cached array, names ignore case");
    assert.deepEqual(getVariableOccurrences(doc, "@", "x"), []);
  });

  it("rebuilds the index when the version changes or the caches are cleared", () => {
    let text = "set $x = 1;";
    const doc = makeDoc(text);
    doc.getText = () => text;
    const first = getVariableOccurrences(doc, "$", "x");
    assert.equal(first.length, 1);

    text = "set $x = 1;\nLog $x;";
    assert.equal(getVariableOccurrences(doc, "$", "x"), first, "stale until the version changes");
    doc.version = 2;
    assert.equal(getVariableOccurrences(doc, "$", "x").length, 2);

    const cached = getVariableOccurrences(doc, "$", "x");
    clearDocumentCaches(doc.uri);
    assert.notEqual(getVariableOccurrences(doc, "$", "x"), cached);
  });
});

// ============================================================
// matchesQuery (Go to Symbol in Workspace)
// ============================================================

describe("matchesQuery", () => {
  const { matchesQuery } = require("../../src/providers/workspace-symbols.js");

  it("matches the query's characters in order, ignoring case and spaces", () => {
    assert.ok(matchesQuery("Deploy-Module", ""));
    assert.ok(matchesQuery("Deploy-Module", "deploy"));
    assert.ok(matchesQuery("Deploy-Module", "dpm"));
    assert.ok(matchesQuery("Deploy-Module", "DM"));
    assert.ok(matchesQuery("Deploy-Module", "dep mod"));
  });

  it("rejects characters missing or out of order", () => {
    assert.ok(!matchesQuery("Deploy-Module", "mdp"));
    assert.ok(!matchesQuery("Deploy-Module", "deployx"));
  });
});
