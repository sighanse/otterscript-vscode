// @ts-check
/**
 * @fileoverview Unit tests for src/adaptivecard.js — the opt-in, best-effort
 * Adaptive Card `"type"`/`"version"` checks.
 *
 * Requires the vscode stub before adaptivecard.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position } = require("../vscode-stub");
const { findAdaptiveCardDiagnostics } = require("../../src/adaptivecard.js");

/**
 * @param {string} source
 * @returns {any[]}
 */
function diagnose(source) {
  const lines = source.split("\n");
  /** @param {{ line: number, character: number }} p */
  const offsetAt = (p) => {
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  };
  const document = /** @type {any} */ ({
    positionAt: (/** @type {number} */ offset) => {
      let remaining = Math.max(0, offset);
      let line = 0;
      while (line < lines.length - 1 && remaining > lines[line].length) {
        remaining -= lines[line].length + 1;
        line++;
      }
      return new Position(line, remaining);
    },
    offsetAt,
  });
  return findAdaptiveCardDiagnostics(document, source);
}

/** @param {string} source @param {string} code */
const only = (source, code) => diagnose(source).filter((d) => d.code === code);

describe("findAdaptiveCardDiagnostics — opt-in detection", () => {
  it("does nothing when there is no 'type': 'AdaptiveCard' anywhere", () => {
    assert.deepEqual(diagnose('{ "type": "message", "text": "hi" }'), []);
  });

  it("does not opt in from a string VALUE that merely contains 'type'/'AdaptiveCard'-like text", () => {
    // A TextBlock explaining card syntax to the user -- these quotes are
    // escaped JSON-string content, not real "type"/"version" properties.
    const src = '{ "type": "message", "text": "Use \\"type\\": \\"AdaptiveCard\\" as the root." }';
    assert.deepEqual(diagnose(src), []);
  });

  it("does not misread a 'type' key whose value string contains an escaped quote", () => {
    const src = String.raw`{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "He said \"hi\"" } ] }`;
    assert.deepEqual(diagnose(src), []);
  });

  it("does not flag a 'type' field outside the Adaptive Card object (e.g. a Teams envelope)", () => {
    const src = [
      '{',
      '  "type": "message",',
      '  "attachments": [',
      '    { "contentType": "x", "content": {',
      '      "type": "AdaptiveCard",',
      '      "version": "1.2",',
      '      "body": []',
      '    } }',
      '  ]',
      '}',
    ].join("\n");
    assert.deepEqual(diagnose(src), []);
  });
});

describe("findAdaptiveCardDiagnostics — missing version", () => {
  it("flags an AdaptiveCard object with no 'version' property", () => {
    const [d] = only('{ "type": "AdaptiveCard", "body": [] }', "adaptivecard-missing-version");
    assert.ok(d);
    assert.equal(d.message, 'Adaptive Card is missing its required "version" property.');
  });

  it("does not flag when 'version' is present", () => {
    assert.deepEqual(
      only('{ "type": "AdaptiveCard", "version": "1.2", "body": [] }', "adaptivecard-missing-version"),
      []
    );
  });
});

describe("findAdaptiveCardDiagnostics — unknown type", () => {
  it("flags a typo'd element type", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlok", "text": "hi" } ] }';
    const [d] = only(src, "adaptivecard-unknown-type");
    assert.ok(d);
    assert.equal(d.message, "Unknown Adaptive Card type 'TextBlok'.");
    assert.equal(d.range.start.character, src.indexOf("TextBlok"));
    assert.equal(d.range.end.character, src.indexOf("TextBlok") + "TextBlok".length);
  });

  it("flags a typo'd action type", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "actions": [ { "type": "Action.OpenUrll", "title": "x" } ] }';
    const [d] = only(src, "adaptivecard-unknown-type");
    assert.ok(d);
    assert.equal(d.message, "Unknown Adaptive Card type 'Action.OpenUrll'.");
  });

  it("does not flag known element and action types, including nested ones", () => {
    const src = [
      '{',
      '  "type": "AdaptiveCard", "version": "1.2",',
      '  "body": [',
      '    { "type": "TextBlock", "text": "hi" },',
      '    { "type": "ColumnSet", "columns": [',
      '      { "type": "Column", "items": [ { "type": "Image", "url": "x" } ] }',
      '    ] },',
      '    { "type": "FactSet", "facts": [ { "title": "a", "value": "b" } ] }',
      '  ],',
      '  "actions": [ { "type": "Action.OpenUrl", "title": "View", "url": "x" } ]',
      '}',
    ].join("\n");
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });

  it("does not flag a 'type'-like key that isn't exactly 'type' (e.g. 'mediaType')", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "mediaType": "video/mp4" }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });
});

describe("findAdaptiveCardDiagnostics — <% %> template regions", () => {
  it("ignores <% %> code entirely (only literal text is scanned)", () => {
    const src = [
      '{ "type": "AdaptiveCard", "version": "1.2", "body": [',
      '  { "type": "TextBlock", "text": "hi" }',
      '<% foreach %p in @AffectedPackages { %>',
      '  ,{ "type": "TextBlock", "text": $ToJson(%p.Name) }',
      '<% } %>',
      '] }',
    ].join("\n");
    assert.deepEqual(diagnose(src), []);
  });

  it("does not let a stray '\"type\":'-looking token inside <% %> code get checked", () => {
    // %( type: "NotARealType" ) is OtterScript map syntax inside a tag, not
    // JSON -- and has no quoted "type" key anyway, but this also confirms
    // the <% %> span itself is fully blanked, not scanned as literal text.
    const src = [
      '{ "type": "AdaptiveCard", "version": "1.2", "body": [',
      '<% $m = %( type: "NotARealType" ) %>',
      '] }',
    ].join("\n");
    assert.deepEqual(diagnose(src), []);
  });
});
