// @ts-check
/**
 * @fileoverview Unit tests for the helpers that build `vscode.*` value
 * objects: in src/helpers.js, and the diagnostic checks (diagnostics.js),
 * quick fixes (providers/code-actions.js) and folding (providers/navigation.js)
 * that used to live there.
 *
 * These require the `vscode` module stub (test/vscode-stub.js) to be installed
 * before those modules load — hence the ordering of the requires below.
 *
 * Covered:
 *   - checkMissingDollar
 *   - findDuplicateMapKeyDiagnosticsFromMasked
 *   - computeFoldingRanges
 *   - buildHoverMarkdown / buildCompletionItem
 *   - nearestNamespace / createUnknownNamespaceFix
 *   - the other quick-fix factories, createUnbalancedDiagnostic, getDiagnosticCode
 *   - validateDocs (test/unit/validate-docs.js), signature-help's call regexes
 *   - getTypedIdentifier, isInStringOrCommentDoc, isValidCompletionPosition
 *   - loadConfig, scheduleTimerForUri / clearTimerForUri
 *   - mapWithConcurrency
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  Position,
  DiagnosticSeverity,
  FoldingRangeKind,
} = require("../vscode-stub");
const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { advanceScanState, createCodeScanState, isInStringOrComment } = require("../../src/scanner.js");
const {
  buildCompletionItem,
  buildHoverMarkdown,
  buildArgumentHoverMarkdown,
  buildSigilCompletionItems,
  clearTimerForUri,
  getTypedIdentifier,
  isValidCompletionPosition,
  loadConfig,
  lookupOwn,
  mapWithConcurrency,
  scheduleTimerForUri,
} = require("../../src/helpers.js");
const { validateDocs } = require("./validate-docs");
const { FUNCTION_SIGNATURE_REGEX, OPERATION_SIGNATURE_REGEX, activeParameterIndex, findSignatureCall } = require("../../src/providers/signature-help.js");
const { isInStringOrCommentDoc } = require("../../src/document-index.js");
const {
  checkMissingDollar,
  createUnbalancedDiagnostic,
  findDuplicateMapKeyDiagnosticsFromMasked,
  getDiagnosticCode,
} = require("../../src/diagnostics.js");
const {
  createAssignmentInConditionFix,
  createForToForeachFix,
  createInvalidOperatorFix,
  createMissingArgumentFix,
  createMissingDollarFix,
  createTemplateEndFix,
  createUnknownArgumentFix,
  createUnknownFunctionFix,
  createUnknownNamespaceFix,
  createUnknownOperationFix,
  nearestNamespace,
} = require("../../src/providers/code-actions.js");
const { computeFoldingRanges } = require("../../src/providers/navigation.js");

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
 * A fake `vscode.TextDocument` backed by a plain string (see fake-document.js).
 *
 * @param {string} text
 * @returns {any}
 */
const makeDoc = (text) => makeDocument(text);

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

describe("buildHoverMarkdown (other products' forms)", () => {
  it("lists each overload under its product, after the signature", () => {
    const md = buildHoverMarkdown({
      name: "$PackageHash",
      signature: "$PackageHash([format], [algorithm])",
      overloads: [{ product: "BuildMaster", signature: "$PackageHash(packageName, [sourceName])" }],
    });
    const value = /** @type {any} */ (md).value;
    assert.ok(value.indexOf("**Signature:** `$PackageHash([format], [algorithm])`") < value.indexOf("**In BuildMaster:** `$PackageHash(packageName, [sourceName])`"));
  });
});

