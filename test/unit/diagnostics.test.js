// @ts-check
/**
 * @fileoverview Unit tests for src/diagnostics.js `updateDiagnostics` — every
 * check it emits, plus non-code masking, cross-line scan state, and the
 * languageId guard.
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
 * Runs updateDiagnostics over `source` and returns the collected diagnostics
 * (an empty array when the collection is never written, e.g. the languageId
 * guard fires).
 *
 * @param {string} source
 * @param {string} [languageId]
 * @returns {any[]}
 */
function diagnose(source, languageId = "otterscript") {
  const lines = source.split("\n");
  /** @param {{ line: number, character: number }} p */
  const offsetAt = (p) => {
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  };
  const document = /** @type {any} */ ({
    languageId,
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

/**
 * @param {string} source
 * @param {string} code
 * @returns {any[]}
 */
const only = (source, code) => diagnose(source).filter((d) => d.code === code);

// ============================================================
// languageId guard
// ============================================================

describe("updateDiagnostics — languageId guard", () => {
  it("does nothing for a non-otterscript document", () => {
    // `if x = 5` would yield missing-dollar + assignment-in-condition in an
    // OtterScript file; here the guard must short-circuit before anything runs.
    assert.deepEqual(diagnose("if x = 5", "plaintext"), []);
  });

  it("runs for an otterscript document", () => {
    assert.ok(diagnose("if x = 5").length > 0);
  });
});

// ============================================================
// clean document
// ============================================================

describe("updateDiagnostics — clean document", () => {
  it("reports nothing for a valid script", () => {
    const src = [
      'Log-Information "starting";',
      "if $count > 0 {",
      "    set $result = $ToJson(%( ok: true ));",
      "}",
      "foreach $s in @AllServers() {",
      "    Log-Information $s;",
      "}",
    ].join("\n");
    assert.deepEqual(diagnose(src), []);
  });
});

// ============================================================
// missing '$' in if conditions (integration through updateDiagnostics)
// ============================================================

describe("updateDiagnostics — missing '$'", () => {
  it("flags a bare variable in an if condition", () => {
    const [d] = only("if count == 0", "missing-dollar");
    assert.ok(d);
    assert.equal(d.severity, DiagnosticSeverity.Error);
    assert.equal(d.range.start.line, 0);
    assert.equal(d.range.start.character, 3);
  });

  it("does not flag when the variable is prefixed", () => {
    assert.deepEqual(only("if $count == 0", "missing-dollar"), []);
  });

  it("does not flag inside a comment", () => {
    assert.deepEqual(only("# if count == 0", "missing-dollar"), []);
  });
});

// ============================================================
// unbalanced braces / parens / brackets
// ============================================================

describe("updateDiagnostics — unbalanced symbols", () => {
  it("flags an unclosed brace at end of document", () => {
    const issues = diagnose("if $x {");
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /Unclosed brace\(s\): 1 '\{' not closed \(first at line 1, col 7\)/);
    assert.equal(issues[0].severity, DiagnosticSeverity.Error);
    assert.equal(issues[0].source, "OtterScript");
  });

  it("flags an unexpected closing bracket", () => {
    const issues = diagnose("foo ]");
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /Unexpected closing bracket: Extra '\]' at line 1, col 5/);
  });

  it("accepts balanced braces across lines", () => {
    assert.deepEqual(diagnose("if $x {\n}"), []);
  });

  it("counts multiple unclosed parens", () => {
    const issues = diagnose("$x = $Eval((1 + 2");
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /Unclosed parenthesis\(s\): 2 '\(' not closed/);
  });

  it("ignores brackets inside strings and comments", () => {
    assert.deepEqual(diagnose('$s = "{[(";  # )]}'), []);
  });
});

// ============================================================
// unknown scalar / vector functions
// ============================================================

describe("updateDiagnostics — unknown scalar function", () => {
  it("flags '$Foo(' when Foo is unknown", () => {
    const [d] = only('$r = $Frobnicate("x");', "unknown-scalar-function");
    assert.ok(d);
    assert.equal(d.message, "Unknown scalar function '$Frobnicate'");
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.equal(d.range.start.character, 6, "points at the name, past the '$'");
    assert.equal(d.range.end.character, 6 + "Frobnicate".length);
  });

  it("does not flag a known scalar function", () => {
    assert.deepEqual(only('$r = $ToJson($d);', "unknown-scalar-function"), []);
  });

  it("does not flag inside a string", () => {
    assert.deepEqual(only('Log-Information "$Frobnicate(x)";', "unknown-scalar-function"), []);
  });
});

describe("updateDiagnostics — unknown vector function", () => {
  it("flags '@Foo(' when Foo is unknown", () => {
    const [d] = only("set @v = @Nope();", "unknown-vector-function");
    assert.ok(d);
    assert.equal(d.message, "Unknown vector function '@Nope'");
    assert.equal(d.severity, DiagnosticSeverity.Warning);
  });

  it("does not flag a known vector function", () => {
    assert.deepEqual(only("foreach $s in @AllServers() { }", "unknown-vector-function"), []);
  });
});

// ============================================================
// unknown operation
// ============================================================

