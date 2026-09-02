#!/usr/bin/env node
/**
 * check-language-sync.js
 *
 * Fails if the function/operation name lists baked into the TextMate grammar
 * (syntaxes/otterscript.tmLanguage.json) have drifted out of sync with the
 * authoritative docs tables in src/language-data.js.
 *
 * Background: the grammar matches scalar functions, vector functions and
 * operations with hand-maintained regex alternations, e.g.
 *
 *     "match": "\\$(ToJson|FromJson|...|PackageProperty)\\("
 *
 * Every time an entry is added to language-data.js the matching alternation
 * has to be updated by hand, and it keeps getting missed. This script makes
 * CI catch it.
 *
 * Scope: call-style functions and operations only. Runtime *variables*
 * (entries whose `signature` has no `(` -- e.g. $WorkingDirectory,
 * @AffectedPackages) are matched by different grammar rules and are not
 * checked here yet.
 *
 * Usage: node scripts/check-language-sync.js   (exit 0 = in sync, 1 = drift)
 */

"use strict";

/**
 * @typedef {{ name: string, match: string }} GrammarPattern
 * @typedef {Record<string, { signature?: string }>} DocsTable
 */

const path = require("path");

const data = require(path.join(__dirname, "..", "src", "language-data.js"));
const grammar = require(path.join(
  __dirname,
  "..",
  "syntaxes",
  "otterscript.tmLanguage.json"
));

/**
 * Recursively collect every {name, match} pattern in the grammar.
 * @param {any} node
 * @param {GrammarPattern[]} acc
 * @returns {GrammarPattern[]}
 */
function collectPatterns(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) collectPatterns(item, acc);
  } else if (node && typeof node === "object") {
    if (typeof node.name === "string" && typeof node.match === "string") {
      acc.push(node);
    }
    for (const value of Object.values(node)) collectPatterns(value, acc);
  }
  return acc;
}

const patterns = collectPatterns(grammar, []);

/**
 * Pull the alternation names out of a grammar pattern identified by scope name.
 * Expects a single `(a|b|c)` group of bare identifiers somewhere in the match.
 * @param {string} scopeName
 * @returns {string[]}
 */
function grammarNames(scopeName) {
  const pattern = patterns.find((p) => p.name === scopeName);
  if (!pattern) {
    throw new Error(
      `grammar scope "${scopeName}" not found -- did a rule get renamed or removed?`
    );
  }
  const group = pattern.match.match(/\(([A-Za-z0-9_:|-]+\|[A-Za-z0-9_:|-]+)\)/);
  if (!group) {
    throw new Error(
      `could not parse an alternation list out of "${scopeName}": ${pattern.match}`
    );
  }
  return group[1].split("|").map((s) => s.trim());
}

/**
 * Bare name, no leading $/@ sigil and no namespace prefix.
 * @param {string} key
 * @returns {string}
 */
function bareName(key) {
  return key.replace(/^.*::/, "").replace(/^[$@]/, "");
}

/**
 * Docs-table entries that are call-style (signature contains "(").
 * @param {DocsTable} docsTable
 * @returns {string[]}
 */
function functionNames(docsTable) {
  return Object.entries(docsTable)
    .filter(([, entry]) => typeof entry.signature === "string" && entry.signature.includes("("))
    .map(([key]) => bareName(key));
}

/**
 * All docs-table entries, call-style or not.
 * @param {DocsTable} docsTable
 * @returns {string[]}
 */
function allNames(docsTable) {
  return Object.keys(docsTable).map(bareName);
}

const checks = [
  {
    label: "scalar functions",
    scope: "support.function.variable.otterscript",
    expected: functionNames(data.scalarFunctionDocs),
  },
  {
    label: "vector functions",
    scope: "support.function.vector.otterscript",
    expected: functionNames(data.vectorFunctionDocs),
  },
  {
    label: "operations",
    scope: "keyword.other.operation.otterscript",
    expected: allNames(data.operationDocs),
  },
];

let drift = false;

for (const check of checks) {
  const expected = new Set(check.expected);
  const actual = new Set(grammarNames(check.scope));

  const missingFromGrammar = [...expected].filter((n) => !actual.has(n)).sort();
  const staleInGrammar = [...actual].filter((n) => !expected.has(n)).sort();

  if (missingFromGrammar.length === 0 && staleInGrammar.length === 0) {
    console.log(`ok  ${check.label} (${expected.size} entries in sync)`);
    continue;
  }

  drift = true;
  console.log(`DRIFT  ${check.label}  [${check.scope}]`);
  if (missingFromGrammar.length) {
    console.log(
      `  in language-data.js but missing from the grammar alternation:\n    ${missingFromGrammar.join(", ")}`
    );
  }
  if (staleInGrammar.length) {
    console.log(
      `  in the grammar alternation but not in language-data.js:\n    ${staleInGrammar.join(", ")}`
    );
  }
}

if (drift) {
  console.log(
    "\nlanguage-data.js and syntaxes/otterscript.tmLanguage.json are out of sync."
  );
  console.log(
    "Update the regex alternation(s) above so highlighting matches the docs tables."
  );
  process.exitCode = 1;
} else {
  console.log("\nlanguage data and grammar are in sync.");
}
