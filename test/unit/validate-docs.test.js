// @ts-check
/**
 * @fileoverview Unit tests for the docs-table validator (validate-docs.js),
 * which reference.test.js runs over every table in src/language-data.js.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { validateDocs } = require("./validate-docs");

// ============================================================
// validateDocs
// ============================================================

describe("validateDocs", () => {
  const good = { name: "X", description: "does X", namespace: null };

  it("passes a well-formed table", () => {
    const { errors, warnings } = validateDocs("t", { X: good });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it("checks the shape of 'overloads'", () => {
    const ok = validateDocs("t", { X: { ...good, overloads: [{ product: "BuildMaster", signature: "$X(a)" }] } });
    assert.deepEqual(ok.warnings, []);
    const bad = validateDocs("t", { X: { ...good, overloads: [{ product: "BuildMaster" }] } });
    assert.equal(bad.warnings.length, 1);
  });

  it("errors on a missing name / description", () => {
    const { errors } = validateDocs("t", {
      A: { description: "d", namespace: null },
      B: { name: "B", namespace: null },
    });
    assert.ok(errors.some((e) => /A .*missing required 'name'/.test(e)));
    assert.ok(errors.some((e) => /B .*missing required 'description'/.test(e)));
  });

  it("errors when 'namespace' is absent", () => {
    const { errors } = validateDocs("t", { X: { name: "X", description: "d" } });
    assert.ok(errors.some((e) => /missing required 'namespace'/.test(e)));
  });

  it("errors on a namespace outside the allowlist, accepts null and a known one", () => {
    assert.ok(validateDocs("t", { X: { ...good, namespace: "Bogus" } }).errors.length > 0);
    assert.deepEqual(validateDocs("t", { X: { ...good, namespace: "ProGet" } }).errors, []);
    assert.deepEqual(validateDocs("t", { X: { ...good, namespace: null } }).errors, []);
  });

  it("warns on any non-string optional field", () => {
    const { warnings } = validateDocs("t", {
      X: { ...good, snippet: 42, signature: 1, documentation: {} },
    });
    assert.ok(warnings.some((w) => /'snippet' must be a string/.test(w)));
    assert.ok(warnings.some((w) => /'signature' must be a string/.test(w)));
    assert.ok(warnings.some((w) => /'documentation' must be a string/.test(w)));
  });

  it("errors on a non-object entry", () => {
    assert.ok(validateDocs("t", { X: "nope" }).errors.some((e) => /is not an object/.test(e)));
  });

  it("warns on an optional string field of another type, falsy ones too", () => {
    for (const field of ["snippet", "signature", "documentation"]) {
      for (const value of [false, 0, null, 42]) {
        const { warnings } = validateDocs("t", { X: { name: "X", description: "d", namespace: null, [field]: value } });
        assert.ok(warnings.some((w) => w.includes(`'${field}' must be a string`)), `${field}: ${value}`);
      }
      assert.deepEqual(validateDocs("t", { X: { name: "X", description: "d", namespace: null, [field]: "" } }).warnings, [], `${field}: ""`);
    }
  });
});
