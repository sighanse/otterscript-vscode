// @ts-check
/**
 * @fileoverview Unit tests for the generated Inedo reference
 * (src/inedo-reference-data.js, from scripts/update-inedo-reference.js): how
 * language-data.js merges it under the hand-written tables, and the grammar
 * lists generated from the result (scripts/check-language-sync.js --write).
 *
 * Requires the vscode stub before helpers.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const fs = require("node:fs");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const data = require("../../src/language-data.js");
const reference = require("../../src/inedo-reference-data.js");
const { validateDocs } = require("../../src/helpers.js");

describe("generated Inedo reference, merged into language-data", () => {
  it("adds functions and operations the hand-written tables don't have", () => {
    assert.ok(data.operationDocs["Extract-ZipFile"], "Extract-ZipFile");
    assert.ok(data.operationDocs["Ensure-DscResource"], "Ensure-DscResource");
    assert.ok(data.scalarFunctionDocs["PythonPath"], "$PythonPath");
    assert.match(data.operationDocs["Extract-ZipFile"].documentation ?? "", /From Inedo's/);
  });

  it("keeps the hand-written entry where both exist", () => {
    assert.notEqual(data.scalarFunctionDocs["Substring"], reference.scalarFunctionDocs["Substring"]);
    assert.doesNotMatch(data.scalarFunctionDocs["Substring"].documentation ?? "", /From Inedo's/);
  });

  it("never shadows ProGet's hand-written variables with BuildMaster's", () => {
    // $PackageVersion is in variableDocs (ProGet) and in the BuildMaster reference.
    assert.ok(reference.scalarFunctionDocs["PackageVersion"]);
    assert.equal(data.scalarFunctionDocs["PackageVersion"], undefined);
    assert.ok(data.variableDocs["PackageVersion"]);
  });

  it("puts a function Inedo lists without a sigil into all three tables", () => {
    assert.equal(data.scalarFunctionDocs["MapAdd"]?.name, "$MapAdd");
    assert.equal(data.vectorFunctionDocs["MapAdd"]?.name, "@MapAdd");
    assert.equal(data.mapFunctionDocs["MapAdd"]?.name, "%MapAdd");
  });

  it("uses only declared namespaces (none for InedoCore and BuildMaster's DB/Packages/System)", () => {
    for (const doc of Object.values(reference.operationDocs)) {
      assert.ok(doc.namespace === null || data.NAMESPACES.has(doc.namespace), `${doc.name}: ${doc.namespace}`);
    }
    assert.equal(reference.operationDocs["Sleep"].namespace, null, "InedoCore::Sleep");
    assert.equal(reference.operationDocs["Backup-Database"].namespace, null, "DB::Backup-Database");
    assert.equal(reference.operationDocs["SHExec"].namespace, "Linux", "corrected from source");
  });

  describe("every merged table passes validateDocs", () => {
    const realWarn = console.warn;
    const realError = console.error;
    before(() => { console.warn = () => {}; console.error = () => {}; });
    after(() => { console.warn = realWarn; console.error = realError; });

    for (const table of ["scalarFunctionDocs", "vectorFunctionDocs", "mapFunctionDocs", "operationDocs", "variableDocs"]) {
      it(table, () => {
        const { errors, warnings } = validateDocs(table, /** @type {any} */ (data)[table]);
        assert.deepEqual([...errors, ...warnings], []);
      });
    }
  });
});

describe("generated grammar lists", () => {
  const grammar = fs.readFileSync(path.join(__dirname, "..", "..", "syntaxes", "otterscript.tmLanguage.json"), "utf8");
  const operations = /"name": "keyword\.other\.operation\.otterscript",\s*"match": "\\\\b\(([^)]*)\)/.exec(grammar)?.[1].split("|") ?? [];

  it("lists the reference's operations, longest name first", () => {
    assert.ok(operations.includes("Extract-ZipFile"));
    assert.ok(operations.includes("PSCall"), "a namespace-less operation without a dash");
    const lengths = operations.map((n) => n.length);
    assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
  });

  it("leaves out namespaced operations without a dash, which would color plain words", () => {
    assert.ok(!operations.includes("Build"), "DotNet::Build / DevEnv::Build");
    assert.ok(!operations.includes("Test"), "DotNet::Test");
  });
});
