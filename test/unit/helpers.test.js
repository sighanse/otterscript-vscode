// @ts-check
/**
 * @fileoverview Unit tests for the diagnostic/folding helpers in src/helpers.js
 * that build `vscode.*` value objects.
 *
 * These require the `vscode` module stub (test/vscode-stub.js) to be installed
 * before helpers.js is loaded — hence the ordering of the requires below.
 *
 * Covered:
 *   - checkMissingDollar
 *   - findDuplicateMapKeyDiagnosticsFromMasked
 *   - computeFoldingRanges
 *   - buildHoverMarkdown / buildCompletionItem
 *   - nearestNamespace / createUnknownNamespaceFix
 *   - the other quick-fix factories, createUnbalancedDiagnostic, getDiagnosticCode
 *   - validateDocs, createRegexPatterns
 *   - getTypedIdentifier, isInStringOrCommentDoc, isValidCompletionPosition
 *   - loadConfig, scheduleTimerForUri / clearTimerForUri
 *   - mapWithConcurrency
 */

require("../vscode-stub");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  Position,
  DiagnosticSeverity,
  FoldingRangeKind,
} = require("../vscode-stub");
const stub = require("../vscode-stub");
const {
  checkMissingDollar,
  findDuplicateMapKeyDiagnosticsFromMasked,
  computeFoldingRanges,
  buildHoverMarkdown,
  buildCompletionItem,
  nearestNamespace,
  createUnknownNamespaceFix,
  createMissingDollarFix,
  createInvalidOperatorFix,
  createAssignmentInConditionFix,
  createForToForeachFix,
  createUnbalancedDiagnostic,
  getDiagnosticCode,
  validateDocs,
  createRegexPatterns,
  getTypedIdentifier,
  isInStringOrCommentDoc,
  isValidCompletionPosition,
  loadConfig,
  scheduleTimerForUri,
  clearTimerForUri,
  mapWithConcurrency,
} = require("../../src/helpers.js");

const LITERALS = new Set(["true", "false", "null"]);

/**
 * A `vscode.Position`-shaped value typed as `any` for calls into helpers whose
 * JSDoc declares a real `vscode.Position` parameter.
 *
 * @param {number} line
 * @param {number} character
 * @returns {any}
 */
const pos = (line, character) => new Position(line, character);

/**
 * Builds a stand-in for `vscode.TextDocument` backed by a plain string.
 * Returned as `any` so call sites don't need the full TextDocument shape.
 *
 * @param {string} text
 * @returns {any}
 */
function makeDoc(text) {
  const lines = text.split("\n");
  /** @param {{ line: number, character: number }} p */
  const offsetAt = (p) => {
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  };
  /** @param {number} offset */
  const positionAt = (offset) => {
    let remaining = Math.max(0, offset);
    let line = 0;
    while (line < lines.length - 1 && remaining > lines[line].length) {
      remaining -= lines[line].length + 1; // +1 for the '\n'
      line++;
    }
    return new Position(line, remaining);
  };
  return {
    uri: { toString: () => "file:///t.otter", fsPath: "/t.otter" },
    lineCount: lines.length,
    offsetAt,
    positionAt,
    /** @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} [range] */
    getText: (range) => (range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text),
    /** @param {number} i */
    lineAt: (i) => ({ text: lines[i], range: { start: new Position(i, 0), end: new Position(i, lines[i].length) } }),
  };
}

// ============================================================
// checkMissingDollar
// ============================================================

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
  const run = (src) => findDuplicateMapKeyDiagnosticsFromMasked(makeDoc(src), src);

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
// computeFoldingRanges
// ============================================================

