// @ts-check
/**
 * @fileoverview Loads every module under src/, so the coverage report
 * (`npm run test:coverage`) lists each one: Node reports only the files a
 * test loads, which would leave a module no test touches out of the report
 * instead of counting it as uncovered.
 *
 * Requires the vscode stub first, as most modules pull in vscode.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src");

describe("src modules", () => {
  const files = fs.readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".js"));

  it("finds the modules", () => {
    assert.ok(files.includes("extension.js") && files.some((file) => file.startsWith("providers")), files.join(" "));
  });

  for (const file of files) {
    it(`loads ${file.replace(/\\/g, "/")}`, () => {
      assert.equal(typeof require(path.join(SRC, file)), "object");
    });
  }
});
