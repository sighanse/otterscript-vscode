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
 *   - findDuplicateMapKeyDiagnosticsFromMasked (+ the findDuplicateMapKeyDiagnostics wrapper)
 *   - computeFoldingRanges
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  Position,
  DiagnosticSeverity,
  FoldingRangeKind,
} = require("../vscode-stub");
const {
  checkMissingDollar,
  findDuplicateMapKeyDiagnostics,
  findDuplicateMapKeyDiagnosticsFromMasked,
  computeFoldingRanges,
} = require("../../src/helpers.js");

const LITERALS = new Set(["true", "false", "null"]);

/**
 * Builds a stand-in for `vscode.TextDocument` backed by a plain string.
 * Returned as `any` so call sites don't need the full TextDocument shape.
 *
 * @param {string} text
 * @returns {any}
 */
function makeDoc(text) {
  const lines = text.split("\n");
  return {
    lineCount: lines.length,
    getText: () => text,
    /** @param {number} i */
    lineAt: (i) => ({ text: lines[i], range: { start: new Position(i, 0), end: new Position(i, lines[i].length) } }),
    /** @param {number} offset */
    positionAt: (offset) => {
      let remaining = Math.max(0, offset);
      let line = 0;
      while (line < lines.length - 1 && remaining > lines[line].length) {
        remaining -= lines[line].length + 1; // +1 for the '\n'
        line++;
      }
      return new Position(line, remaining);
    },
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
});

describe("findDuplicateMapKeyDiagnostics (wrapper)", () => {
  it("masks the source itself before scanning, so map-shaped text in a comment is ignored", () => {
    const doc = makeDoc('%( a: 1, a: 2 ) # note: a: 3, a: 4 not real keys');
    const diags = findDuplicateMapKeyDiagnostics(doc);
    assert.equal(diags.length, 1, "only the real duplicate in the map counts");
  });

  it("defaults its source argument to document.getText()", () => {
    const diags = findDuplicateMapKeyDiagnostics(makeDoc("%( k: 1, k: 2 )"));
    assert.equal(diags.length, 1);
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