describe("computeFoldingRanges", () => {
  /** @param {string} src */
  const run = (src) => computeFoldingRanges(makeDoc(src));

  it("folds a multi-line brace block", () => {
    const ranges = run(["if $x {", "  Log-Info foo;", "}"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 2);
    assert.equal(ranges[0].kind, FoldingRangeKind.Region);
  });

  it("does not fold a single-line brace block", () => {
    assert.deepEqual(run("if $x { Log-Info foo; }"), []);
  });

  it("folds a #region / #endregion pair", () => {
    const ranges = run(["#region setup", "$x = 1;", "$y = 2;", "#endregion"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
    assert.equal(ranges[0].kind, FoldingRangeKind.Region);
  });

  it("folds a multi-line block comment as a Comment range", () => {
    const ranges = run(["/* first", " * second", " */ code"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 2);
    assert.equal(ranges[0].kind, FoldingRangeKind.Comment);
  });

  it("folds a multi-line swim-string as a Region range", () => {
    const ranges = run(["$s = >END>", "line one", "line two", ">END>;"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
  });

  it("ignores braces that live inside string literals", () => {
    const ranges = run(['$open = "{";', "$mid = 1;", '$close = "}";'].join("\n"));
    assert.deepEqual(ranges, []);
  });

  it("folds a multi-line map literal", () => {
    const ranges = run(["$m = %(", "  a: 1,", "  b: 2", ")"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
  });

  it("folds a multi-line <% %> template tag", () => {
    const ranges = run(["<%", "  Log-Information $x;", "%>"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 2);
    assert.equal(ranges[0].kind, FoldingRangeKind.Region);
  });

  it("returns nested brace ranges, innermost first", () => {
    const ranges = run(["a {", "  b {", "    c;", "  }", "}"].join("\n"));
    assert.equal(ranges.length, 2);
    // inner block closes first, so it is pushed first
    assert.deepEqual(ranges.map((r) => [r.start, r.end]), [
      [1, 3],
      [0, 4],
    ]);
  });
});

// ============================================================
// buildHoverMarkdown — namespace line
// ============================================================

describe("buildHoverMarkdown (namespace provenance)", () => {
  it("adds a **Namespace:** line for an entry that has one", () => {
    const md = buildHoverMarkdown({
      name: "Create-Directory",
      signature: "Create-Directory(Path: <text>)",
      description: "Creates a subdirectory in an asset directory.",
      namespace: "ProGet",
    });
    assert.match(md.value, /\*\*Namespace:\*\* `ProGet`/);
  });

  it("omits the line when namespace is null (language construct)", () => {
    const md = buildHoverMarkdown({ name: "if", description: "Conditional.", namespace: null });
    assert.doesNotMatch(md.value, /Namespace:/);
  });

  it("omits the line when namespace is absent", () => {
    const md = buildHoverMarkdown({ name: "x", description: "y" });
    assert.doesNotMatch(md.value, /Namespace:/);
  });
});

// ============================================================
// nearestNamespace
// ============================================================

describe("nearestNamespace", () => {
  it("returns the canonical casing for a case-only mismatch", () => {
    assert.equal(nearestNamespace("proget"), "ProGet");
    assert.equal(nearestNamespace("WINDOWS"), "Windows");
  });

  it("corrects a small typo (insertion, substitution, transposition)", () => {
    assert.equal(nearestNamespace("PowerShel"), "PowerShell");
    assert.equal(nearestNamespace("Windoze"), "Windows");
    assert.equal(nearestNamespace("Dokcer"), "Docker");
    assert.equal(nearestNamespace("filez"), "Files");
  });

  it("returns null for a token that is not a plausible typo of any namespace", () => {
    assert.equal(nearestNamespace("Frobnicate"), null);
    assert.equal(nearestNamespace("Xyzzy"), null);
  });
});

// ============================================================
// createUnknownNamespaceFix
// ============================================================

describe("createUnknownNamespaceFix", () => {
  /**
   * @param {string} line
   * @param {number} start
   * @param {number} end
   */
  const fixFor = (line, start, end) => {
    const doc = makeDoc(line);
    const diagnostic = /** @type {any} */ ({
      range: { start: new Position(0, start), end: new Position(0, end) },
      code: "unknown-namespace",
      source: "OtterScript",
    });
    return createUnknownNamespaceFix(doc, diagnostic);
  };

  it("replaces the token with the nearest known namespace", () => {
    const fix = /** @type {any} */ (fixFor("Windoze::Sign-Exe (SubjectName: x);", 0, 7));
    assert.ok(fix);
    assert.equal(fix.title, "Change namespace to 'Windows'");
    const [op, , range, newText] = fix.edit.edits[0];
    assert.equal(op, "replace");
    assert.equal(newText, "Windows");
    assert.equal(range.start.character, 0);
    assert.equal(range.end.character, 7);
  });

  it("fixes a case-only mismatch to canonical casing", () => {
    const fix = fixFor("proget::Install-Package (Name: x);", 0, 6);
    assert.ok(fix);
    assert.equal(fix.title, "Change namespace to 'ProGet'");
  });

  it("returns null when nothing is close enough to suggest", () => {
    assert.equal(fixFor("Frobnicate::Do-Thing x;", 0, 10), null);
  });
});

// ============================================================
// mapWithConcurrency
// ============================================================

describe("mapWithConcurrency", () => {
  it("visits every item exactly once", async () => {
    /** @type {number[]} */
    const seen = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(peak, 4);
  });

  it("is a no-op for an empty list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 8, async () => { calls++; });
    assert.equal(calls, 0);
  });

  it("clamps a limit below 1 up to 1", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(peak, 1);
  });

  it("caps workers at the item count when limit exceeds it", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 50, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(peak, 2);
  });

  it("rejects when a worker rejects", async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
      /boom/
    );
  });
});

// ============================================================
// validateDocs
// ============================================================

describe("validateDocs", () => {
  // validateDocs mirrors its findings to the console via the logger.
  const realWarn = console.warn;
  const realError = console.error;
  before(() => { console.warn = () => {}; console.error = () => {}; });
  after(() => { console.warn = realWarn; console.error = realError; });

  const good = { name: "X", description: "does X", namespace: null };

  it("passes a well-formed table", () => {
    const { errors, warnings } = validateDocs("t", { X: good });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
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
});

// ============================================================
// createRegexPatterns
// ============================================================

describe("createRegexPatterns", () => {
  const rx = createRegexPatterns(new Set(["Log-Information", "Copy-Files"]));

  it("scalarCallRegex matches '$Name(' and captures the name", () => {
    const m = [...String.raw`x = $ToJson( $y`.matchAll(rx.scalarCallRegex())];
    assert.deepEqual(m.map((x) => x[1]), ["ToJson"]);
  });

  it("vectorCallRegex matches '@Name('", () => {
    assert.equal([...'@Split("a")'.matchAll(rx.vectorCallRegex())][0][1], "Split");
  });

  it("operationCallRegex yields word tokens", () => {
    assert.deepEqual(
      [...'Copy-Files x'.matchAll(rx.operationCallRegex())].map((x) => x[1]),
      ["Copy-Files", "x"]
    );
  });

  it("scalarSignatureRegex captures name + partial args at end of prefix", () => {
    const m = "set $r = $Substring(text, 1".match(rx.scalarSignatureRegex());
    assert.ok(m);
    assert.equal(m[1], "Substring");
    assert.equal(m[2], "text, 1");
  });

  it("operationSignatureRegex captures a bare and a namespaced operation", () => {
    assert.equal("Copy-Files(Include: a".match(rx.operationSignatureRegex())?.[1], "Copy-Files");
    assert.equal(
      "ProGet::Create-Directory foo (Path: b".match(rx.operationSignatureRegex())?.[1],
      "Create-Directory"
    );
  });

  it("operationSignatureRegex does NOT swallow 'set $x = ('", () => {
    assert.equal("set $x = (".match(rx.operationSignatureRegex()), null);
  });

  it("operationRegex is word-anchored over the known set", () => {
    assert.ok(rx.operationRegex().test("run Log-Information now"));
    assert.equal(rx.operationRegex().test("XLog-InformationY"), false);
  });
});

// ============================================================
// buildCompletionItem
// ============================================================

describe("buildCompletionItem", () => {
  const doc = {
    name: "$ToJson",
    description: "to JSON",
    signature: "$ToJson(data)",
    documentation: "more",
    namespace: "InedoCore",
  };
  const KIND = /** @type {any} */ ("kind-sentinel");

  it("carries the label object, kind, sortText, insertText", () => {
    const item = buildCompletionItem(doc, KIND, "1_", "snippet-text");
    assert.deepEqual(item.label, { label: "$ToJson", description: "to JSON" });
    assert.equal(item.kind, KIND);
    assert.equal(item.sortText, "1_$ToJson");
    assert.equal(item.insertText, "snippet-text");
  });

  it("detail is the signature, falling back to description", () => {
    assert.equal(buildCompletionItem(doc, KIND, "1_", "x").detail, "$ToJson(data)");
    assert.equal(
      buildCompletionItem({ name: "K", description: "d", namespace: null }, KIND, "1_", "x").detail,
      "d"
    );
  });

  it("documentation is a hover MarkdownString", () => {
    const md = /** @type {any} */ (buildCompletionItem(doc, KIND, "1_", "x").documentation);
    assert.match(md.value, /### \$ToJson/);
  });

  it("sets the signature-help trigger command only when asked", () => {
    assert.equal(buildCompletionItem(doc, KIND, "1_", "x", false).command, undefined);
    assert.deepEqual(buildCompletionItem(doc, KIND, "1_", "x", true).command, {
      command: "editor.action.triggerParameterHints",
      title: "",
    });
  });
});

// ============================================================
// quick-fix factories
// ============================================================

describe("quick-fix factories", () => {
  /** @param {number} s @param {number} e */
  const diagAt = (s, e) => /** @type {any} */ ({
    range: { start: new Position(0, s), end: new Position(0, e) },
  });

  it("createMissingDollarFix inserts '$' at the diagnostic start", () => {
    const fix = /** @type {any} */ (createMissingDollarFix(makeDoc("if x == 5"), diagAt(3, 4)));
    assert.equal(fix.title, "Insert missing '$'");
    assert.equal(fix.isPreferred, true);
    assert.equal(fix.diagnostics.length, 1);
    const [op, , at, text] = fix.edit.edits[0];
    assert.equal(op, "insert");
    assert.equal(text, "$");
    assert.equal(at.character, 3);
  });

  it("createInvalidOperatorFix: & -> &&, | -> ||, other -> null", () => {
    const amp = /** @type {any} */ (createInvalidOperatorFix(makeDoc("if $a & $b"), diagAt(6, 7)));
    assert.equal(amp.title, "Replace '&' with '&&'");
    assert.equal(amp.edit.edits[0][3], "&&");
    const pipe = /** @type {any} */ (createInvalidOperatorFix(makeDoc("if $a | $b"), diagAt(6, 7)));
    assert.equal(pipe.edit.edits[0][3], "||");
    assert.equal(createInvalidOperatorFix(makeDoc("if $a + $b"), diagAt(6, 7)), null);
  });

  it("createAssignmentInConditionFix: '=' -> '==', anything else -> null", () => {
    const fix = /** @type {any} */ (createAssignmentInConditionFix(makeDoc("if $x = 5"), diagAt(6, 7)));
    assert.equal(fix.title, "Replace '=' with '=='");
    assert.equal(fix.edit.edits[0][3], "==");
    assert.equal(createAssignmentInConditionFix(makeDoc("if $x == 5"), diagAt(6, 8)), null);
  });

  it("createForToForeachFix replaces 'for' with 'foreach'", () => {
    const fix = /** @type {any} */ (createForToForeachFix(makeDoc("for $x in y"), diagAt(0, 3)));
    assert.equal(fix.title, "Replace 'for' with 'foreach'");
    assert.equal(fix.edit.edits[0][3], "foreach");
  });
});

// ============================================================
// createUnbalancedDiagnostic
// ============================================================

describe("createUnbalancedDiagnostic", () => {
  const doc = makeDoc("line one\nline two three");

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
  it("normalises string / {value} / number / missing", () => {
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: "missing-dollar" })), "missing-dollar");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: { value: "x", target: {} } })), "x");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: 42 })), "42");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({ code: undefined })), "");
    assert.equal(getDiagnosticCode(/** @type {any} */ ({})), "");
  });
});

