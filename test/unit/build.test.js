// @ts-check
/**
 * @fileoverview Unit tests for scripts/build.js: the check that a bundle
 * holds only src/ and loads only `vscode`, so it runs in the browser too, and
 * that the settings tied to the oldest supported VS Code agree.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { BUNDLES, EXTENSION_HOST_NODE, checkMetafile } = require("../../scripts/build.js");
const pkg = require("../../package.json");

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
    assert.equal(`./${BUNDLES.desktop.outfile}`, pkg.main);
    assert.equal(`./${BUNDLES.web.outfile}`, pkg.browser);
  });
});

// Raising the minimum VS Code means changing all of these; a partial update
// would type-check or lint against the wrong version without a sound.
describe("the oldest supported VS Code", () => {
  /** engines.vscode without its range operator, e.g. "1.85.0". */
  const minimum = pkg.engines.vscode.replace(/^[\^~>=\s]+/, "");

  it("is the version @types/vscode describes", () => {
    assert.equal(pkg.devDependencies["@types/vscode"], minimum);
  });

  it("has the Node.js major version @types/node describes", () => {
    const typesNodeMajor = pkg.devDependencies["@types/node"].replace(/^[\^~>=\s]+/, "").split(".")[0];
    assert.equal(typesNodeMajor, EXTENSION_HOST_NODE.split(".")[0]);
  });

  it("sets the desktop bundle's target", () => {
    assert.equal(BUNDLES.desktop.target, `node${EXTENSION_HOST_NODE}`);
  });
});
