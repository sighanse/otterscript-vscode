// Configuration for `vscode-test` (@vscode/test-cli): runs the integration
// tests in test/integration/ inside a real VS Code, with this repo loaded as
// the extension under development.
//
// Two configurations: the oldest VS Code that package.json's engines.vscode
// claims to support, and the current stable release. Run one with
// `npm run test:integration -- --label minimum` (or `stable`).
//
// Each run uses its own user-data and extensions folders under .vscode-test/,
// so an installed copy of the OtterScript extension can't interfere.

import { defineConfig } from "@vscode/test-cli";

/** @type {Omit<import("@vscode/test-cli").TestConfiguration, "label" | "version">} */
const common = {
  files: "test/integration/**/*.test.js",
  workspaceFolder: "test/integration/workspace",
  mocha: {
    ui: "bdd",
    // The first test in a run also waits for the extension to activate.
    timeout: 20000,
  },
};

export default defineConfig([
  { label: "minimum", version: "1.85.0", ...common },
  { label: "stable", version: "stable", ...common },
]);