// ============================================================
// getTypedIdentifier
// ============================================================

describe("getTypedIdentifier", () => {
  it("extracts the fragment after a '$' / '@' trigger", () => {
    assert.equal(getTypedIdentifier(makeDoc("x = $To"), pos(0, 7), "$"), "To");
    assert.equal(getTypedIdentifier(makeDoc("@Sp"), pos(0, 3), "@"), "Sp");
  });

  it("returns '' right after the bare sigil", () => {
    assert.equal(getTypedIdentifier(makeDoc("$"), pos(0, 1), "$"), "");
  });

  it("returns null when the sigil is not immediately before the cursor", () => {
    assert.equal(getTypedIdentifier(makeDoc("xyz"), pos(0, 3), "$"), null);
  });
});

// ============================================================
// isInStringOrCommentDoc / isValidCompletionPosition
// ============================================================

describe("isInStringOrCommentDoc", () => {
  it("is true inside a string, false in code", () => {
    assert.equal(isInStringOrCommentDoc(makeDoc('a = "bcd'), pos(0, 6)), true);
    assert.equal(isInStringOrCommentDoc(makeDoc("if $x == 5"), pos(0, 5)), false);
  });

  it("carries a block comment opened on a previous line", () => {
    const doc = makeDoc("/* c\nstill inside\n*/ code");
    assert.equal(isInStringOrCommentDoc(doc, pos(1, 3)), true);
    assert.equal(isInStringOrCommentDoc(doc, pos(2, 4)), false);
  });
});

