// @ts-check
/**
 * @fileoverview Unit tests for src/diagnostics.js: `updateDiagnostics` — every
 * check it emits, plus non-code masking, cross-line scan state, and the
 * languageId guard — and, at the end, the single checks it is built from.
 *
 * Requires the vscode stub before diagnostics.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { makeDocument } = require("./fake-document");

const { DiagnosticSeverity } = require("../vscode-stub");
const {
  checkMissingDollar,
  createUnbalancedDiagnostic,
  findDuplicateMapKeyDiagnosticsFromMasked,
  getDiagnosticCode,
  updateDiagnostics,
} = require("../../src/diagnostics.js");

/** The diagnostics context: settings left at their defaults. */
const ctx = {};

/**
 * Runs updateDiagnostics over `source` and returns the collected diagnostics
 * (an empty array when the collection is never written, e.g. the languageId
 * guard fires).
 *
 * @param {string} source
 * @param {string} [languageId]
 * @param {object} [extraCtx] - Added to the diagnostics context
 * @returns {any[]}
 */
function diagnose(source, languageId = "otterscript", extraCtx = {}) {
  const document = makeDocument(source, { languageId });
  /** @type {any[]} */
  let collected = [];
  const collection = /** @type {any} */ ({
    // Plain string codes, for comparing: the links are tested on their own.
    set: (/** @type {unknown} */ _uri, /** @type {any[]} */ issues) => {
      collected = issues.map((d) => Object.assign(d, { code: d.code.value }));
    },
  });
  updateDiagnostics(document, collection, { ...ctx, ...extraCtx });
  return collected;
}

/**
 * @param {string} source
 * @param {string} code
 * @param {object} [extraCtx] - Added to the diagnostics context
 * @returns {any[]}
 */
