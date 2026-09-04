// @ts-check
/**
 * @fileoverview Unit tests for src/scanner.js — the vscode-free text-scanning
 * primitives that the rest of the extension builds on.
 *
 * These cover the character-classification logic (strings, line/block comments,
 * swim-strings) that has historically regressed, plus the small argument/string
 * helpers and module-name matchers. No `vscode` shim is required: scanner.js has
 * no VS Code dependency.
 *
 * Run via `npm test` (`node --test test/unit`).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCodeScanState,
  isUnescapedQuoteAt,
  scanLineState,
  maskNonCodeSpans,
  advanceScanState,
  isInStringOrComment,
  getActiveParameterIndex,
  MODULE_NAME_TOKEN_REGEX,
  MODULE_DECLARATION_REGEX,
  MODULE_CALL_TARGET_REGEX,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  findModuleDeclarations,
} = require("../../src/scanner.js");

// ============================================================
// createCodeScanState
// ============================================================

describe("createCodeScanState", () => {
  it("returns a fresh, fully-reset state", () => {
    assert.deepEqual(createCodeScanState(), {
      inString: false,
      quote: null,
      inBlockComment: false,
      swimDelimiter: null,
    });
  });

  it("returns a distinct object each call", () => {
    const a = createCodeScanState();
    const b = createCodeScanState();
    assert.notEqual(a, b);
    a.inString = true;
    assert.equal(b.inString, false);
  });
});

// ============================================================
// isUnescapedQuoteAt
// ============================================================

describe("isUnescapedQuoteAt", () => {
  it("is true when no backslash precedes the quote", () => {
    assert.equal(isUnescapedQuoteAt('a"', 1), true);
  });

  it("is true at index 0", () => {
    assert.equal(isUnescapedQuoteAt('"abc"', 0), true);
  });

  it("is false with a single (odd) preceding backslash — the quote is escaped", () => {
    assert.equal(isUnescapedQuoteAt('a\\"', 2), false);
  });

  it("is true with two (even) preceding backslashes — the backslash is escaped, not the quote", () => {
    assert.equal(isUnescapedQuoteAt('a\\\\"', 3), true);
  });

  it("is false with three (odd) preceding backslashes", () => {
    assert.equal(isUnescapedQuoteAt('a\\\\\\"', 4), false);
  });
});

// ============================================================
// maskNonCodeSpans
// ============================================================

describe("maskNonCodeSpans", () => {
  /** @param {string} line */
  const mask = (line) => maskNonCodeSpans(line, createCodeScanState());

  /**
   * Builds the expected mask by replacing `[start, end)` of `s` with spaces —
   * clearer and less error-prone than hand-counting space runs.
   *
   * @param {string} s
   * @param {number} start
   * @param {number} end
   * @returns {string}
   */
  const blank = (s, start, end) => s.slice(0, start) + " ".repeat(end - start) + s.slice(end);

  it("leaves plain code untouched", () => {
    assert.equal(mask("set $x = 1 + 2;"), "set $x = 1 + 2;");
  });

  it("preserves length for every input", () => {
    for (const line of [
      'a = "hello" + b',
      "x # trailing comment",
      "/* block */ code",
      "code // eol",
      "v = >END> body",
    ]) {
      assert.equal(maskNonCodeSpans(line, createCodeScanState()).length, line.length);
    }
  });

  it("blanks a double-quoted string including its quotes", () => {
    const line = 'a = "b c" + d';
    assert.equal(mask(line), blank(line, 4, 9));
  });

  it("blanks a single-quoted string", () => {
    const line = "a = 'b c' + d";
    assert.equal(mask(line), blank(line, 4, 9));
  });

  it("blanks a '#' line comment through end of line", () => {
    const line = 'code # comment "not a string"';
    assert.equal(mask(line), blank(line, line.indexOf("#"), line.length));
  });

  it("blanks a '//' line comment through end of line", () => {
    const line = "code // comment";
    assert.equal(mask(line), blank(line, line.indexOf("//"), line.length));
  });

  it("blanks a single-line block comment", () => {
    const line = "a /* c */ b";
    assert.equal(mask(line), blank(line, 2, 9));
  });

  it("does not treat '#' inside a string as a comment", () => {
    const line = 'x = "a # b" y';
    assert.equal(mask(line), blank(line, 4, 11));
  });

  it("keeps a string open across an escaped quote", () => {
    // "a\"b" is one 6-char string literal; the space + tail are code.
    const line = '"a\\"b" tail';
    assert.equal(mask(line), blank(line, 0, 6));
  });

  it("carries block-comment state across lines", () => {
    const state = createCodeScanState();
    const first = maskNonCodeSpans("start /* open", state);
    assert.equal(first, "start        ");
    assert.equal(state.inBlockComment, true);

    const second = maskNonCodeSpans("still comment */ end", state);
    assert.equal(second, "                 end");
    assert.equal(state.inBlockComment, false);
  });

  it("carries swim-string state across lines", () => {
    const state = createCodeScanState();
    maskNonCodeSpans("x = >END> body", state);
    assert.equal(state.swimDelimiter, ">END>");

    const closed = maskNonCodeSpans("more body >END> ;", state);
    assert.equal(closed, "                ;");
    assert.equal(state.swimDelimiter, null);
  });

  it("masks an inline swim-string with a bare '>>' delimiter", () => {
    assert.equal(maskNonCodeSpans("a >>y>> b", createCodeScanState()), "a       b");
  });

  it("does not start a swim-string when the delimiter body exceeds 5 chars", () => {
    const line = "a >TOOLONG> b";
    assert.equal(maskNonCodeSpans(line, createCodeScanState()), line);
  });
});