describe("updateDiagnostics — unknown operation", () => {
  it("flags a dashed identifier that is not a known operation", () => {
    const [d] = only('Do-Something "arg";', "unknown-operation");
    assert.ok(d);
    assert.equal(d.message, "Unknown operation 'Do-Something'");
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.equal(d.range.start.character, 0);
    assert.equal(d.range.end.character, "Do-Something".length);
  });

  it("does not flag a known operation", () => {
    assert.deepEqual(only('Log-Information "hi";', "unknown-operation"), []);
  });

  it("does not flag a non-dashed identifier", () => {
    assert.deepEqual(only('frobnicate "x";', "unknown-operation"), []);
  });

  it("does not flag inside a comment", () => {
    assert.deepEqual(only("# Do-Something here", "unknown-operation"), []);
  });
});

// ============================================================
// assignment in condition / invalid operator
// ============================================================

describe("updateDiagnostics — assignment in condition", () => {
  it("flags a single '=' in an if", () => {
    const [d] = only("if $x = 5 { }", "assignment-in-condition");
    assert.ok(d);
    assert.match(d.message, /Did you mean '=='/);
    assert.equal(d.severity, DiagnosticSeverity.Warning);
  });

  it("does not flag '==' in an if", () => {
    assert.deepEqual(only("if $x == 5 { }", "assignment-in-condition"), []);
  });

  it("does not flag '=' outside an if", () => {
    assert.deepEqual(only("set $x = 5;", "assignment-in-condition"), []);
  });
});

describe("updateDiagnostics — invalid logical operator", () => {
  it("flags a single '&' in an if", () => {
    const [d] = only("if $a & $b { }", "invalid-operator");
    assert.ok(d);
    assert.match(d.message, /Invalid logical operator '&'\. Use '&&'/);
  });

  it("flags a single '|' in an if", () => {
    assert.equal(only("if $a | $b { }", "invalid-operator").length, 1);
  });

  it("does not flag '&&' or '||'", () => {
    assert.deepEqual(only("if $a && $b || $c { }", "invalid-operator"), []);
  });
});

// ============================================================
// incorrect 'for' usage
// ============================================================

describe("updateDiagnostics — incorrect 'for' usage", () => {
  it("flags 'for i = 1 to 10'", () => {
    const [d] = only("for $i = 1 to 10 { }", "incorrect-for-usage");
    assert.ok(d);
    assert.match(d.message, /Use 'foreach' for loops/);
    assert.equal(d.range.start.character, 0);
    assert.equal(d.range.end.character, 3);
  });

  it("flags 'for x in list'", () => {
    assert.equal(only("for $x in @list { }", "incorrect-for-usage").length, 1);
  });

  it("does not flag 'foreach'", () => {
    assert.deepEqual(only("foreach $x in @list { }", "incorrect-for-usage"), []);
  });

  it("does not flag context-binding 'for server'", () => {
    assert.deepEqual(only('for server "web" { }', "incorrect-for-usage"), []);
  });
});

// ============================================================
// duplicate map key (integration through updateDiagnostics)
// ============================================================

describe("updateDiagnostics — duplicate map key", () => {
  it("flags a repeated key in a %( ) literal", () => {
    const [d] = only("$m = %( a: 1, a: 2 );", "duplicate-map-key");
    assert.ok(d);
    assert.match(d.message, /Duplicate key 'a'/);
    assert.equal(d.severity, DiagnosticSeverity.Warning);
  });

  it("does not flag map-shaped text inside a comment", () => {
    assert.deepEqual(only("$m = %( a: 1 ); # a: 2, a: 3", "duplicate-map-key"), []);
  });
});

// ============================================================
// non-code masking + cross-line scan state
// ============================================================

describe("updateDiagnostics — masking & cross-line state", () => {
  it("ignores every check inside a single-line string", () => {
    const src = 'Log-Information "$Bad( Frobnicate::X Do-Nope if x = 5";';
    assert.deepEqual(diagnose(src), []);
  });

  it("ignores everything inside a '#' line comment", () => {
    assert.deepEqual(diagnose("# $Bad( Frobnicate::X Do-Nope"), []);
  });

  it("carries a block comment across lines", () => {
    const masked = diagnose(["/* open", "$Bogus(", "Frobnicate::X", "*/"].join("\n"));
    assert.deepEqual(masked, []);
    // sanity: the same token is flagged when NOT in a comment
    assert.equal(only("$Bogus(", "unknown-scalar-function").length, 1);
  });

  it("carries a swim-string across lines", () => {
    const src = ["$s = >>", "$Bogus( here", "Frobnicate::Y", ">> ;"].join("\n");
    assert.deepEqual(diagnose(src), []);
  });
});

// ============================================================
// unknown "Namespace::" qualifier
// ============================================================

describe("updateDiagnostics — unknown namespace", () => {
  /** @param {string} source */
  const namespaceIssues = (source) => only(source, "unknown-namespace");

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
    assert.deepEqual(diagnose("Frobnicate::Do-Thing xyz;").map((d) => d.code), ["unknown-namespace"]);
  });

  it("still reports an unknown operation under a known namespace", () => {
    const codes = diagnose("ProGet::Totally-Made-Up ();").map((d) => d.code);
    assert.ok(codes.includes("unknown-operation"));
    assert.ok(!codes.includes("unknown-namespace"));
  });
});