describe("buildHoverMarkdown (otterscript.product and anySigil)", () => {
  /** @param {any} md */
  const text = (md) => md.value;

  it("notes, under the name, when the entry isn't in the selected product", () => {
    const doc = { name: "$ReleaseName", signature: "$ReleaseName", products: ["BuildMaster"] };
    const value = text(buildHoverMarkdown(doc, "Otter"));
    assert.match(value, /^### \$ReleaseName\n\n⚠️ \*\*Not in Otter:\*\* only in BuildMaster/);
    assert.doesNotMatch(text(buildHoverMarkdown(doc, "BuildMaster")), /Not in/);
    assert.doesNotMatch(text(buildHoverMarkdown(doc)), /Not in/, "'any' by default");
    assert.doesNotMatch(text(buildHoverMarkdown({ ...doc, products: ["Otter", "BuildMaster"] }, "ProGet")), /Not in/, "core engine");
  });

  it("says when a function works with every sigil", () => {
    assert.match(text(buildHoverMarkdown({ name: "@FromJson", anySigil: true })), /Works with `\$`, `@` and `%`/);
    assert.doesNotMatch(text(buildHoverMarkdown({ name: "$ToJson" })), /Works with/);
  });
});

describe("buildHoverMarkdown / buildArgumentHoverMarkdown (operation arguments)", () => {
  const params = [
    { name: "To", required: true, description: "Target directory", format: "text" },
    { name: "Verbose", required: false, format: "true/false" },
  ];

  it("lists an operation's arguments, unless its documentation has its own list", () => {
    const value = /** @type {any} */ (buildHoverMarkdown({ name: "Copy-Files", params, documentation: "*From Inedo's reference.*" })).value;
    assert.ok(value.includes("**Arguments:**\n- `To` (required, text) - Target directory\n- `Verbose` (optional, true/false)\n"), value);
    assert.ok(value.indexOf("**Arguments:**") < value.indexOf("*From Inedo's"));
    const own = /** @type {any} */ (buildHoverMarkdown({ name: "Copy-Files", params, documentation: "**Arguments:**\n- hand-written" })).value;
    assert.equal(own.split("**Arguments:**").length, 2, "listed once");
  });

  it("documents one argument with its operation", () => {
    const value = /** @type {any} */ (buildArgumentHoverMarkdown("Copy-Files", params[0])).value;
    assert.match(value, /### To\n\nArgument of `Copy-Files`: `To` \(required, text\) - Target directory/);
  });
});

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
// Name suggestions and missing arguments
// ============================================================

describe("name-suggestion and missing-argument fixes", () => {
  /**
   * The fix `factory` offers for a diagnostic over `[start, end)` of `text`'s
   * line `line`.
   *
   * @param {(doc: any, diagnostic: any) => any} factory
   * @param {string} text
   * @param {number} start
   * @param {number} end
   * @param {number} [line]
   * @returns {any}
   */
  const fixFor = (factory, text, start, end, line = 0) =>
    factory(makeDoc(text), { range: new stub.Range(new Position(line, start), new Position(line, end)), source: "OtterScript" });
  /**
   * `text` with the fix's edits applied.
   *
   * @param {any} fix
   * @param {string} text
   * @returns {string}
   */
  const applied = (fix, text) => {
    const doc = makeDoc(text);
    const edits = fix.edit.edits.map((/** @type {any} */ [op, , where, newText]) => {
      const start = doc.offsetAt(op === "insert" ? where : where.start);
      return { start, end: op === "insert" ? start : doc.offsetAt(where.end), newText };
    });
    return edits.sort((/** @type {any} */ a, /** @type {any} */ b) => b.start - a.start)
      .reduce((/** @type {string} */ out, /** @type {any} */ e) => out.slice(0, e.start) + e.newText + out.slice(e.end), text);
  };
  /**
   * @param {any} doc
   * @param {any} diagnostic
   */
  const anyProduct = (doc, diagnostic) => createUnknownFunctionFix(doc, diagnostic, "any");

  it("changes an unknown function to the closest of its sigil, preferred only for a casing difference", () => {
    const fix = fixFor(anyProduct, "set $s = $Substrng($x, 1);", 10, 18);
    assert.equal(fix.title, "Change to '$Substring'");
    assert.equal(fix.isPreferred, false);
    assert.equal(applied(fix, "set $s = $Substrng($x, 1);"), "set $s = $Substring($x, 1);");
    assert.equal(fixFor(anyProduct, "set $s = $substring($x, 1);", 10, 19).isPreferred, true);
    assert.equal(fixFor(anyProduct, "set @l = @Splitt($x);", 10, 16).title, "Change to '@Split'");
    assert.equal(fixFor(anyProduct, "set $s = $Frobnicate();", 10, 20), null);
  });

  it("changes an unknown operation to the closest one, in the namespace written", () => {
    /**
     * @param {any} doc
     * @param {any} diagnostic
     */
    const factory = (doc, diagnostic) => createUnknownOperationFix(doc, diagnostic, "any");
    assert.equal(fixFor(factory, "Copy-Fils(To: $x);", 0, 9).title, "Change to 'Copy-Files'");
    assert.equal(fixFor(factory, "ProGet::Create-Directori(Path: x);", 8, 24).title, "Change to 'Create-Directory'");
    assert.equal(fixFor(factory, "Frobnicate-Everything;", 0, 21), null);
  });

  it("changes a misspelt argument name to the documented one", () => {
    const text = 'Copy-Files(Fomr: "a", To: "b");';
    const fix = fixFor(createUnknownArgumentFix, text, 11, 15);
    assert.equal(fix.title, "Change to 'From'");
    assert.equal(applied(fix, text), 'Copy-Files(From: "a", To: "b");');
  });

  it("adds the missing required arguments after the last one, on lines of their own in a multi-line call", () => {
    /**
     * @param {string} text
     * @param {number} start - Of the operation name, on line 0
     * @param {number} end
     */
    const add = (text, start, end) => {
      const fix = fixFor(createMissingArgumentFix, text, start, end);
      assert.equal(fix.isPreferred, false, "the values are the user's to write");
      return applied(fix, text);
    };
    assert.equal(add('Copy-Files(From: "a, b");', 0, 10), 'Copy-Files(From: "a, b", To: );');
    assert.equal(add("Copy-Files();", 0, 10), "Copy-Files(To: );");
    assert.equal(add('Copy-Files(\n    From: "a" # (source)\n);', 0, 10), 'Copy-Files(\n    From: "a", # (source)\n    To: \n);');
    assert.equal(add('Copy-Files(\n    Include: @("*"),\n);', 0, 10), 'Copy-Files(\n    Include: @("*"),\n    To: \n);');
    assert.equal(add('Jira::Create-Issue(Title: "x");', 6, 18), 'Jira::Create-Issue(Title: "x", Type: );');
    // A block comment that goes on past the line: on the same line, not in the comment.
    assert.equal(add('Copy-Files(\n    From: "a" /* source\n    folder */\n);', 0, 10),
      'Copy-Files(\n    From: "a", To:  /* source\n    folder */\n);');
    assert.equal(fixFor(createMissingArgumentFix, 'Copy-Files(From: "a", To: "b");', 0, 10), null, "nothing missing any more");
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
});

// ============================================================
// signature help: the call the cursor is in
// ============================================================

describe("signature help call regexes", () => {
  it("FUNCTION_SIGNATURE_REGEX captures sigil, name and partial args, but not a '%(' literal", () => {
    const m = "set %m = %ListItem(@x, ".match(FUNCTION_SIGNATURE_REGEX);
    assert.deepEqual(m?.slice(1), ["%", "ListItem", "@x, "]);
    assert.deepEqual("set $r = $Substring(text, 1".match(FUNCTION_SIGNATURE_REGEX)?.slice(1), ["$", "Substring", "text, 1"]);
    assert.equal("set %m = %(a: ".match(FUNCTION_SIGNATURE_REGEX), null);
  });

  it("OPERATION_SIGNATURE_REGEX captures a bare and a namespaced operation, not 'set $x = ('", () => {
    assert.equal("Copy-Files(Include: a".match(OPERATION_SIGNATURE_REGEX)?.[2], "Copy-Files");
    assert.deepEqual("ProGet::Create-Directory foo (Path: b".match(OPERATION_SIGNATURE_REGEX)?.slice(1, 3), ["ProGet", "Create-Directory"]);
    assert.equal("set $x = (".match(OPERATION_SIGNATURE_REGEX), null);
    assert.equal("Linux::SHEnsure2(Name: a".match(OPERATION_SIGNATURE_REGEX)?.[2], "SHEnsure2", "digits in the name");
  });

  it("activeParameterIndex follows a typed Name:, else the argument position", () => {
    const params = ["[Include: <@(text)>]", "[From: <text>]", "To: <text>"];
    assert.equal(activeParameterIndex("From: a, To: ", params), 2, "named, out of order");
    assert.equal(activeParameterIndex("a, ", params), 1, "positional");
    assert.equal(activeParameterIndex("result: ", ["name", "[out result]"]), 1, "a module's out parameter");
    assert.equal(activeParameterIndex("output-file: ", ["name", "[output-file]"]), 1, "a dashed name");
    assert.equal(activeParameterIndex("Url: $u, ResponseBody => ", ["[Method]", "Url", "[ResponseBody]"]), 2, "an output capture");
  });

  it("findSignatureCall prefers the function the cursor is in, then the operation", () => {
    assert.equal(findSignatureCall("Copy-Files(Include: $Trim(a")?.doc.name, "$Trim");
    assert.equal(findSignatureCall("Copy-Files(Include: a")?.isOperation, true);
    assert.equal(findSignatureCall("$Frobnicate(a"), null);
    // A namespace picks between same-named operations.
    assert.match(findSignatureCall("DotNet::Build(Project: a")?.doc.signature ?? "", /^Build\(Project:/);
    assert.match(findSignatureCall("Build(ProjectFile: a")?.doc.signature ?? "", /^Build\(ProjectFile:/);
  });
});

// ============================================================
// buildCompletionItem
// ============================================================

describe("buildSigilCompletionItems", () => {
  const table = {
    ToJson: { name: "$ToJson", signature: "$ToJson(data)", snippet: "\\$ToJson(${1:data})" },
    Trim: { name: "$Trim", signature: "$Trim(text)" },
    TargetDirectory: { name: "$TargetDirectory", signature: "$TargetDirectory" },
    Other: { name: "$Other", signature: "$Other()" },
  };
  const items = (/** @type {string} */ typed) =>
    buildSigilCompletionItems(/** @type {any} */ (table), typed, { functionSort: "1_", variableSort: "2_" })
      .map((i) => /** @type {any} */ (i));

  it("filters by the typed prefix, ignoring case", () => {
    assert.deepEqual(items("t").map((i) => i.label.label), ["$ToJson", "$Trim", "$TargetDirectory"]);
  });

  it("inserts without the sigil the user already typed, escaped or not", () => {
    const [toJson, trim, target] = items("t");
    assert.equal(toJson.insertText.value, "ToJson(${1:data})");
    assert.equal(trim.insertText.value, "Trim(${0})");
    assert.equal(target.insertText.value, "TargetDirectory");
  });

  it("makes functions Function items that open signature help, and the rest variables", () => {
    const [toJson, , target] = items("t");
    assert.equal(toJson.kind, "function");
    assert.equal(toJson.sortText, "1_$ToJson");
    assert.ok(toJson.command);
    assert.equal(target.kind, "variable");
    assert.equal(target.sortText, "2_$TargetDirectory");
    assert.equal(target.command, undefined);
  });
});

describe("buildCompletionItem", () => {
  const doc = {
    name: "$ToJson",
    description: "to JSON",
    signature: "$ToJson(data)",
    documentation: "more",
    namespace: null,
  };
  const KIND = /** @type {any} */ ("kind-sentinel");

  it("carries the label object, kind, sortText, insertText", () => {
    const item = buildCompletionItem(doc, KIND, "1_", "snippet-text");
    assert.deepEqual(item.label, { label: "$ToJson", description: "to JSON" });
    assert.equal(item.kind, KIND);
    assert.equal(item.sortText, "1_$ToJson");
    assert.equal(item.insertText, "snippet-text");
  });

  it("strikes a superseded name through and lists it last", () => {
    const item = buildCompletionItem({ ...doc, name: "PSCall2", superseded: { by: "PSCall", note: "n" } }, KIND, "0_", "x");
    assert.deepEqual(item.tags, [stub.CompletionItemTag.Deprecated]);
    assert.equal(item.sortText, "0_~PSCall2");
    assert.equal(buildCompletionItem(doc, KIND, "1_", "x").tags, undefined);
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
  /**
   * @param {number} s
   * @param {number} e
   */
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

  it("createForToForeachFix also works for a dashed loop variable", () => {
    assert.ok(createForToForeachFix(makeDoc("for $item-name in @list {"), diagAt(0, 3)));
  });

  it("createForToForeachFix offers nothing for the counting form, which has no foreach equivalent", () => {
    assert.equal(createForToForeachFix(makeDoc("for $i = 1 to 10 {"), diagAt(0, 3)), null);
  });

  it("createTemplateEndFix replaces the diagnostic range with '}'", () => {
    const fix = /** @type {any} */ (createTemplateEndFix(makeDoc("<% end %>"), diagAt(3, 6)));
    assert.equal(fix.title, "Replace with '}'");
    assert.equal(fix.edit.edits[0][0], "replace");
    assert.equal(fix.edit.edits[0][3], "}");
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

describe("lookupOwn", () => {
  it("returns a table's own entries only, never inherited Object members", () => {
    const table = { ToJson: { name: "$ToJson" } };
    assert.equal(lookupOwn(table, "ToJson"), table.ToJson);
    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      assert.equal(lookupOwn(table, inherited), undefined, inherited);
    }
  });
});

describe("getDiagnosticCode", () => {
  it("normalizes string / {value} / number / missing", () => {
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
  it("extracts the fragment after a '$' / '@' / '%' trigger", () => {
    assert.equal(getTypedIdentifier(makeDoc("x = $To"), pos(0, 7), "$"), "To");
    assert.equal(getTypedIdentifier(makeDoc("@Sp"), pos(0, 3), "@"), "Sp");
    assert.equal(getTypedIdentifier(makeDoc("set %m = %From"), pos(0, 14), "%"), "From");
  });

  it("takes digits, '_' and '-' in a name, as variable names have", () => {
    assert.equal(getTypedIdentifier(makeDoc("Log-Information $item2"), pos(0, 22), "$"), "item2");
    assert.equal(getTypedIdentifier(makeDoc("set @my-li"), pos(0, 10), "@"), "my-li");
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

  it("matches a fresh scan at every position, whatever order lines are asked in (cached states)", () => {
    const text = [
      'set $a = "one /* not a comment";',
      "/* block",
      "   still comment */ Log-Information $a;",
      "set $b = >>swim",
      "text >> + 'q';",
      "# line comment \"x\"",
      "end",
    ].join("\n");
    const doc = makeDoc(text);
    const lines = text.split("\n");
    /**
     * @param {number} line
     * @param {number} character
     */
    const fresh = (line, character) => {
      const state = createCodeScanState();
      for (let i = 0; i < line; i++) advanceScanState(lines[i], state);
      return isInStringOrComment(lines[line], character, state);
    };
    const positions = lines.flatMap((l, line) => [...Array(l.length + 1).keys()].map((c) => [line, c]));
    for (const [line, character] of [...positions].reverse()) {
      assert.equal(isInStringOrCommentDoc(doc, pos(line, character)), fresh(line, character), `${line}:${character}`);
    }
  });

  it("rescans when the document version changes", () => {
    let text = "/* open\nx";
    const doc = makeDoc(text);
    doc.getText = () => text;
    doc.lineAt = (/** @type {number} */ i) => ({ text: text.split("\n")[i] });
    assert.equal(isInStringOrCommentDoc(doc, pos(1, 0)), true);
    text = "// closed\nx";
    doc.version = 2;
    assert.equal(isInStringOrCommentDoc(doc, pos(1, 0)), false);
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
  it("defaults every feature to enabled, with no diagnostic rules and Teams' card version", () => {
    assert.deepEqual(loadConfig(), {
      completionEnabled: true,
      hoverEnabled: true,
      signatureHelpEnabled: true,
      codeLensEnabled: true,
      workspaceSymbolsEnabled: true,
      parameterNameHints: true,
      diagnosticRules: {},
      adaptiveCardMaxVersion: "1.6",
      product: "any",
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