describe("isValidCompletionPosition", () => {
  it("is false when completion is disabled", () => {
    assert.equal(isValidCompletionPosition(makeDoc("code"), pos(0, 2), false), false);
  });

  it("is false inside a string, true in code", () => {
    assert.equal(isValidCompletionPosition(makeDoc('"str'), pos(0, 3), true), false);
    assert.equal(isValidCompletionPosition(makeDoc("code"), pos(0, 2), true), true);
  });
});

// ============================================================
// loadConfig
// ============================================================

describe("loadConfig", () => {
  it("defaults every feature to enabled", () => {
    assert.deepEqual(loadConfig(), {
      completionEnabled: true,
      hoverEnabled: true,
      signatureHelpEnabled: true,
      codeLensEnabled: true,
      workspaceSymbolsEnabled: true,
    });
  });

  it("reflects an overridden setting", () => {
    const original = stub.workspace.getConfiguration;
    stub.workspace.getConfiguration = () => ({
      get: (/** @type {string} */ key, /** @type {unknown} */ fallback) =>
        key === "hover.enable" ? false : fallback,
    });
    try {
      const cfg = loadConfig();
      assert.equal(cfg.hoverEnabled, false);
      assert.equal(cfg.completionEnabled, true);
    } finally {
      stub.workspace.getConfiguration = original;
    }
  });
});

