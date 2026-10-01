// @ts-check
/**
 * @fileoverview Unit tests for the `otterscript.diagnostics.rules` setting:
 * applyDiagnosticRules() in src/diagnostics.js, and the package.json schema
 * staying in sync with DIAGNOSTIC_CODES.
 *
 * Requires the vscode stub before diagnostics.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Diagnostic, DiagnosticSeverity, Range } = require("../vscode-stub");
const { applyDiagnosticRules, DIAGNOSTIC_CODES } = require("../../src/diagnostics.js");
const packageJson = require("../../package.json");

/**
 * @param {string} code
 * @param {number} [severity]
 */
function diag(code, severity = DiagnosticSeverity.Warning) {
  const d = new Diagnostic(new Range(0, 0, 0, 1), `msg ${code}`, severity);
  d.code = code;
  return d;
}

describe("applyDiagnosticRules", () => {
  it("returns the input unchanged when there are no rules", () => {
    const issues = [diag("unknown-operation")];
    assert.equal(applyDiagnosticRules(/** @type {any} */ (issues), undefined), issues);
    assert.equal(applyDiagnosticRules(/** @type {any} */ (issues), {}), issues);
  });

  it("drops diagnostics whose code is set to 'off'", () => {
    const issues = [diag("unknown-operation"), diag("missing-dollar")];
    const kept = applyDiagnosticRules(/** @type {any} */ (issues), { "unknown-operation": "off" });
    assert.deepEqual(kept.map((d) => d.code), ["missing-dollar"]);
  });

  it("overrides the severity of codes set to a severity name", () => {
    const issues = [
      diag("unknown-operation", DiagnosticSeverity.Warning),
      diag("unbalanced-symbol", DiagnosticSeverity.Error),
    ];
    const kept = applyDiagnosticRules(/** @type {any} */ (issues), {
      "unknown-operation": "hint",
      "unbalanced-symbol": "information",
    });
    assert.deepEqual(kept.map((d) => d.severity), [DiagnosticSeverity.Hint, DiagnosticSeverity.Information]);
  });

  it("leaves codes with no rule, or an unrecognized rule value, untouched", () => {
    const issues = [diag("unknown-operation"), diag("missing-dollar", DiagnosticSeverity.Error)];
    const kept = applyDiagnosticRules(/** @type {any} */ (issues), { "missing-dollar": "loud" });
    assert.deepEqual(kept.map((d) => d.severity), [DiagnosticSeverity.Warning, DiagnosticSeverity.Error]);
  });

  it("ignores rule values that name inherited Object properties", () => {
    const issues = [diag("unknown-operation"), diag("missing-dollar")];
    const kept = applyDiagnosticRules(/** @type {any} */ (issues), {
      "unknown-operation": "constructor",
      "missing-dollar": "toString",
    });
    assert.deepEqual(kept.map((d) => d.severity), [DiagnosticSeverity.Warning, DiagnosticSeverity.Warning]);
  });
});

describe("otterscript.adaptiveCards.maxVersion schema", () => {
  const schema = packageJson.contributes.configuration.properties["otterscript.adaptiveCards.maxVersion"];

  it("accepts major.minor versions only, including its own default", () => {
    const pattern = new RegExp(schema.pattern);
    for (const valid of [schema.default, "1.5", "1.10"]) assert.ok(pattern.test(valid), valid);
    for (const invalid of ["1", "1.5.0", "1x5", "latest", "d+.d"]) assert.ok(!pattern.test(invalid), invalid);
  });
});

describe("otterscript.diagnostics.rules schema", () => {
  const schema = packageJson.contributes.configuration.properties["otterscript.diagnostics.rules"];

  it("lists exactly the codes in DIAGNOSTIC_CODES", () => {
    assert.deepEqual(Object.keys(schema.properties).sort(), [...DIAGNOSTIC_CODES].sort());
  });

  it("offers 'off' plus every severity for each code", () => {
    for (const [code, prop] of Object.entries(schema.properties)) {
      assert.deepEqual(prop.enum, ["off", "error", "warning", "information", "hint"], code);
    }
  });

  it("has no duplicate codes", () => {
    assert.equal(new Set(DIAGNOSTIC_CODES).size, DIAGNOSTIC_CODES.length);
  });
});
