// @ts-check
/**
 * @fileoverview Unit tests for scripts/build.js: the check that a bundle
 * holds only src/ and loads only `vscode`, so it runs in the browser too.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { BUNDLES, checkMetafile } = require("../../scripts/build.js");

/**
 * A metafile with the given inputs and one output importing `imports`.
 *
 * @param {string[]} inputs
 * @param {string[]} imports
 * @returns {import("esbuild").Metafile}
 */
function metafile(inputs, imports) {
  return /** @type {any} */ ({
    inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1, imports: [] }])),
    outputs: { "dist/extension.js": { imports: imports.map((path) => ({ path, kind: "require-call", external: true })) } },
  });
}

describe("checkMetafile", () => {
  it("accepts a bundle of src/ that loads only vscode", () => {
    assert.deepEqual(checkMetafile("desktop", metafile(["src/extension.js", "src/providers/hover.js"], ["vscode"])), []);
  });

  it("reports a file bundled from outside src/, such as an npm package", () => {
    assert.deepEqual(checkMetafile("web", metafile(["src/extension.js", "node_modules/lodash/lodash.js"], ["vscode"])), [
      "web: bundles node_modules/lodash/lodash.js, which is not in src/",
    ]);
  });

  it("reports a Node built-in loaded at run time", () => {
    assert.deepEqual(checkMetafile("desktop", metafile(["src/extension.js"], ["vscode", "node:fs"])), [
      "desktop: loads 'node:fs' at run time; only 'vscode' is available everywhere",
    ]);
  });
});

describe("BUNDLES", () => {
  it("builds what package.json's main and browser load", () => {
    const pkg = require("../../package.json");
    assert.equal(`./${BUNDLES.desktop.outfile}`, pkg.main);
    assert.equal(`./${BUNDLES.web.outfile}`, pkg.browser);
  });
});
