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
const { isAvailableIn, validateDocs } = require("../../src/helpers.js");

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

  it("marks the functions Inedo lists without a sigil as anySigil", () => {
    for (const table of /** @type {const} */ (["scalarFunctionDocs", "vectorFunctionDocs", "mapFunctionDocs"])) {
      assert.equal(reference[table]["MapAdd"]?.anySigil, true, table);
    }
    assert.equal(reference.scalarFunctionDocs["ToJson"]?.anySigil, undefined);
  });

  it("derives the @ and % forms of a hand-written anySigil function from its $ entry", () => {
    for (const key of ["FromJson", "ListItem", "Eval", "GetVariableValue"]) {
      const scalar = data.scalarFunctionDocs[key];
      assert.equal(scalar.anySigil, true, `$${key} takes the mark`);
      for (const [sigil, table] of /** @type {const} */ ([["@", "vectorFunctionDocs"], ["%", "mapFunctionDocs"]])) {
        const form = data[table][key];
        assert.equal(form.name, `${sigil}${key}`);
        assert.equal(form.signature, scalar.signature?.replace("$", sigil));
        assert.equal(form.documentation, scalar.documentation, `${sigil}${key} shares the $ entry's docs`);
        assert.ok(form.snippet?.startsWith(`${sigil}${key}(`), form.snippet);
      }
    }
  });

  it("gives operations their arguments, in params rather than in the documentation", () => {
    const copy = reference.operationDocs["Copy-Files"];
    assert.deepEqual(copy.params?.find((p) => p.name === "To"), { name: "To", required: true, description: "Target directory", format: "text" });
    assert.ok(copy.params?.every((p) => p.description !== p.name), "no description that only repeats the name");
    assert.doesNotMatch(copy.documentation, /\*\*Arguments:\*\*/);
    // A hand-written operation takes the reference's list.
    assert.ok(data.operationDocs["Execute-PowerShell"].params?.some((p) => p.name === "Text"));
  });

  it("uses only declared namespaces (none for InedoCore and BuildMaster's DB/Packages/System)", () => {
    for (const doc of Object.values(reference.operationDocs)) {
      assert.ok(doc.namespace === null || data.NAMESPACES.has(doc.namespace), `${doc.name}: ${doc.namespace}`);
    }
    assert.equal(reference.operationDocs["Sleep"].namespace, null, "InedoCore::Sleep");
    assert.equal(reference.operationDocs["Backup-Database"].namespace, null, "DB::Backup-Database");
    assert.equal(reference.operationDocs["SHExec"].namespace, "Linux", "corrected from source");
  });

  it("hand-written entries use the parameter names of Inedo's reference", () => {
    // Deliberate differences: ProGet's forms of $PackageHash/$PackageProperty
    // (BuildMaster's are their overloads), and the vararg functions the
    // reference prints without any parameter list.
    const exceptions = new Set(["PackageHash", "PackageProperty", "Coalesce", "ListConcat"]);
    /** @param {string | undefined} signature */
    const params = (signature) =>
      (/\(([\s\S]*)\)/.exec(signature ?? "")?.[1] ?? "").split(",")
        .map((p) => p.replace(/[[\]\s]/g, "").replace(/(:|=>)[\s\S]*$/, ""))
        .filter(Boolean)
        .sort();
    for (const table of /** @type {const} */ (["scalarFunctionDocs", "vectorFunctionDocs", "mapFunctionDocs", "operationDocs"])) {
      for (const [key, doc] of Object.entries(data[table])) {
        const generated = reference[table][key];
        if (!generated || generated === doc || exceptions.has(key)) continue;
        assert.deepEqual(params(doc.signature), params(generated.signature), `${doc.name}: ${doc.signature} vs ${generated.signature}`);
      }
    }
  });

  it("knows which products have each entry", () => {
    assert.deepEqual(data.operationDocs["Ensure-Server"].products, ["Otter"]);
    assert.deepEqual(data.scalarFunctionDocs["ReleaseName"].products, ["BuildMaster"]);
    // Hand-written: inherits the reference's list, or sets its own.
    assert.deepEqual(data.scalarFunctionDocs["Substring"].products, ["Otter", "BuildMaster"]);
    assert.deepEqual(data.scalarFunctionDocs["PackageHash"].products, ["ProGet", "BuildMaster"]);
    assert.deepEqual(data.variableDocs["FeedName"].products, ["ProGet"]);
    assert.equal(data.operationDocs["Log-Information"].products, undefined, "every product");
  });

  it("isAvailableIn: a product's own entries, core-engine ones for ProGet, everything for 'any'", () => {
    const otterOnly = { products: ["Otter"] };
    const both = { products: ["Otter", "BuildMaster"] };
    const progetOnly = { products: ["ProGet"] };
    assert.equal(isAvailableIn(otterOnly, "Otter"), true);
    assert.equal(isAvailableIn(otterOnly, "BuildMaster"), false);
    assert.equal(isAvailableIn(otterOnly, "ProGet"), false);
    assert.equal(isAvailableIn(both, "ProGet"), true, "core engine");
    assert.equal(isAvailableIn(progetOnly, "Otter"), false);
    assert.equal(isAvailableIn(progetOnly, "any"), true);
    assert.equal(isAvailableIn({}, "BuildMaster"), true, "no list = every product");
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
