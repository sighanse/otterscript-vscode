// @ts-check
/**
 * @fileoverview Unit tests for src/diagnostics.js.
 *
 * Focused on the "unknown namespace" check (`Frobnicate::Do-Thing`). The rest of
 * updateDiagnostics is exercised indirectly through the helpers tests; add cases
 * here as those checks are touched.
 *
 * Requires the vscode stub before diagnostics.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position, DiagnosticSeverity } = require("../vscode-stub");
const { updateDiagnostics } = require("../../src/diagnostics.js");
const { createRegexPatterns, NON_VARIABLE_IDENTIFIERS } = require("../../src/helpers.js");
const data = require("../../src/language-data.js");

const ctx = {
  nonVariableIdentifiers: NON_VARIABLE_IDENTIFIERS,
  knownKeywords: new Set(Object.keys(data.keywordDocs)),
  knownScalarFunctions: new Set(Object.keys(data.scalarFunctionDocs)),
  knownVectorFunctions: new Set(Object.keys(data.vectorFunctionDocs)),
  knownOperations: new Set(Object.keys(data.operationDocs)),
  knownNamespaces: data.NAMESPACES,
  ...createRegexPatterns(new Set(Object.keys(data.operationDocs))),
};

/**
 * Runs updateDiagnostics over `source` and returns the collected diagnostics.
 *
 * @param {string} source
 * @returns {any[]}
 */
function diagnose(source) {
  const lines = source.split("\n");
  /** @param {{ line: number, character: number }} p */
  const offsetAt = (p) => {
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  };
  const document = /** @type {any} */ ({
    languageId: "otterscript",
    uri: { toString: () => "file:///test.otter" },
    lineCount: lines.length,
    getText: () => source,
    lineAt: (/** @type {number} */ i) => ({ text: lines[i] }),
    offsetAt,
    positionAt: (/** @type {number} */ offset) => {
      let remaining = Math.max(0, offset);
      let line = 0;
      while (line < lines.length - 1 && remaining > lines[line].length) {
        remaining -= lines[line].length + 1;
        line++;
      }
      return new Position(line, remaining);
    },
  });
  /** @type {any[]} */
  let collected = [];
  const collection = /** @type {any} */ ({
    set: (/** @type {unknown} */ _uri, /** @type {any[]} */ issues) => { collected = issues; },
  });
  updateDiagnostics(document, collection, ctx);
  return collected;
}

/** @param {string} source */
const namespaceIssues = (source) =>
  diagnose(source).filter((d) => d.code === "unknown-namespace");

describe("updateDiagnostics — unknown namespace", () => {
  it("flags a qualifier whose namespace is not known", () => {
    const issues = namespaceIssues("Frobnicate::Do-Thing xyz;");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].message, "Unknown namespace 'Frobnicate'");
    assert.equal(issues[0].severity, DiagnosticSeverity.Warning);
    assert.equal(issues[0].source, "OtterScript");
    assert.equal(issues[0].range.start.line, 0);
    assert.equal(issues[0].range.start.character, 0);
    assert.equal(issues[0].range.end.character, "Frobnicate".length);
  });

  it("does not flag a known namespace", () => {
    assert.deepEqual(namespaceIssues("ProGet::Create-Directory foo (Path: bar);"), []);
  });

  it("does not flag a known namespace written in a different case", () => {
    assert.deepEqual(namespaceIssues("proget::Install-Package (Name: x);"), []);
  });

  it("does not flag a raft-qualified module call ('call Raft::Module')", () => {
    assert.deepEqual(namespaceIssues("call MyRaft::DeployApp;"), []);
  });

  it("does not flag text inside a string literal", () => {
    assert.deepEqual(namespaceIssues('Log-Information "see Bogus::Thing for details";'), []);
  });

  it("flags each distinct unknown namespace on a line", () => {
    const issues = namespaceIssues("Windoze::Sign-Exe (); Frob::Do ();");
    assert.deepEqual(issues.map((d) => d.message).sort(), [
      "Unknown namespace 'Frob'",
      "Unknown namespace 'Windoze'",
    ]);
  });

  it("does not also report the operation half of an unknown-namespace qualifier", () => {
    const all = diagnose("Frobnicate::Do-Thing xyz;");
    assert.deepEqual(all.map((d) => d.code), ["unknown-namespace"]);
  });

  it("still reports an unknown operation under a known namespace", () => {
    const codes = diagnose("ProGet::Totally-Made-Up ();").map((d) => d.code);
    assert.ok(codes.includes("unknown-operation"));
    assert.ok(!codes.includes("unknown-namespace"));
  });
});
