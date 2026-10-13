// @ts-check
/**
 * @fileoverview Unit tests for src/json-check.js: the JSON syntax check of a
 * text template's literal output, such as a webhook body.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assertLinearTime } = require("./timing");

const { findTemplateJsonProblem } = require("../../src/json-check.js");

/**
 * The problem in `text`, if any: the text it marks, its message, and its fix
 * applied to `text`.
 *
 * @param {string} text
 * @returns {{ marked: string, message: string, fixed?: string, fixTitle?: string } | null}
 */
function check(text) {
  const problem = findTemplateJsonProblem(text);
  if (!problem) return null;
  const { start, end, message, fix } = problem;
  return {
    marked: text.slice(start, end),
    message,
    ...(fix && { fixed: text.slice(0, fix.start) + fix.text + text.slice(fix.end), fixTitle: fix.title }),
  };
}

/** A tag before the JSON, as a webhook template has. */
const TAG = "<% set $x = 1; %>\n";

describe("findTemplateJsonProblem — valid JSON", () => {
  it("accepts objects, arrays, strings, numbers and literals", () => {
    assert.equal(check(`${TAG}{ "a": 1, "b": [true, false, null, -1.5e3, 0, 2E-2], "c": { }, "d": [], "e": "x\\"y\\\\z\\u00e9\\n" }`), null);
    assert.equal(check(`${TAG}[ { "a": "b" }, [ ] ]`), null);
  });

  it("accepts OtterScript expressions as values", () => {
    assert.equal(check(`${TAG}{ "a": $ToJson($x), "b": $x, "c": \${my var}, "d": $(%p.Name), "e": @list, "f": %map, "g": $ToJson("a)b", 'c"d') }`), null);
  });

  it("accepts an expression as a property name", () => {
    assert.equal(check(`${TAG}{ $ToJson($key): 1 }`), null);
  });

  it("checks nothing that doesn't start as JSON", () => {
    assert.equal(check(`${TAG}Hello $Name, your build failed: { oops`), null);
    assert.equal(check(`${TAG}`), null);
    assert.equal(check(""), null);
  });

  it("takes a tag's text out, and a string's text as written", () => {
    assert.equal(check('<% if $x { %>\n{ "a": "<% not a tag in a string %>" }\n<% } %>'), null);
  });
});

describe("findTemplateJsonProblem — next to a template tag", () => {
  it("accepts a loop that writes a comma before each element", () => {
    const body = [
      "{",
      '  "items": [',
      '    { "first": true }',
      "<% foreach $p in @Packages { %>",
      '    ,{ "name": $ToJson($p) }',
      "<% } %>",
      "  ]",
      "}",
    ].join("\n");
    assert.equal(check(body), null);
  });

  it("reports nothing right after a tag, which can make the text valid", () => {
    // Each would be wrong without the tags, but what the tags output isn't known.
    for (const body of [
      '[\n<% foreach $p in @Packages { %>\n  { "n": "$p" },\n<% } %>\n]',
      '{ "a": 1 <% if $b { %> "b": 2 <% } %> }',
      "[ <% if $first { %>,<% } %> 1 ]",
      '{ "a": 1, <% if $b { %> }',
    ]) {
      assert.equal(check(body), null, body);
    }
  });

  it("still reports a problem the tags don't touch", () => {
    assert.deepEqual(check('<% foreach $p in @x { %><% } %>\n{ "a": 1 "b": 2 }')?.marked, '"b"');
  });
});

