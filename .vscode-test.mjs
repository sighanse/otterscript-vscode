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

import { readFileSync } from "node:fs";
import { defineConfig } from "@vscode/test-cli";

/**
 * The oldest VS Code the extension supports: package.json's engines.vscode
 * (`^1.85.0`) without its range operator, so raising it there moves the
 * "minimum" run along.
 */
const MINIMUM_VERSION = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"))
  .engines.vscode.replace(/^[\^~>=\s]+/, "");

/** @type {Omit<import("@vscode/test-cli").IDesktopTestConfiguration, "label" | "version">} */
const common = {
  files: "test/integration/**/*.test.js",
  workspaceFolder: "test/integration/workspace",
  // As VS Code's testing guide suggests: no other installed extension runs,
  // so only this one's completions, hovers and diagnostics are seen. The
  // profile under .vscode-test/ has none installed today; this keeps a run
  // isolated should that change (built-in extensions stay on).
  launchArgs: ["--disable-extensions"],
  mocha: {
    ui: "bdd",
    // The first test in a run also waits for the extension to activate.
    timeout: 20000,
    // An `it.only` left in by mistake would quietly skip every other test;
    // in CI it fails the run instead.
    forbidOnly: Boolean(process.env.CI),
  },
};

export default defineConfig([
  { label: "minimum", version: MINIMUM_VERSION, ...common },
  { label: "stable", version: "stable", ...common },
]);
