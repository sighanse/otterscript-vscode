// @ts-check
/**
 * @fileoverview Checks every snippet body -- snippets/otterscript.json and the
 * `snippet` fields in src/language-data.js (inserted by completion) -- for two
 * VS Code snippet-syntax mistakes that insert the wrong text:
 *
 * - An unescaped `$Name` / `${Name}`: VS Code reads it as a snippet variable.
 *   An unknown one is dropped from completion inserts, or (in a snippets file)
 *   turned into an extra tab stop plus a "snippets very likely confuse
 *   snippet-variables and snippet-placeholders" warning. OtterScript's own
 *   `$` must be written `\$` (`"\\$"` in JSON / JS source).
 * - An unescaped `}` inside a placeholder's default text that was meant to
 *   close a `{` there: VS Code ends the placeholder at the first `}`, so it
 *   must be written `\}`.
 *
 * Syntax reference: https://code.visualstudio.com/docs/editor/userdefinedsnippets#_grammar
 */

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("jsonc-parser");

const data = require("../../src/language-data.js");

/** VS Code's built-in snippet variables (matched by name prefix). */
const KNOWN_VARIABLE_REGEX =
  /^(?:TM_|RELATIVE_FILEPATH$|CLIPBOARD$|WORKSPACE_|CURSOR_|CURRENT_|RANDOM|UUID$|BLOCK_COMMENT_|LINE_COMMENT$)/;

/**
 * Returns a description of each snippet-syntax problem in `body`.
 *
 * @param {string} body - Snippet body as VS Code receives it (JSON already decoded)
 * @returns {string[]}
 */
function findSnippetProblems(body) {
  const problems = [];
  /** Open placeholders: literal-`{` depth inside each one's default text. */
  const placeholders = [];

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      // An escaped char, e.g. \$ or \}. A \} still pairs with an earlier
      // literal '{' in the same placeholder's text.
      const depth = placeholders.length - 1;
      if (body[i + 1] === "}" && depth >= 0 && placeholders[depth] > 0) placeholders[depth]--;
      i++;
      continue;
    }

    if (ch === "$") {
      const rest = body.slice(i);
      const tabstop = /^\$(?:\d+|\{\d+\})/.exec(rest);
      if (tabstop) { i += tabstop[0].length - 1; continue; }
      const placeholder = /^\$\{\d+:/.exec(rest);
      if (placeholder) { placeholders.push(0); i += placeholder[0].length - 1; continue; }
      const choice = /^\$\{\d+\|[^|]*\|\}/.exec(rest);
      if (choice) { i += choice[0].length - 1; continue; }
      const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)(:?)/.exec(rest);
      if (variable) {
        if (!KNOWN_VARIABLE_REGEX.test(variable[1])) {
          problems.push(`unescaped '${variable[0].replace(/:$/, "")}' is read as a snippet variable; write '\\$${variable[1]}'`);
        } else if (variable[0].startsWith("${") && variable[2] === ":") {
          placeholders.push(0); // ${KNOWN:default} nests like a placeholder
        }
        i += variable[0].length - 1;
      }
      continue;
    }

    if (placeholders.length === 0) continue;
    if (ch === "{") {
      placeholders[placeholders.length - 1]++;
    } else if (ch === "}") {
      if (placeholders[placeholders.length - 1] > 0) {
        problems.push(`'}' at ${i} closes the placeholder early (it was meant to close a '{'); write '\\}'`);
      }
      placeholders.pop();
    }
  }
  return problems;
}

describe("findSnippetProblems (the checker itself)", () => {
  it("accepts tab stops, placeholders, choices, known variables and escapes", () => {
    assert.deepEqual(findSnippetProblems("\\$x = ${1:value}; $0 ${2|a,b|} ${TM_FILENAME} \\$Join(${3:x \\{ y \\}})"), []);
  });

  it("flags an unescaped OtterScript variable or function", () => {
    assert.equal(findSnippetProblems("if $$MatchesRegex(${1:t})").length, 1);
    assert.equal(findSnippetProblems("${1:$_.Status}").length, 1);
  });

  it("flags a '}' inside a placeholder that was meant to close a '{'", () => {
    assert.equal(findSnippetProblems("${1:Where-Object { \\$_.Status } | Out-String}").length, 1);
  });
});

describe("snippet bodies", () => {
  it("snippets/otterscript.json has no snippet-syntax problems", () => {
    const file = path.join(__dirname, "..", "..", "snippets", "otterscript.json");
    const snippets = parse(fs.readFileSync(file, "utf8"));
    const found = Object.entries(snippets).flatMap(([name, snippet]) =>
      findSnippetProblems([].concat(snippet.body).join("\n")).map((p) => `${name}: ${p}`)
    );
    assert.deepEqual(found, []);
  });

  it("language-data.js completion snippets have no snippet-syntax problems", () => {
    const found = [];
    for (const [tableName, table] of Object.entries(data)) {
      if (!table || typeof table !== "object" || table instanceof Set) continue;
      for (const [key, entry] of Object.entries(table)) {
        if (typeof entry?.snippet !== "string") continue;
        found.push(...findSnippetProblems(entry.snippet).map((p) => `${tableName}.${key}: ${p}`));
      }
    }
    assert.deepEqual(found, []);
  });
});