describe("findTemplateJsonProblem — problems", () => {
  it("a missing comma between properties or elements, with a fix", () => {
    assert.deepEqual(check(`${TAG}{ "a": 1 "b": 2 }`), {
      marked: '"b"',
      message: "Expected ',' or '}' after the property's value.",
      fixed: `${TAG}{ "a": 1, "b": 2 }`,
      fixTitle: "Add ','",
    });
    assert.deepEqual(check(`${TAG}[ 1\n  2 ]`), {
      marked: "2",
      message: "Expected ',' or ']' after the element.",
      fixed: `${TAG}[ 1,\n  2 ]`,
      fixTitle: "Add ','",
    });
  });

  it("a comma before '}' or ']', with a fix", () => {
    assert.deepEqual(check(`${TAG}{ "a": 1, }`), {
      marked: ",",
      message: "JSON doesn't allow a comma before '}'.",
      fixed: `${TAG}{ "a": 1 }`,
      fixTitle: "Remove the comma",
    });
    assert.deepEqual(check(`${TAG}[ 1,\n]`)?.fixed, `${TAG}[ 1\n]`);
  });

  it("an unquoted property name, with a fix", () => {
    assert.deepEqual(check(`${TAG}{ name: 1 }`), {
      marked: "name",
      message: "A property name needs double quotes: \"name\".",
      fixed: `${TAG}{ "name": 1 }`,
      fixTitle: "Quote 'name'",
    });
  });

  it("single quotes", () => {
    assert.deepEqual(check(`${TAG}{ "a": 'b' }`), { marked: "'b'", message: "JSON strings need double quotes." });
    assert.deepEqual(check(`${TAG}{ 'a': 1 }`), { marked: "'a'", message: "JSON strings need double quotes." });
  });

  it("a missing ':' or value", () => {
    assert.deepEqual(check(`${TAG}{ "a" 1 }`), { marked: "1", message: "Expected ':' after the property name." });
    assert.deepEqual(check(`${TAG}{ "a": }`), { marked: "}", message: "Expected a value." });
    assert.deepEqual(check(`${TAG}[ 1, , 2 ]`), { marked: ",", message: "Expected a value." });
    assert.deepEqual(check(`${TAG}{ , }`), { marked: ",", message: "Expected a property name in double quotes." });
  });

  it("a word that isn't a JSON value", () => {
    assert.deepEqual(check(`${TAG}{ "a": yes }`), {
      marked: "yes",
      message: "'yes' isn't a JSON value: quote it, or write true, false, null or a number.",
    });
    assert.deepEqual(check(`${TAG}{ "a": True }`)?.marked, "True");
    assert.deepEqual(check(`${TAG}{ "a": 01 }`)?.marked, "01");
    assert.deepEqual(check(`${TAG}{ "a": $ }`)?.marked, "$");
  });

  it("a string that isn't closed on its line", () => {
    assert.deepEqual(check(`${TAG}{ "a": "two\nlines" }`), {
      marked: '"two',
      message: "This string isn't closed on its line: a JSON string can't hold a line break (write \\n).",
    });
  });

  it("a backslash that isn't a JSON escape, with a fix", () => {
    assert.deepEqual(check(`${TAG}{ "path": "C:\\Program Files" }`), {
      marked: "\\P",
      message: "'\\P' isn't a JSON escape: write '\\\\' for a backslash.",
      fixed: `${TAG}{ "path": "C:\\\\Program Files" }`,
      fixTitle: "Escape the backslash",
    });
  });

  it("an unclosed or mismatched bracket", () => {
    assert.deepEqual(check(`${TAG}{ "a": [ 1, 2 }`), { marked: "}", message: "Expected ']' to close the '[' on line 2." });
    assert.deepEqual(check(`${TAG}{ "a": { "b": 1 }`), { marked: "{", message: "This '{' is never closed." });
    assert.deepEqual(check(`${TAG}{ "a": $ToJson($x }`), { marked: "(", message: "This '(' is never closed." });
  });

  it("text after the value", () => {
    assert.deepEqual(check(`${TAG}{ "a": 1 }\n}`), { marked: "}", message: "Unexpected text after the end of the JSON value." });
  });
});

describe("findTemplateJsonProblem — performance", () => {
  it("checks a large body in time linear in its length", () => {
    const body = `${TAG}[${Array.from({ length: 50000 }, (_, i) => `{ "n": ${i}, "s": "v${i}", "e": $ToJson($x) }`).join(",\n")}]`;
    assert.equal(assertLinearTime(() => findTemplateJsonProblem(body)), null);
    const deep = `${TAG}${"[".repeat(20000)}${"]".repeat(20000)}`;
    assert.equal(assertLinearTime(() => findTemplateJsonProblem(deep)), null, "deep nesting doesn't overflow the stack");
  });
});
