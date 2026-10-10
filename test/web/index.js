// @ts-check
/**
 * @fileoverview Entry point of the web tests: VS Code in the browser (started
 * by `@vscode/test-web`, see `npm run test:web`) loads this file, bundled into
 * dist/web/test/index.js by scripts/build.js, and calls `run`.
 *
 * A web extension runs in a web worker, where the Node-based Mocha the
 * desktop integration tests use can't load, so this sets up Mocha's browser
 * build and adds the test files by hand.
 */

// The browser build has no types of its own: it sets the global `mocha`,
// which @types/mocha describes.
// @ts-expect-error -- no declaration file for "mocha/mocha"
require("mocha/mocha");

/**
 * Runs the web tests.
 *
 * @returns {Promise<void>} Resolves when every test passed
 */
function run() {
  return new Promise((resolve, reject) => {
    mocha.setup({ ui: "bdd", reporter: undefined, timeout: 20000 });
    require("./extension.test");
    mocha.run((failures) => {
      if (failures > 0) reject(new Error(`${failures} web test(s) failed`));
      else resolve();
    });
  });
}

module.exports = { run };
