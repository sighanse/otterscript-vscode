// @ts-check
/**
 * @fileoverview Pins the diagnostic count of the manual-review `.otter`
 * fixtures used for eyeballing the Problems panel in a real editor.
 *
 * These files are otherwise only ever checked by hand, which is exactly how a
 * previous regression went unnoticed for multiple commits: a stray `<% %>`
 * pair in test/sample.otter and test/sample-valid.otter (added long before
 * template-aware diagnostics existed, for syntax-highlighting coverage) made
 * documentUsesTemplateTags() treat each whole file as a text template, which
 * blanks everything outside the tags -- silently zeroing out every other
 * diagnostic in the file with no error, no exception, nothing in any log.
 *
 * Requires the vscode stub before diagnostics.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position } = require("../vscode-stub");
const { updateDiagnostics, DIAGNOSTIC_CODES } = require("../../src/diagnostics.js");
const { createRegexPatterns, NON_VARIABLE_IDENTIFIERS, documentUsesTemplateTags } = require("../../src/helpers.js");
const data = require("../../src/language-data.js");

const ctx = {
  nonVariableIdentifiers: NON_VARIABLE_IDENTIFIERS,
  knownKeywords: new Set(Object.keys(data.keywordDocs)),
  knownScalarFunctions: new Set(Object.keys(data.scalarFunctionDocs)),
  knownVectorFunctions: new Set(Object.keys(data.vectorFunctionDocs)),
  scalarFunctionDocs: data.scalarFunctionDocs,
  vectorFunctionDocs: data.vectorFunctionDocs,
  mapFunctionDocs: data.mapFunctionDocs,
  knownOperations: new Set(Object.keys(data.operationDocs)),
  knownNamespaces: data.NAMESPACES,
  ...createRegexPatterns(new Set(Object.keys(data.operationDocs))),
};

/**
 * Runs updateDiagnostics over a fixture file's on-disk contents.
 *
 * @param {string} relativePath - Path under test/, e.g. "sample.otter"
 * @returns {any[]}
 */
function diagnoseFixture(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  const lines = source.split("\n");
  /** @param {{ line: number, character: number }} p */
  const offsetAt = (p) => {
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  };
  const document = /** @type {any} */ ({
    languageId: "otterscript",
    uri: { toString: () => `file:///${relativePath}` },
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

describe("manual-review fixtures", () => {
  it("sample.otter is NOT template-aware and flags exactly its documented tally", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), false);
    assert.equal(diagnoseFixture("sample.otter").length, 18);
  });

  it("sample-valid.otter is NOT template-aware and stays clean", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-valid.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), false);
    assert.deepEqual(diagnoseFixture("sample-valid.otter"), []);
  });

  it("sample-template.otter IS template-aware and flags exactly its documented tally", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-template.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.equal(diagnoseFixture("sample-template.otter").length, 13);
  });

  it("sample-card-version.otter IS template-aware and flags exactly its four version-too-low diagnostics", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-card-version.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    const found = diagnoseFixture("sample-card-version.otter");
    assert.deepEqual(found.map((d) => d.code), Array(4).fill("adaptivecard-version-too-low"));
  });

  it("every diagnostic in the error fixtures carries a code listed in DIAGNOSTIC_CODES", () => {
    // A code is what the otterscript.diagnostics.rules setting keys on, so a
    // check emitted without one could never be turned off.
    for (const fixture of ["sample.otter", "sample-template.otter", "sample-card-version.otter"]) {
      for (const d of diagnoseFixture(fixture)) {
        assert.ok(DIAGNOSTIC_CODES.includes(d.code), `${fixture}: '${d.message}' has code ${d.code}`);
      }
    }
  });

  it("sample-template-valid.otter IS template-aware and stays clean", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-template-valid.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.deepEqual(diagnoseFixture("sample-template-valid.otter"), []);
  });

  it("sample-webhook-template.otter (a paste-ready body, no annotations) IS template-aware and stays clean", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-webhook-template.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.deepEqual(diagnoseFixture("sample-webhook-template.otter"), []);
  });
});
