// @ts-check
/**
 * @fileoverview Pins the diagnostic count of the manual-review `.otter`
 * fixtures used for eyeballing the Problems panel in a real editor.
 *
 * These files are otherwise only ever checked by hand, which is exactly how a
 * previous regression went unnoticed for multiple commits: a stray `<% %>`
 * pair in test/sample.otter and test/sample-valid.otter (added long before
 * template-aware diagnostics existed, for syntax-highlighting coverage) made
 * documentUsesTemplateTags() treat each whole file as a text template, which
 * blanks everything outside the tags -- silently zeroing out every other
 * diagnostic in the file with no error, no exception, nothing in any log.
 *
 * Requires the vscode stub before diagnostics.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { makeDocument } = require("./fake-document");
const { parse } = require("jsonc-parser");

const { updateDiagnostics, DIAGNOSTIC_CODES } = require("../../src/diagnostics.js");
const { documentUsesTemplateTags } = require("../../src/scanner.js");

/** The diagnostics context: settings left at their defaults. */
const ctx = {};

/**
 * Runs updateDiagnostics over a fixture file's on-disk contents.
 *
 * @param {string} relativePath - Path under test/, e.g. "sample.otter"
 * @returns {any[]}
 */
function diagnoseFixture(relativePath) {
  return diagnoseSource(fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8"), relativePath);
}

/**
 * Runs updateDiagnostics over a document's text.
 *
 * @param {string} source
 * @param {string} relativePath - Used for the document's URI
 * @param {{ adaptiveCardMaxVersion?: string }} [extraCtx] - Added to the
 *   diagnostics context
 * @returns {any[]}
 */
function diagnoseSource(source, relativePath, extraCtx = {}) {
  const document = makeDocument(source, { uri: `file:///${relativePath}` });
  /** @type {any[]} */
  let collected = [];
  const collection = /** @type {any} */ ({
    // Plain string codes, for comparing: the links are tested on their own.
    set: (/** @type {unknown} */ _uri, /** @type {any[]} */ issues) => {
      collected = issues.map((d) => Object.assign(d, { code: d.code.value }));
    },
  });
  updateDiagnostics(document, collection, { ...ctx, ...extraCtx });
  return collected;
}

/**
 * Expands a snippet body with each placeholder's default: `${1:text}` becomes
 * `text`, a choice `${1|a,b|}` its first option, a bare tab stop nothing, and
 * the escapes `\$` / `\}` their characters. Enough for the flat (unnested)
 * placeholders the snippets use.
 *
 * @param {string} body
 * @returns {string}
 */
function expandSnippet(body) {
  return body
    .replace(/(?<!\\)\$\{\d+\|([^,|]*)[^}]*\}/g, "$1")
    .replace(/(?<!\\)\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/(?<!\\)\$(?:\d+|\{\d+\})/g, "")
    .replace(/\\([$}])/g, "$1");
}

describe("manual-review fixtures", () => {
  it("sample.otter is NOT template-aware and flags exactly its documented tally", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), false);
    assert.equal(diagnoseFixture("sample.otter").length, 18);
  });

  it("sample-valid.otter is NOT template-aware and stays clean", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-valid.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), false);
    assert.deepEqual(diagnoseFixture("sample-valid.otter"), []);
  });

  it("sample-template.otter IS template-aware and flags exactly its documented tally", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-template.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.equal(diagnoseFixture("sample-template.otter").length, 13);
  });

  it("sample-card-version.otter IS template-aware and flags exactly its five version-too-low diagnostics", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-card-version.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    const found = diagnoseFixture("sample-card-version.otter");
    assert.deepEqual(found.map((d) => d.code), Array(5).fill("adaptivecard-version-too-low"));
  });

  it("the teamscard snippet, expanded with its defaults, IS template-aware and stays clean", () => {
    const snippets = parse(fs.readFileSync(path.join(__dirname, "..", "..", "snippets", "otterscript.json"), "utf8"));
    const source = expandSnippet(snippets["Teams Adaptive Card Message"].body.join("\n"));
    assert.ok(source.includes('"text": $ToJson($Message)'), "placeholders expanded");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.deepEqual(diagnoseSource(source, "teamscard.otter", { adaptiveCardMaxVersion: "1.6" }), []);
  });

  it("every diagnostic in the error fixtures carries a code listed in DIAGNOSTIC_CODES", () => {
    // A code is what the otterscript.diagnostics.rules setting keys on, so a
    // check emitted without one could never be turned off.
    for (const fixture of ["sample.otter", "sample-template.otter", "sample-card-version.otter"]) {
      for (const d of diagnoseFixture(fixture)) {
        assert.ok(DIAGNOSTIC_CODES.includes(d.code), `${fixture}: '${d.message}' has code ${d.code}`);
      }
    }
  });

  it("sample-template-valid.otter IS template-aware and stays clean", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-template-valid.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.deepEqual(diagnoseFixture("sample-template-valid.otter"), []);
  });

  it("sample-webhook-template.otter (a paste-ready body, no annotations) IS template-aware and stays clean", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "sample-webhook-template.otter"), "utf8");
    assert.equal(documentUsesTemplateTags(source), true);
    assert.deepEqual(diagnoseFixture("sample-webhook-template.otter"), []);
  });
});
