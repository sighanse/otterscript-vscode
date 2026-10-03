// @ts-check
/**
 * @fileoverview Unit tests for the quick fixes of src/providers/code-actions.js:
 * each fix factory's edit, the closest-name suggestions and the
 * missing-argument fix.
 *
 * Requires the vscode stub before code-actions.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position } = require("../vscode-stub");
const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
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

/**
 * A fake `vscode.TextDocument` backed by a plain string (see fake-document.js).
 *
 * @param {string} text
 * @returns {any}
 */
const makeDoc = (text) => makeDocument(text);

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
    assert.equal(fix.isPreferred, false, "a guess: left to the lightbulb, not Fix All");
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
    assert.equal(fix.isPreferred, true, "only the casing: Fix All applies it");
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