// ============================================================
// scheduleTimerForUri / clearTimerForUri
// ============================================================

describe("timer helpers", () => {
  const uri = /** @type {any} */ ({ toString: () => "file:///timer.otter" });

  it("fires the callback after the delay and clears its own map entry", async () => {
    /** @type {Map<string, any>} */
    const map = new Map();
    let fired = false;
    scheduleTimerForUri(map, uri, 5, () => { fired = true; });
    assert.equal(map.size, 1);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fired, true);
    assert.equal(map.size, 0);
  });

  it("clearTimerForUri cancels a pending callback", async () => {
    /** @type {Map<string, any>} */
    const map = new Map();
    let fired = false;
    scheduleTimerForUri(map, uri, 20, () => { fired = true; });
    clearTimerForUri(map, uri);
    assert.equal(map.size, 0);
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(fired, false);
  });

  it("rescheduling replaces the previous timer", async () => {
    /** @type {Map<string, any>} */
    const map = new Map();
    /** @type {string[]} */
    const calls = [];
    scheduleTimerForUri(map, uri, 20, () => calls.push("first"));
    scheduleTimerForUri(map, uri, 20, () => calls.push("second"));
    await new Promise((r) => setTimeout(r, 55));
    assert.deepEqual(calls, ["second"]);
  });
});
