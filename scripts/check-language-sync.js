#!/usr/bin/env node
/**
 * check-language-sync.js
 *
 * Fails if either:
 *   1. the function/operation name lists baked into the TextMate grammar
 *      (syntaxes/otterscript.tmLanguage.json) have drifted out of sync with the
 *      authoritative docs tables in src/language-data.js, or
 *   2. any docs-table entry carries a `namespace` that is neither `null` nor a
 *      member of the `NAMESPACES` allowlist (src/namespaces.js, re-exported
 *      by language-data.js).
 *
 * Background: the grammar matches scalar, vector, and map functions and
 * operations with regex alternations, e.g.
 *
 *     "match": "\\$(ToJson|FromJson|...|PackageProperty)\\("
 *
 * These lists are generated from language-data.js (which includes Inedo's
 * generated reference) with `--write`; without it, the script checks that
 * they are current, so CI catches a list that wasn't regenerated.
 *
 * Each list is sorted longest name first, so a pattern such as
 * `\b(Build|Build-Project)\b` prefers the longer name. Operations without a
 * dash that belong to a namespace (`DotNet::Build`, `ProGet::Promote`) are
 * left out of the operations list: they are always written with their
 * namespace, and as plain words (`Build`, `Test`) they would color ordinary
 * text.
 *
 * Scope: call-style functions and operations only. Runtime *variables*
 * (entries whose `signature` has no `(` -- e.g. `$WorkingDirectory`,
 * `@AffectedPackages`) are matched by different grammar rules.
 *
 * Usage:
 *   node scripts/check-language-sync.js           exit 0 = in sync, 1 = drift
 *   node scripts/check-language-sync.js --write   regenerate the grammar lists
 */

"use strict";

/**
 * @typedef {{ name: string, match: string }} GrammarPattern
 * @typedef {Record<string, { signature?: string, namespace?: string | null }>} DocsTable
 */

const fs = require("node:fs");
const path = require("node:path");

const data = require(path.join(__dirname, "..", "src", "language-data.js"));
const GRAMMAR_PATH = path.join(__dirname, "..", "syntaxes", "otterscript.tmLanguage.json");

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

/**
 * Pull the alternation names out of a grammar pattern identified by scope name.
 * Expects a single `(a|b|c)` group of bare identifiers somewhere in the match.
 * @param {GrammarPattern[]} patterns - From {@link collectPatterns}
 * @param {string} scopeName
 * @returns {string[]}
 */
function grammarNames(patterns, scopeName) {
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
 * The operations the grammar colors: every entry except a dashless one that
 * belongs to a namespace (see the header).
 * @param {DocsTable} docsTable
 * @returns {string[]}
 */
function operationNames(docsTable) {
  return Object.entries(docsTable)
    .filter(([key, entry]) => key.includes("-") || entry.namespace === null)
    .map(([key]) => bareName(key));
}

/**
 * Longest name first, then alphabetically -- the order the grammar lists use.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byLengthThenName(a, b) {
  return b.length - a.length || a.localeCompare(b);
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
    label: "map functions",
    scope: "support.function.map.otterscript",
    expected: functionNames(data.mapFunctionDocs),
  },
  {
    label: "operations",
    scope: "keyword.other.operation.otterscript",
    expected: operationNames(data.operationDocs),
  },
];

// ------------------------------------------------------------------
// --write: regenerate the grammar lists
// ------------------------------------------------------------------
// Edits the file text in place, one pattern at a time, so the rest of the
// grammar keeps its formatting.

if (process.argv.includes("--write")) {
  let text = fs.readFileSync(GRAMMAR_PATH, "utf8");
  for (const check of checks) {
    const names = [...new Set(check.expected)].sort(byLengthThenName);
    const scopeAt = text.indexOf(`"name": "${check.scope}"`);
    const matchAt = text.indexOf("\"match\": \"", scopeAt);
    const lineEnd = text.indexOf("\n", matchAt);
    const line = text.slice(matchAt, lineEnd);
    const listPattern = /\(([A-Za-z0-9_:|-]+\|[A-Za-z0-9_:|-]+)\)/;
    if (scopeAt === -1 || matchAt === -1 || !listPattern.test(line)) {
      throw new Error(`could not find the list of "${check.scope}"`);
    }
    text = text.slice(0, matchAt) + line.replace(listPattern, `(${names.join("|")})`) + text.slice(lineEnd);
  }
  JSON.parse(text); // still valid JSON
  fs.writeFileSync(GRAMMAR_PATH, text);
  console.log("Rewrote the grammar lists in syntaxes/otterscript.tmLanguage.json");
}

// Read after any --write above, so the check below sees the current file.
const patterns = collectPatterns(JSON.parse(fs.readFileSync(GRAMMAR_PATH, "utf8")), []);

let drift = false;

for (const check of checks) {
  const expected = new Set(check.expected);
  const actual = new Set(grammarNames(patterns, check.scope));

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

// ------------------------------------------------------------------
// Namespace allowlist check
// ------------------------------------------------------------------
// Every docs-table entry must carry a `namespace` that is either null or one of
// the known OtterScript namespace tokens. Catches typos and any future value
// added without updating the allowlist in src/namespaces.js.

/** @type {ReadonlySet<string>} */
const namespaces = data.NAMESPACES;
const nsTables = /** @type {Record<string, DocsTable>} */ ({
  operationDocs: data.operationDocs,
  scalarFunctionDocs: data.scalarFunctionDocs,
  vectorFunctionDocs: data.vectorFunctionDocs,
  mapFunctionDocs: data.mapFunctionDocs,
  variableDocs: data.variableDocs,
  keywordDocs: data.keywordDocs,
  syntaxDocs: data.syntaxDocs,
  // Same-named operations of other namespaces (`DotNet::Build`), keyed
  // `<namespace>::<name>` so a bad one is reported by both.
  operationVariants: Object.fromEntries(Object.entries(/** @type {Record<string, DocsTable[string][]>} */ (data.operationVariants))
    .flatMap(([name, forms]) => forms.map((form) => [`${form.namespace}::${name}`, form]))),
});

/** @type {string[]} */
const badNamespaces = [];
for (const [tableName, table] of Object.entries(nsTables)) {
  for (const [key, entry] of Object.entries(table)) {
    const ns = entry.namespace;
    if (ns === undefined) {
      badNamespaces.push(`${tableName}.${key}: missing 'namespace'`);
    } else if (ns !== null && !namespaces.has(ns)) {
      badNamespaces.push(`${tableName}.${key}: ${JSON.stringify(ns)}`);
    }
  }
}

if (badNamespaces.length) {
  drift = true;
  console.log("\nDRIFT  namespaces  [not null and not in NAMESPACES]");
  console.log(`  ${badNamespaces.join("\n  ")}`);
  console.log(`  allowed: ${[...namespaces].join(", ")}`);
}

if (drift) {
  console.log(
    "\nlanguage-data.js and syntaxes/otterscript.tmLanguage.json are out of sync."
  );
  console.log(
    "Regenerate the grammar's name lists with `npm run update:grammar`, and/or fix\n" +
    "the namespace values above (or add the namespace to src/namespaces.js)."
  );
  process.exitCode = 1;
} else {
  console.log("\nlanguage data and grammar are in sync.");
}
