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
 *
 * Then checks that each snippet of snippets/otterscript.json, inserted with
 * its placeholders' default text, is code the diagnostics accept.
 *
 * Requires the vscode stub before diagnostics.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("jsonc-parser");

const data = require("../../src/language-data.js");
const { DiagnosticSeverity } = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { updateDiagnostics } = require("../../src/diagnostics.js");

/** snippets/otterscript.json, by snippet name. */
const SNIPPETS = parse(fs.readFileSync(path.join(__dirname, "..", "..", "snippets", "otterscript.json"), "utf8"));

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

/**
 * The text a snippet inserts when each placeholder keeps its default text: a
 * choice its first option, a bare tab stop nothing, an escaped character
 * itself.
 *
 * @param {string} body
 * @returns {string}
 */
function insertedText(body) {
  let text = body;
  // Innermost placeholders first, until none is left.
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/\$\{\d+:((?:\\.|[^{}\\])*)\}/g, "$1");
  }
  return text
    .replace(/\$\{\d+\|([^,|]*)[^}]*\|\}/g, "$1")
    .replace(/\$\{?\d+\}?/g, "")
    .replace(/\\(.)/g, "$1");
}

describe("snippets, as inserted", () => {
  it("insertedText keeps defaults, the first choice and escaped characters", () => {
    assert.equal(insertedText("set ${1|local,global|} $${2:name} = \\$Join(${3:x ${4:y}});$0"), "set local $name = $Join(x y);");
  });

  it("each snippet inserts code with no errors or warnings", () => {
    /** @type {string[]} */
    const found = [];
    for (const [name, snippet] of Object.entries(SNIPPETS)) {
      const text = insertedText([].concat(snippet.body).join("\n"));
      updateDiagnostics(makeDocument(text), /** @type {any} */ ({
        set: (/** @type {unknown} */ _uri, /** @type {any[]} */ issues) => {
          for (const d of issues) {
            if (d.severity <= DiagnosticSeverity.Warning) found.push(`${name}: ${d.code.value} -- ${d.message}`);
          }
        },
      }), /** @type {any} */ ({}));
    }
    assert.deepEqual(found, []);
  });

  it("each snippet assigns a variable with `set`, the only assignment statement", () => {
    // `@parts = ...` and `global $x = ...` aren't statements; the
    // diagnostics don't flag them, so this checks the snippets directly.
    const assignment = /^\s*(?:(?:local|global)\s+)?[$@%][\w{}]+\s*=(?!=)/;
    const found = Object.entries(SNIPPETS).flatMap(([name, snippet]) =>
      insertedText([].concat(snippet.body).join("\n")).split("\n")
        .filter((line) => assignment.test(line))
        .map((line) => `${name}: ${line.trim()}`)
    );
    assert.deepEqual(found, []);
  });
});