// ============================================================
// scanLineState / advanceScanState  (state-only, no output buffer)
// ============================================================

describe("scanLineState (state-only mode)", () => {
  it("advances state without allocating output when chars is null", () => {
    const state = createCodeScanState();
    scanLineState('open "string', state, null);
    assert.equal(state.inString, true);
    assert.equal(state.quote, '"');
  });

  it("produces the same end-state as maskNonCodeSpans", () => {
    const line = "a = 'unterminated";
    const viaMask = createCodeScanState();
    maskNonCodeSpans(line, viaMask);
    const viaState = createCodeScanState();
    scanLineState(line, viaState, null);
    assert.deepEqual(viaState, viaMask);
  });
});

describe("advanceScanState", () => {
  it("mutates state in place and returns nothing", () => {
    const state = createCodeScanState();
    const result = advanceScanState("code /* open", state);
    assert.equal(result, undefined);
    assert.equal(state.inBlockComment, true);
  });

  it("matches maskNonCodeSpans end-state line for line", () => {
    const lines = ["first /* a", "second", "third */ done", 'x = "q'];
    const a = createCodeScanState();
    const b = createCodeScanState();
    for (const line of lines) {
      advanceScanState(line, a);
      maskNonCodeSpans(line, b);
      assert.deepEqual(a, b);
    }
  });
});

// ============================================================
// isInStringOrComment
// ============================================================

describe("isInStringOrComment", () => {
  it("is false for a position in ordinary code", () => {
    assert.equal(isInStringOrComment("if $x == 5", 5), false);
  });

  it("is true for a position inside an open string", () => {
    assert.equal(isInStringOrComment('a = "bcd', 6), true);
  });

  it("is true for a position inside a '#' comment", () => {
    assert.equal(isInStringOrComment("code # note", 8), true);
  });

  it("is true for a position inside a '//' comment", () => {
    assert.equal(isInStringOrComment("code // note", 9), true);
  });

  it("is false once a string has closed before the position", () => {
    assert.equal(isInStringOrComment('"done" here', 9), false);
  });

  it("respects a carried block-comment state", () => {
    const carried = createCodeScanState();
    carried.inBlockComment = true;
    assert.equal(isInStringOrComment("anything at all", 4, carried), true);
  });

  it("does not mutate the caller's carried state", () => {
    const carried = createCodeScanState();
    carried.inString = true;
    carried.quote = '"';
    isInStringOrComment('closes" then code', 16, carried);
    assert.equal(carried.inString, true, "caller state must be treated as read-only");
  });

  it("clamps a position past end of line", () => {
    assert.equal(isInStringOrComment("short", 999), false);
  });

  it("reports an unterminated string at end of line via the trailing state check", () => {
    assert.equal(isInStringOrComment('x = "open', 9), true);
  });
});

// ============================================================
// getActiveParameterIndex
// ============================================================

describe("getActiveParameterIndex", () => {
  it("is 0 for empty argument text", () => {
    assert.equal(getActiveParameterIndex(""), 0);
  });

  it("counts top-level commas", () => {
    assert.equal(getActiveParameterIndex("a, b"), 1);
    assert.equal(getActiveParameterIndex("a, b, c"), 2);
  });

  it("ignores commas nested in parentheses", () => {
    assert.equal(getActiveParameterIndex("f(a, b), c"), 1);
  });

  it("ignores commas nested in brackets and braces", () => {
    assert.equal(getActiveParameterIndex("[a, b], {c: 1, d: 2}, e"), 2);
  });

  it("ignores commas inside strings", () => {
    assert.equal(getActiveParameterIndex("'a,b', c"), 1);
    assert.equal(getActiveParameterIndex('"x, y, z", q'), 1);
  });

  it("handles an escaped quote inside a string without ending it", () => {
    assert.equal(getActiveParameterIndex('"a\\",b", c'), 1);
  });
});

