#!/usr/bin/env node
/**
 * build.js
 *
 * Bundles src/ with esbuild, once per place the extension runs:
 *
 * - dist/extension.js for desktop VS Code (package.json `main`): Node 18,
 *   the oldest supported VS Code's (1.85, Electron 25)
 * - dist/web/extension.js for VS Code in the browser, such as vscode.dev and
 *   github.dev (package.json `browser`)
 *
 * Both come from the same source, which uses only the `vscode` API: no Node
 * built-ins and no npm packages. `--check` makes sure of that, so a
 * `require("node:fs")` or a runtime dependency fails `npm run check` instead
 * of breaking the extension in the browser, or leaving it out of the package.
 *
 * Usage:
 *   node scripts/build.js               minified, no source maps (packaging)
 *   node scripts/build.js --dev         with source maps (F5, the integration tests)
 *   node scripts/build.js --web-tests   also bundle test/web/ for `npm run test:web`
 *   node scripts/build.js --check       build in memory and check the inputs; write nothing
 */

"use strict";

const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

/**
 * Options both bundles share. `vscode` is provided by VS Code at run time;
 * `keepNames` keeps function names in stack traces after minifying.
 *
 * @type {import("esbuild").BuildOptions}
 */
const COMMON = {
  absWorkingDir: ROOT,
  entryPoints: ["src/extension.js"],
  bundle: true,
  format: "cjs",
  external: ["vscode"],
  keepNames: true,
  logLevel: "warning",
};

/** @type {Record<string, import("esbuild").BuildOptions>} */
const BUNDLES = {
  desktop: { ...COMMON, platform: "node", target: "node18", outfile: "dist/extension.js" },
  // VS Code runs a web extension in a web worker; `browser` makes a Node
  // built-in a build error instead of a failure at run time.
  web: { ...COMMON, platform: "browser", target: "es2022", outfile: "dist/web/extension.js" },
};

/**
 * The web tests (test/web/), bundled into one file the browser's VS Code
 * loads, with Mocha's browser build.
 *
 * @type {import("esbuild").BuildOptions}
 */
const WEB_TESTS = {
  absWorkingDir: ROOT,
  entryPoints: ["test/web/index.js"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["vscode"],
  sourcemap: "inline",
  logLevel: "warning",
  outfile: "dist/web/test/index.js",
};

/**
 * What is wrong with a bundle's inputs and imports: every bundled file must
 * come from src/, and the only module left to load at run time is `vscode`.
 *
 * @param {string} name - The bundle's name, for the messages
 * @param {import("esbuild").Metafile} metafile
 * @returns {string[]} One message per problem; empty when there is none
 */
function checkMetafile(name, metafile) {
  /** @type {string[]} */
  const problems = [];
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.startsWith("src/")) problems.push(`${name}: bundles ${input}, which is not in src/`);
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const { path: imported } of output.imports) {
      if (imported !== "vscode") problems.push(`${name}: loads '${imported}' at run time; only 'vscode' is available everywhere`);
    }
  }
  return problems;
}

/**
 * Builds every bundle in memory and checks its inputs (checkMetafile).
 *
 * @returns {Promise<string[]>} The problems found; empty when there are none
 */
async function check() {
  /** @type {string[]} */
  const problems = [];
  for (const [name, options] of Object.entries(BUNDLES)) {
    const result = await esbuild.build({ ...options, minify: true, write: false, metafile: true });
    problems.push(...checkMetafile(name, /** @type {import("esbuild").Metafile} */ (result.metafile)));
  }
  return problems;
}

/**
 * Writes the bundles.
 *
 * @param {{ dev: boolean, webTests: boolean }} options - `dev`: with linked
 *   source maps; `webTests`: also bundle test/web/
 * @returns {Promise<void>}
 */
async function build({ dev, webTests }) {
  const builds = Object.values(BUNDLES).map((options) => esbuild.build({
    ...options,
    minify: true,
    // Linked, so the debugger finds the map; never packaged (.vscodeignore).
    sourcemap: dev ? "linked" : false,
  }));
  if (webTests) builds.push(esbuild.build(WEB_TESTS));
  await Promise.all(builds);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const run = args.includes("--check")
    ? check().then((problems) => {
      for (const problem of problems) console.error(problem);
      if (problems.length) process.exitCode = 1;
      else console.log("The bundles hold only src/ and load only 'vscode'");
    })
    : build({ dev: args.includes("--dev"), webTests: args.includes("--web-tests") });
  run.catch((err) => {
    // esbuild has printed the build errors itself.
    if (!(err && Array.isArray(err.errors))) console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { BUNDLES, checkMetafile };