const only = (source, code, extraCtx) => diagnose(source, "otterscript", extraCtx).filter((d) => d.code === code);

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

  it("links each code to the README's table of codes", () => {
    /** @type {any[]} */
    let published = [];
    const collection = /** @type {any} */ ({ set: (/** @type {unknown} */ _uri, /** @type {any[]} */ issues) => { published = issues; } });
    updateDiagnostics(makeDocument("if x = 5"), collection, ctx);
    assert.ok(published.length > 0);
    for (const d of published) {
      assert.equal(typeof d.code.value, "string");
      assert.match(d.code.target.toString(), /^https:\/\/github\.com\/sighanse\/otterscript-vscode#turning-individual-diagnostics-off$/);
    }
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
    assert.deepEqual(only("$r = $ToJson($d);", "unknown-scalar-function"), []);
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

  it("does not flag the @ form of sigil-polymorphic functions ($FromJson, $ListItem)", () => {
    assert.deepEqual(only("set @v = @FromJson($json);", "unknown-vector-function"), []);
    assert.deepEqual(only("set @v = @ListItem(@nested, 0);", "unknown-vector-function"), []);
  });
});

// ============================================================
// too many arguments
// ============================================================

describe("updateDiagnostics — too many arguments (Inedo's arity)", () => {
  it("accepts $Trim's optional characters to trim", () => {
    assert.deepEqual(only('$r = $Trim($a, "-", "_");', "too-many-arguments"), []);
  });

  it("allows the largest count of any product's form, and flags beyond it", () => {
    // ProGet takes (name, [default]); BuildMaster (packageName, packageProperty, [sourceName]).
    assert.deepEqual(only("$r = $PackageProperty($a, $b, $c);", "too-many-arguments"), []);
    assert.equal(only("$r = $PackageProperty($a, $b, $c, $d);", "too-many-arguments").length, 1);
  });

  it("no longer knows $Base64Encode / $Base64Decode, which Inedo doesn't have", () => {
    assert.equal(only("$r = $Base64Encode($a);", "unknown-scalar-function").length, 1);
    assert.equal(only("$r = $Base64Decode($a);", "unknown-scalar-function").length, 1);
  });
});

describe("updateDiagnostics — too many arguments", () => {
  it("flags a fixed-arity scalar function called with an extra argument", () => {
    const [d] = only("$r = $ToJson($a, $b);", "too-many-arguments");
    assert.ok(d);
    assert.equal(d.message, "'$ToJson' takes at most 1 argument, got 2.");
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.equal(d.range.start.character, 6, "points at the name, past the '$'");
    assert.equal(d.range.end.character, 6 + "ToJson".length);
  });

  it("flags a fixed-arity vector function called with an extra argument", () => {
    const [d] = only("$r = @Split($a, $b, $c, $d);", "too-many-arguments");
    assert.ok(d);
    assert.equal(d.message, "'@Split' takes at most 3 arguments, got 4.");
  });

  it("flags a fixed-arity map function called with an extra argument", () => {
    const [d] = only("set %m = %FromJson($a, $b);", "too-many-arguments");
    assert.ok(d);
    assert.equal(d.message, "'%FromJson' takes at most 1 argument, got 2.");
  });

  it("does not flag a call within the documented argument count", () => {
    assert.deepEqual(only("$r = $ToJson($a);", "too-many-arguments"), []);
    assert.deepEqual(only("$r = @Split($a, $b, $c);", "too-many-arguments"), []);
    assert.deepEqual(only("set %m = %ListItem(@x, 0);", "too-many-arguments"), []);
  });

  it("does not treat a %( map literal as a function call", () => {
    assert.deepEqual(only("set %m = %(a: 1, b: 2, c: 3);", "too-many-arguments"), []);
  });

  it("does not flag implicit-string juxtaposition as extra arguments", () => {
    // $a $b with no comma is ONE implicit-string argument, not two.
    assert.deepEqual(only("$r = $ToJson($a $b);", "too-many-arguments"), []);
  });

  it("does not flag a nested map/vector literal as multiple top-level arguments", () => {
    assert.deepEqual(
      only("$r = $ToJson(%( a: $x, b: $y ));", "too-many-arguments"),
      []
    );
  });

  it("does not flag a vararg function regardless of argument count", () => {
    assert.deepEqual(
      only("$r = $Coalesce($a, $b, $c, $d, $e);", "too-many-arguments"),
      []
    );
  });

  it("does not flag an unknown function (that check is owned by unknown-scalar-function)", () => {
    assert.deepEqual(only("$r = $Frobnicate($a, $b, $c);", "too-many-arguments"), []);
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
    // PSCall2 isn't in Inedo's reference but is PSCall's own name.
    assert.deepEqual(only("PSCall2 MyScript;\nPSCall1 MyScript;", "unknown-operation"), []);
  });

  it("flags a dashed name with digits", () => {
    assert.equal(only('Copy-Files2 "x";', "unknown-operation")[0]?.message, "Unknown operation 'Copy-Files2'");
  });

  it("does not flag a non-dashed identifier", () => {
    assert.deepEqual(only('frobnicate "x";', "unknown-operation"), []);
  });

  it("does not flag inside a comment", () => {
    assert.deepEqual(only("# Do-Something here", "unknown-operation"), []);
  });

  it("checks only the statement's first word, so dashed names are not operations", () => {
    for (const source of [
      "set $my-var = 1;",
      "Log-Information ${my-var};",
      "set %m = %(my-key: 1);",
      "Log-Information $x[my-key];",
      "Log-Information (Text: x, Some-Param: y);",
      "Log-Information (\n    Some-Param: x\n);",
      "module My-Module {\n}",
      "call My-Module;",
      "Log-Information My-Arg;",
    ]) {
      assert.deepEqual(only(source, "unknown-operation"), [], source);
    }
  });

  it("knows every operation and function in Inedo's reference", () => {
    for (const source of [
      "Extract-ZipFile (Name: a.zip);",
      "Replace-Text (Include: *.txt, SearchText: a, ReplaceWith: b);",
      "Ensure-DscResource (Name: x);",
      "IIS::Ensure-AppPool (Name: x);",
      "set %m = %MapAdd(%m, k, v);",
    ]) {
      assert.deepEqual(diagnose(source).filter((d) => /^unknown-/.test(d.code)), [], source);
    }
  });

  it("still flags an unknown operation after ';', inside braces, or behind a known namespace", () => {
    assert.deepEqual(only('Log-Information "a"; Bogus-Op "b";', "unknown-operation").map((d) => d.range.start.character), [21]);
    assert.equal(only("if $a { Bogus-Op; }", "unknown-operation").length, 1);
    assert.equal(only("ProGet::Bogus-Op;", "unknown-operation").length, 1);
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

  it("checks only the condition, not a body on the same line", () => {
    assert.deepEqual(only("if $Debug { set $Level = 2; }", "assignment-in-condition"), []);
    const found = only("if $a = 1 { set $b = 2; }", "assignment-in-condition");
    assert.deepEqual(found.map((d) => d.range.start.character), [6]);
  });

  it("treats a braced variable as part of the condition", () => {
    const src = "if ${my var} = 1 {\n}";
    assert.deepEqual(only(src, "assignment-in-condition").map((d) => d.range.start.character), [src.indexOf("= 1")]);
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
  it("checks only the condition, not a body on the same line", () => {
    assert.deepEqual(only("if $a { Log-Information $b & $c; }", "invalid-operator"), []);
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

  it("flags a loop over a dashed variable name", () => {
    assert.equal(only("for $item-name in @list { }", "incorrect-for-usage").length, 1);
  });

  it("reports the keyword's real position whatever its case", () => {
    const [d] = only("  For $i = 1 to 10 { }", "incorrect-for-usage");
    assert.ok(d);
    assert.equal(d.range.start.character, 2);
    assert.equal(d.range.end.character, 5);
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

  it("knows every namespace Inedo's public extensions declare, in any case", () => {
    for (const ns of ["GitHub", "jira", "NuGet", "MSBuild", "WindowsSDK", "DevEnv", "SqlServer", "Kubernetes", "AzureDevOps", "npm"]) {
      assert.deepEqual(namespaceIssues(`${ns}::Do-Thing;`), [], ns);
    }
  });

  it("knows BuildMaster's own namespaces, but not an extension's name (InedoCore::)", () => {
    for (const source of ["DB::Backup-Database;", "Packages::Attach-Package;", "System::Backup-Application;"]) {
      assert.deepEqual(namespaceIssues(source), [], source);
    }
    assert.equal(namespaceIssues("InedoCore::Sleep 5;").length, 1);
  });

  it("checks operations only under namespaces whose operations are documented", () => {
    // No Kubernetes operation is documented; ProGet's and the built-ins are.
    assert.deepEqual(only("Kubernetes::Ensure-Thing;", "unknown-operation"), []);
    assert.equal(only("ProGet::Bogus-Op;", "unknown-operation").length, 1);
    assert.equal(only("Bogus-Op;", "unknown-operation").length, 1);
  });

  it("flags an unknown %Name( map function, but not a %( map literal or a known one", () => {
    const [d] = only("set %m = %Frob(1);", "unknown-map-function");
    assert.equal(d.message, "Unknown map function '%Frob'");
    assert.deepEqual(only("set %m = %(a: 1);\nset %n = %FromJson('{}');\nset %o = %MapAdd(%m, b, 2);", "unknown-map-function"), []);
  });

  it("hints at an operation call without a required argument", () => {
    const [d] = only('Copy-Files(\n  From: "a",\n  Include: @("*")\n);', "missing-required-argument");
    assert.equal(d.message, "'Copy-Files' is missing its required argument 'To'.");
    assert.equal(d.severity, DiagnosticSeverity.Hint);
    assert.deepEqual(only('Copy-Files(From: "a", to: "b");', "missing-required-argument"), [], "names ignore case");
    assert.deepEqual(only('Copy-Files("a");', "missing-required-argument"), [], "a positional argument: unknown which");
    assert.deepEqual(only('Log-Information "x";\ncall Copy-Files(From: "a");', "missing-required-argument"), [], "a module call");
    // A raft-qualified module call whose raft is named like a namespace.
    for (const code of ["missing-required-argument", "unknown-argument"]) {
      assert.deepEqual(only('Log-Information "x";\ncall Jira::Create-Issue(Titel: "x");', code), [], `a raft's module call: ${code}`);
    }
    // Same-named operations of different namespaces: the namespace picks
    // one; without it, only what every one requires is.
    assert.deepEqual(only('GitHub::Create-Issue(Title: "x");\nDotNet::Build(Project: "a.csproj");\nBuild(Configuration: "Release");', "missing-required-argument"), []);
    assert.equal(only('Jira::Create-Issue(Title: "x");', "missing-required-argument")[0]?.message, "'Create-Issue' is missing its required argument 'Type'.");
    assert.equal(only('DevEnv::Build(Configuration: "Release");', "missing-required-argument")[0]?.message, "'Build' is missing its required argument 'ProjectFile'.");
  });

  it("doesn't check an operation's arguments behind a namespace none of its forms has", () => {
    assert.deepEqual(only('Kubernetes::Copy-Files(From: "a");', "missing-required-argument"), []);
  });

  it("reads an output capture (`Name => $x`) as a named argument", () => {
    assert.equal(only("Get-Http(ResponseBody => $body);", "missing-required-argument")[0]?.message,
      "'Get-Http' is missing its required argument 'Url'.", "not taken for a positional argument");
    assert.equal(only("Get-Http(Url: $u, ResponseBdy => $body);", "unknown-argument")[0]?.message,
      "'ResponseBdy' isn't a documented argument of 'Get-Http'. Did you mean 'ResponseBody'?");
  });

  it("hints at an argument name that looks misspelt, and doesn't call its intended one missing", () => {
    const [d] = only('Copy-Files(Fomr: "a", To: "b", Frobnicate: 1);', "unknown-argument");
    assert.equal(d.message, "'Fomr' isn't a documented argument of 'Copy-Files'. Did you mean 'From'?");
    assert.equal(d.severity, DiagnosticSeverity.Hint);
    assert.deepEqual([d.range.start.character, d.range.end.character], [11, 15]);
    assert.deepEqual(only('Copy-Files(From: "a", Too: "b");', "missing-required-argument"), [], "'Too' stands for 'To'");
    assert.deepEqual(only('Copy-Files(From: "a", to: "b");', "unknown-argument"), [], "names ignore case");
    // A namespace's own arguments: DotNet::Build's `Project` is no typo of DevEnv's `ProjectFile`.
    assert.deepEqual(only('DotNet::Build(Project: "a.csproj");\nBuild(Project: "a.csproj");', "unknown-argument"), []);
  });

  it("flags a module declared twice in one file, pointing at the first", () => {
    const [d] = only("module Greet {\n}\nmodule greet {\n}\nmodule Other {\n}", "duplicate-module");
    assert.equal(d.message, "A module named 'greet' is already declared in this file.");
    assert.equal(d.range.start.line, 2);
    assert.equal(d.relatedInformation[0].location.range.start.line, 0);
  });

  it("flags too few arguments, using the [optional] markers and the most lenient form", () => {
    const [d] = only("set $s = $Substring($x);", "too-few-arguments");
    assert.equal(d.message, "'$Substring' needs at least 2 arguments, got 1.");
    assert.deepEqual(only("set $s = $Substring($x, 1);\nset $t = $Substring($x, 1, 2);", "too-few-arguments"), []);
    // A lone string argument (blank once strings are masked) still counts.
    assert.deepEqual(only('set $l = $ToLower("HELLO");\nset $m = $ToLower(\n  "x" # why\n);', "too-few-arguments"), []);
    assert.equal(only("set $l = $ToLower( # nothing\n);", "too-few-arguments").length, 1);
    // ProGet's $PackageProperty(name, [default]) next to BuildMaster's three-argument form.
    assert.deepEqual(only("set $p = $PackageProperty(Name);", "too-few-arguments"), []);
    // A vararg tail never makes a call too long.
    assert.deepEqual(only("set $p = $PathCombine(a, b, c, d, e);", "too-many-arguments"), []);
  });

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

// ============================================================
// text-template (<% ... %>) structural checks  (phase 1)
// ============================================================

describe("updateDiagnostics - template <% %> structural checks", () => {
  /** @param {string} src */
  const msgs = (src) => diagnose(src).map((d) => d.message);
  /** @param {string} src */
  const codes = (src) => diagnose(src).map((d) => d.code);

  it("does not run any template check on a document with no tags", () => {
    // `<% ... %>` only inside a string -> not template-aware -> plain scan.
    assert.deepEqual(diagnose('set $t = "<% foreach $x in @y { %>";'), []);
  });

  it("blanks the literal text between tags (no false unknown-function / brace noise)", () => {
    const src = [
      "{",
      '  "items": [',
      "    <% foreach %p in @AffectedPackages { %>",
      '    { "type": "TextBlock", "text": $ToJson(%p.Name) }',
      "    <% } %>",
      "  ]",
      "}",
    ].join("\n");
    assert.deepEqual(diagnose(src), []);
  });

  it("flags <% end %> and offers the } quick-fix code", () => {
    const ds = diagnose("<% foreach $p in @x { %>a<% end %>");
    const end = ds.find((d) => d.code === "template-end-keyword");
    assert.ok(end);
    assert.match(end.message, /<% end %>/);
    assert.equal(end.severity, DiagnosticSeverity.Warning);
  });

  it("flags every <% endfoo %> spelling", () => {
    for (const kw of ["end", "endif", "endfor", "endforeach", "endwhile", "ENDIF"]) {
      assert.ok(
        diagnose(`<% if $x { %>a<% ${kw} %>`).some((d) => d.code === "template-end-keyword"),
        kw
      );
    }
  });

  it("flags a block opener with no brace", () => {
    assert.ok(diagnose("<% if !$p.Last %>,<% } %>").some((d) => d.code === "template-missing-brace"));
    assert.ok(diagnose("<% foreach $p in @x %>").some((d) => d.code === "template-missing-brace"));
    assert.ok(diagnose("<% while $x %>").some((d) => d.code === "template-missing-brace"));
    assert.ok(diagnose('<% for server "web" %>').some((d) => d.code === "template-missing-brace"));
  });

  it("does not flag a well-formed block opener or closer", () => {
    assert.equal(codes("<% foreach $p in @x { %>").filter((c) => c === "template-missing-brace").length, 0);
    assert.equal(codes("<% if $x { %>").filter((c) => c === "template-missing-brace").length, 0);
    assert.equal(codes('<% for server "web" { %>').filter((c) => c === "template-missing-brace").length, 0);
    assert.equal(codes("<% } %>").filter((c) => c === "template-missing-brace").length, 0);
    assert.equal(codes("<% } else { %>").filter((c) => c === "template-missing-brace").length, 0);
    assert.equal(codes("<% iffy $x %>").filter((c) => c === "template-missing-brace").length, 0);
  });

  it("flags a block opener with no brace when the tag spans multiple lines", () => {
    const src = ["<%", "foreach $p in @x", "%>"].join("\n");
    const d = only(src, "template-missing-brace")[0];
    assert.ok(d);
    // The keyword lives on line 1 (0-based), where it actually appears.
    assert.equal(d.range.start.line, 1);
    assert.equal(d.range.start.character, src.split("\n")[1].indexOf("foreach"));
  });

  it("flags <% end %> when the tag spans multiple lines", () => {
    const src = ["<% if $x { %>", "a", "<%", "end", "%>"].join("\n");
    const d = only(src, "template-end-keyword")[0];
    assert.ok(d);
    assert.equal(d.range.start.line, 3);
  });

  it("does not flag a well-formed multi-line block opener", () => {
    const src = ["<%", "foreach $p in @x {", "%>"].join("\n");
    assert.equal(codes(src).filter((c) => c === "template-missing-brace").length, 0);
  });

  it("leaves bare 'for i = ...' misuse to the incorrect-for-usage check", () => {
    const cs = codes("<% for i = 1 to 10 %>");
    assert.ok(cs.includes("incorrect-for-usage"));
    assert.ok(!cs.includes("template-missing-brace"));
  });

  it("flags a stray %> with no matching <%", () => {
    // needs a real tag elsewhere so the doc is template-aware
    assert.ok(msgs("oops %> then <% $x %>").some((m) => /Unexpected '%>'/.test(m)));
  });

  it("flags an unclosed <% among complete tags", () => {
    const ds = diagnose(["<% if $x { %>", "text", "<% foreach $p in @y {"].join("\n"));
    assert.ok(ds.some((d) => /Unclosed template tag/.test(d.message)));
  });

  it("still runs the ordinary code checks inside a tag body", () => {
    // missing '$' in a template-embedded if condition
    assert.ok(diagnose("<% if count == 5 { %>x<% } %>").some((d) => d.code === "missing-dollar"));
  });
});

// ============================================================
// template/expression mode mixing  (phase 2, check 4)
// ============================================================

describe("updateDiagnostics - template-in-expression", () => {
  /** @param {string} src */
  const has = (src) => diagnose(src).some((d) => d.code === "template-in-expression");

  it("flags a <% opened inside an unclosed $Func( / %( / @( in literal text", () => {
    assert.ok(has('"x": $ToJson(%( a: 1 <% $y %> ))'));
    assert.ok(has('"x": $Eval( <% $y %> )'));
    assert.ok(has('"x": @( 1, <% $y %> )'));
  });

  it("does not flag a <% loop inside a JSON array or object", () => {
    const src = ['"items": [', "<% foreach $p in @x { %>", "  ,{ }", "<% } %>", "]"].join("\n");
    assert.equal(diagnose(src).filter((d) => d.code === "template-in-expression").length, 0);
  });

  it("reports once per stuck region, not on every following tag", () => {
    const src = ["$ToJson(%(", "<% foreach $p in @x { %>", "a", "<% } %>", "))"].join("\n");
    assert.equal(diagnose(src).filter((d) => d.code === "template-in-expression").length, 1);
  });
});

// ============================================================
// diagnostics reach $ expressions embedded directly in literal template text
// ============================================================
// A ProGet webhook body is almost entirely literal JSON text with `$Func(...)`
// calls embedded directly in it (no <% %> wrapper needed -- see
// strings-and-literals.md). Before this, maskOutsideTemplateTags() blanked
// ALL literal text uniformly, so a typo'd function name or a wrong argument
// count in exactly this position -- where the real logic of a template lives
// -- was invisible. Each src below needs a real <% %> pair elsewhere so
// documentUsesTemplateTags() puts the document in template-aware mode at all.

describe("updateDiagnostics - $ expressions embedded in literal template text", () => {
  it("flags an unknown scalar function embedded in literal text", () => {
    const src = ['{ "v": $Frobnicate($x) }', "<% if $ok { %>", "<% } %>"].join("\n");
    const [d] = only(src, "unknown-scalar-function");
    assert.ok(d);
    assert.equal(d.message, "Unknown scalar function '$Frobnicate'");
  });

  it("flags too many arguments on a call embedded in literal text", () => {
    const src = ['{ "v": $ToJson($x, $y) }', "<% if $ok { %>", "<% } %>"].join("\n");
    const [d] = only(src, "too-many-arguments");
    assert.ok(d);
    assert.equal(d.message, "'$ToJson' takes at most 1 argument, got 2.");
  });

  it("does not flag a known function within its documented argument count", () => {
    const src = ['{ "v": $ToJson($x $y) }', "<% if $ok { %>", "<% } %>"].join("\n");
    assert.deepEqual(only(src, "unknown-scalar-function"), []);
    assert.deepEqual(only(src, "too-many-arguments"), []);
  });

  it("does not flag plain literal text around an embedded call", () => {
    const src = [
      '{ "label": "Affected packages:", "value": $ToJson(%p.Name) }',
      "<% foreach %p in @AffectedPackages { %>",
      "<% } %>",
    ].join("\n");
    assert.deepEqual(diagnose(src), []);
  });
});

// ============================================================
// Adaptive Card checks are wired into updateDiagnostics, gated on templateAware
// ============================================================
// Deeper coverage of the check itself lives in test/unit/adaptivecard.test.js;
// this just confirms updateDiagnostics actually calls it (with `text`, inside
// the templateAware branch) and the diagnostic reaches the collection.

describe("updateDiagnostics - Adaptive Card checks", () => {
  it("flags an unknown Adaptive Card type when the document is template-aware", () => {
    const src = [
      '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlok" } ] }',
      "<% if $ok { %>",
      "<% } %>",
    ].join("\n");
    const [d] = only(src, "adaptivecard-unknown-type");
    assert.ok(d);
    assert.equal(d.message, "Unknown Adaptive Card type 'TextBlok'.");
  });

  it("does not run at all when the document is not template-aware (no real <% %>)", () => {
    // No <% %> anywhere -- documentUsesTemplateTags() is false, so
    // updateDiagnostics never calls findAdaptiveCardDiagnostics, even though
    // this text alone would otherwise trigger it.
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlok" } ] }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });
});

// ============================================================
// implicit-string juxtaposition inside %( ) / @( ) is VALID -- not a diagnostic
// ============================================================
// Phase 2 shipped a "missing-operator" check flagging `%( v: $a $b )` as two
// operands with no `+`. Per Inedo's own docs (executionengine/otterscript/
// strings-and-literals.md): "there is no need for things like string
// concatenation: just put the variables next to each other ... and they will
// be evaluated at runtime as expected." An implicit string is delimited by a
// comma / right-paren / right-brace / semicolon -- exactly a map value or
// vector element position -- so `$a $b` there is ONE implicit-string value
// (concatenated at runtime), not a parse error. The check was removed; these
// tests pin that such code stays clean.

describe("updateDiagnostics - implicit-string juxtaposition (not a diagnostic)", () => {
  it("does not flag adjacent $/@ tokens inside a map value or vector element", () => {
    for (const src of [
      "$m = %( v: $a $b );",
      "@v = @( $a $b );",
      "@v = @( $a $b $c );",
      "$m = %( v: $a + $b $c );",
      "$m = %( a: $x, b: $y );",
      "$m = %( k: $a );",
      "$m = %( v: $ToJson($a), w: 1 );",
    ]) {
      assert.deepEqual(diagnose(src).map((d) => d.code), [], src);
    }
  });
});

// ============================================================
// checkMissingDollar
// ============================================================

/** The literal words an `if` condition may use bare. */
const LITERALS = new Set(["true", "false", "null"]);

describe("checkMissingDollar", () => {
  it("flags a bare variable on the left of an if comparison", () => {
    const diag = checkMissingDollar("if x == 5", 0, LITERALS);
    assert.ok(diag, "expected a diagnostic");
    assert.equal(diag.code, "missing-dollar");
    assert.equal(diag.source, "OtterScript");
    assert.equal(diag.severity, DiagnosticSeverity.Error);
    assert.match(diag.message, /\$x/);
    assert.equal(diag.range.start.line, 0);
    assert.equal(diag.range.start.character, 3, "points at 'x'");
    assert.equal(diag.range.end.character, 4);
  });

  it("returns null when the variable already has a '$'", () => {
    assert.equal(checkMissingDollar("if $x == 5", 0, LITERALS), null);
  });

  it("returns null for boolean/null literals", () => {
    assert.equal(checkMissingDollar("if true == 1", 0, LITERALS), null);
    assert.equal(checkMissingDollar("if null != 1", 0, LITERALS), null);
  });

  it("returns null for non-if lines", () => {
    assert.equal(checkMissingDollar("set $x = 5", 0, LITERALS), null);
    assert.equal(checkMissingDollar("foreach $s in @servers", 0, LITERALS), null);
  });

  it("sees through leading parentheses", () => {
    const diag = checkMissingDollar("if (count > 3", 0, LITERALS);
    assert.ok(diag);
    assert.equal(diag.range.start.character, 4, "points past '('");
    assert.equal(diag.range.end.character, 9);
  });

  it("accounts for leading indentation and reports the given line index", () => {
    const diag = checkMissingDollar("    if ready == false", 7, LITERALS);
    assert.ok(diag);
    assert.equal(diag.range.start.line, 7);
    assert.equal(diag.range.start.character, 7);
  });

  it("handles the various comparison operators", () => {
    for (const op of ["=", "==", "!=", "<", ">", "<=", ">="]) {
      assert.ok(checkMissingDollar(`if x ${op} 1`, 0, LITERALS), `operator ${op}`);
    }
  });
});

// ============================================================
// findDuplicateMapKeyDiagnosticsFromMasked
// ============================================================

describe("findDuplicateMapKeyDiagnosticsFromMasked", () => {
  /** @param {string} src */
  const run = (src) => findDuplicateMapKeyDiagnosticsFromMasked(makeDocument(src), src);

  it("reports the second occurrence of a repeated top-level key", () => {
    const src = "%( a: 1, b: 2, a: 3 )";
    const diags = run(src);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].code, "duplicate-map-key");
    assert.equal(diags[0].source, "OtterScript");
    assert.equal(diags[0].severity, DiagnosticSeverity.Warning);
    assert.match(diags[0].message, /Duplicate key 'a'/);
    // range points at the duplicate 'a', i.e. the second one
    assert.equal(diags[0].range.start.character, src.lastIndexOf("a"));
  });

  it("does not report when every key is unique", () => {
    assert.deepEqual(run("%( a: 1, b: 2, c: 3 )"), []);
  });

  it("ignores keys nested inside a child map", () => {
    // inner 'a' is nested; only the outer 'a' repeats
    const diags = run("%( a: 1, b: %( a: 9 ), a: 2 )");
    assert.equal(diags.length, 1);
    assert.match(diags[0].message, /Duplicate key 'a'/);
  });

  it("reports a duplicate inside a map nested in another map", () => {
    const src = "%( x: %( a: 1, a: 2 ) )";
    const diags = run(src);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].range.start.character, src.lastIndexOf("a"));
  });

  it("reports duplicates independently per map expression", () => {
    const diags = run("x = %( a: 1, a: 2 ); y = %( b: 1, b: 2 )");
    assert.equal(diags.length, 2);
    assert.deepEqual(diags.map((d) => d.message).sort(), [
      "Duplicate key 'a' in map expression.",
      "Duplicate key 'b' in map expression.",
    ]);
  });

  it("accepts dashes in key names", () => {
    assert.equal(run("%( my-key: 1, my-key: 2 )").length, 1);
  });

  it("reports a third occurrence too", () => {
    assert.equal(run("%( a: 1, a: 2, a: 3 )").length, 2);
  });

  it("does not crash on an unclosed '%(' (no matching ')')", () => {
    assert.deepEqual(run("$m = %( a: 1, a: 2"), []);
  });
});

// ============================================================
// createUnbalancedDiagnostic
// ============================================================

describe("createUnbalancedDiagnostic", () => {
  const doc = makeDocument("line one\nline two three");

  it("describes unclosed openers", () => {
    const d = createUnbalancedDiagnostic(2, 0, "{", "}", "brace", doc);
    assert.ok(d);
    assert.match(d.message, /Unclosed brace\(s\): 2 '\{' not closed \(first at line 1, col 1\)/);
    assert.equal(d.severity, DiagnosticSeverity.Error);
    assert.equal(d.source, "OtterScript");
  });

  it("describes an unexpected closer (negative count)", () => {
    const d = createUnbalancedDiagnostic(-1, 9, "(", ")", "parenthesis", doc);
    assert.ok(d);
    assert.match(d.message, /Unexpected closing parenthesis: Extra '\)' at line 2, col 1/);
  });

  it("returns null when balanced", () => {
    assert.equal(createUnbalancedDiagnostic(0, 0, "{", "}", "brace", doc), null);
  });
});

// ============================================================
// getDiagnosticCode
// ============================================================

describe("getDiagnosticCode", () => {
  it("normalizes string / {value} / number / missing", () => {
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: "missing-dollar" })), "missing-dollar");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: { value: "x", target: {} } })), "x");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: 42 })), "42");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: undefined })), "");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({})), "");
  });
});