// ============================================================
// Module-name regexes & context predicates
// ============================================================

describe("module-name regexes", () => {
  it("MODULE_DECLARATION_REGEX captures the declared name", () => {
    assert.equal("module DeployApp".match(MODULE_DECLARATION_REGEX)?.[1], "DeployApp");
    assert.equal("  module  With-Dash".match(MODULE_DECLARATION_REGEX)?.[1], "With-Dash");
  });

  it("MODULE_DECLARATION_REGEX does not match a non-declaration line", () => {
    assert.equal(MODULE_DECLARATION_REGEX.test("call DeployApp"), false);
  });

  it("MODULE_CALL_TARGET_REGEX captures the target, with or without a raft prefix", () => {
    assert.equal("call DeployApp".match(MODULE_CALL_TARGET_REGEX)?.[1], "DeployApp");
    assert.equal("call MyRaft::DeployApp".match(MODULE_CALL_TARGET_REGEX)?.[1], "DeployApp");
  });

  it("MODULE_CALL_TARGET_GLOBAL_REGEX finds every call target on a line", () => {
    const found = [
      ...("call A(); call R::B()".matchAll(MODULE_CALL_TARGET_GLOBAL_REGEX)),
    ].map((m) => m[1]);
    assert.deepEqual(found, ["A", "B"]);
  });

  it("MODULE_NAME_TOKEN_REGEX matches a leading identifier token", () => {
    assert.equal("Foo-Bar rest".match(MODULE_NAME_TOKEN_REGEX)?.[0], "Foo-Bar");
  });
});

describe("isModuleDeclarationContext", () => {
  it("is true immediately after 'module '", () => {
    const line = "module ";
    assert.equal(isModuleDeclarationContext(line, line.length), true);
  });

  it("is false in a 'call' context", () => {
    const line = "call ";
    assert.equal(isModuleDeclarationContext(line, line.length), false);
  });
});

describe("isModuleCallContext", () => {
  it("is true immediately after 'call '", () => {
    const line = "call ";
    assert.equal(isModuleCallContext(line, line.length), true);
  });

  it("is true immediately after a raft prefix 'call Raft::'", () => {
    const line = "call Raft::";
    assert.equal(isModuleCallContext(line, line.length), true);
  });

  it("is false mid-identifier", () => {
    const line = "call Dep";
    assert.equal(isModuleCallContext(line, line.length), false);
  });
});

// ============================================================
// findModuleDeclarations
// ============================================================

describe("findModuleDeclarations", () => {
  it("finds every module declaration with its 0-based line and column", () => {
    const text = [
      "Log-Information 'start';",
      "module DeployApp {",
      "  call Helper;",
      "}",
      "  module  Indented-One <out $x=\"\"> {",
      "}",
    ].join("\n");
    assert.deepEqual(findModuleDeclarations(text), [
      { name: "DeployApp", line: 1, character: 7 },
      { name: "Indented-One", line: 4, character: 10 },
    ]);
  });

  it("returns an empty array when there are no declarations", () => {
    assert.deepEqual(findModuleDeclarations("call DeployApp;\nLog-Error 'x';"), []);
  });

  it("handles CRLF line endings (raw file reads)", () => {
    const hits = findModuleDeclarations("module A {\r\n}\r\nmodule B {\r\n}\r\n");
    assert.deepEqual(hits.map((h) => [h.name, h.line]), [["A", 0], ["B", 2]]);
  });

  it("ignores 'module' text inside strings, comments and swim-strings", () => {
    const text = [
      "$s = \"module NotReal\";",
      "# module AlsoNotReal",
      "/* module StillNo",
      "   module NopeEither */",
      "$doc = >>module InSwim>>;",
      "module TheRealOne {",
    ].join("\n");
    assert.deepEqual(findModuleDeclarations(text), [
      { name: "TheRealOne", line: 5, character: 7 },
    ]);
  });

  it("reports at most one declaration per line", () => {
    const hits = findModuleDeclarations("module First module Second");
    assert.deepEqual(hits, [{ name: "First", line: 0, character: 7 }]);
  });

  it("does not match a bare 'module' keyword with no name", () => {
    assert.deepEqual(findModuleDeclarations("module\nmodule "), []);
  });
});
