// @ts-check
/**
 * @fileoverview Unit tests for src/providers/navigation.js: the folding
 * ranges and their kinds.
 *
 * Requires the vscode stub before navigation.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { FoldingRangeKind } = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { computeFoldingRanges } = require("../../src/providers/navigation.js");

/**
 * A fake `vscode.TextDocument` backed by a plain string (see fake-document.js).
 *
 * @param {string} text
 * @returns {any}
 */
const makeDoc = (text) => makeDocument(text);

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
    assert.equal(ranges[0].kind, undefined, "not a Region: Fold All Regions is for #region");
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

  it("folds a multi-line swim-string, with no kind", () => {
    const ranges = run(["$s = >END>", "line one", "line two", ">END>;"].join("\n"));
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges[0].end, 3);
    assert.equal(ranges[0].kind, undefined);
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
    assert.equal(ranges[0].kind, undefined);
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
