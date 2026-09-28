// @ts-check
/**
 * @fileoverview Unit tests for src/adaptivecard.js — the content-triggered, best-effort
 * Adaptive Card `"type"`/`"version"` checks.
 *
 * Requires the vscode stub before adaptivecard.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position } = require("../vscode-stub");
const { findAdaptiveCardDiagnostics, createCardVersionFix } = require("../../src/adaptivecard.js");

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

/**
 * @param {string} source
 * @param {string} code
 */
const only = (source, code) => diagnose(source).filter((d) => d.code === code);

describe("findAdaptiveCardDiagnostics — card detection", () => {
  it("does nothing when there is no 'type': 'AdaptiveCard' anywhere", () => {
    assert.deepEqual(diagnose('{ "type": "message", "text": "hi" }'), []);
  });

  it("does not trigger from a string VALUE that merely contains 'type'/'AdaptiveCard'-like text", () => {
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

  it("does not treat a card-lookalike inside a 'data' payload as the card", () => {
    const src = '{ "type": "message", "data": { "type": "AdaptiveCard", "body": [ { "type": "Custom" } ] } }';
    assert.deepEqual(diagnose(src), []);
  });

  it("picks the real card even when a payload lookalike appears first", () => {
    const src = '{ "actions": [ { "type": "Action.Submit", "data": { "type": "AdaptiveCard" } } ], "type": "AdaptiveCard", "version": "1.4", "body": [ { "type": "TextBlok" } ] }';
    assert.deepEqual(diagnose(src).map((d) => d.message), ["Unknown Adaptive Card type 'TextBlok'."]);
  });

  it("finds the card object even when an earlier sibling string value contains a brace", () => {
    const src = '{ "$schema": "}", "type": "AdaptiveCard", "body": [ { "type": "Bogus" } ] }';
    const codes = diagnose(src).map((d) => d.code).sort();
    assert.deepEqual(codes, ["adaptivecard-missing-version", "adaptivecard-unknown-type"]);
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

  it("does not flag a 'type' inside an action's free-form 'data' payload", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.4", "actions": [ { "type": "Action.Submit", "data": { "type": "business-event", "nested": [ { "type": "x" } ] } } ] }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });

  it("does not flag Teams mention entities under 'msteams'", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.4", "msteams": { "entities": [ { "type": "mention", "text": "<at>Bob</at>" } ] } }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });

  it("does not flag TextRun inlines inside a RichTextBlock", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "RichTextBlock", "inlines": [ { "type": "TextRun", "text": "hi" } ] } ] }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });

  it("does not flag Authentication sign-in buttons", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.4", "authentication": { "type": "Authentication", "buttons": [ { "type": "signin", "title": "Sign in", "value": "x" } ] } }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
  });

  it("still flags a typo'd type after a free-form payload closes", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.4", "actions": [ { "type": "Action.Submit", "data": { "type": "ok" } } ], "body": [ { "type": "TextBlok" } ] }';
    const flagged = only(src, "adaptivecard-unknown-type").map((d) => d.message);
    assert.deepEqual(flagged, ["Unknown Adaptive Card type 'TextBlok'."]);
  });

  it("does not skip anything for a scalar 'data' value", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.4", "actions": [ { "type": "Action.Submitt", "data": "x" } ] }';
    assert.equal(only(src, "adaptivecard-unknown-type").length, 1);
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

describe("findAdaptiveCardDiagnostics — version too low", () => {
  it("flags an element newer than the card's declared version, with the declaration as related info", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Table", "rows": [] } ] }';
    const [d] = only(src, "adaptivecard-version-too-low");
    assert.ok(d);
    assert.equal(d.message, "'Table' requires Adaptive Card version 1.5 or later, but this card declares version 1.2.");
    assert.equal(d.range.start.character, src.indexOf("Table"));
    assert.equal(d.relatedInformation[0].location.range.start.character, src.indexOf("1.2"));
  });

  it("does not flag elements the declared version supports", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.5", "body": [ { "type": "Table" }, { "type": "ActionSet" } ], "actions": [ { "type": "Action.Execute" } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });

  it("compares versions numerically (1.10 is newer than 1.5)", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.10", "body": [ { "type": "Table" } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });

  it("skips an element that has its own fallback", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Table", "fallback": "drop" } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });

  it("skips the children of an element that has a fallback", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Table", "fallback": "drop", "columns": [ { "type": "TableColumnDefinition" } ] } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });

  it("does not skip an element just because a child has a fallback", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Table", "rows": [ { "type": "TableRow", "fallback": "drop" } ] } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low").map((d) => d.message.split("'")[1]), ["Table"]);
  });

  it("skips the check when the version is templated or not major.minor", () => {
    for (const version of ["$CardVersion", "latest", "1"]) {
      const src = `{ "type": "AdaptiveCard", "version": "${version}", "body": [ { "type": "Table" } ] }`;
      assert.deepEqual(only(src, "adaptivecard-version-too-low"), [], version);
    }
  });

  it("uses only the card's own version, not a nested one", () => {
    const src = '{ "type": "AdaptiveCard", "body": [ { "type": "Container", "version": "1.5", "items": [ { "type": "Table" } ] } ], "version": "1.0" }';
    assert.equal(only(src, "adaptivecard-version-too-low").length, 1);
  });

  it("ignores types inside free-form payloads", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.0", "actions": [ { "type": "Action.Submit", "data": { "type": "Table" } } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });
});

describe("createCardVersionFix", () => {
  /** @param {string} source */
  function fixFor(source) {
    const [d] = only(source, "adaptivecard-version-too-low");
    const document = /** @type {any} */ ({
      uri: "file:///card.otter",
      getText: () => source,
      positionAt: (/** @type {number} */ offset) => new Position(0, offset),
    });
    return createCardVersionFix(document, d);
  }

  it("raises the version to the highest one any element needs", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.0", "body": [ { "type": "Table" }, { "type": "Media" } ] }';
    const fix = /** @type {any} */ (fixFor(src));
    assert.equal(fix.title, "Change card version to 1.5");
    const [[op, , range, text]] = fix.edit.edits;
    assert.equal(op, "replace");
    assert.equal(range.start.character, src.indexOf("1.0"));
    assert.equal(range.end.character, src.indexOf("1.0") + 3);
    assert.equal(text, "1.5");
  });

  it("returns null once nothing needs a newer version", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.5", "body": [ { "type": "Table" } ] }';
    assert.equal(createCardVersionFix(/** @type {any} */ ({ uri: "u", getText: () => src, positionAt: () => new Position(0, 0) }), /** @type {any} */ ({})), null);
  });
});

describe("findAdaptiveCardDiagnostics — performance", () => {
  it("stays fast on a large card (each lookup used to rescan the whole text)", () => {
    // 2,000 elements with a fallback took ~1 s before the one-pass JsonView;
    // it now takes ~10 ms. The bound is loose so slow CI machines don't flake.
    const element = '{ "type": "Table", "fallback": "drop", "rows": [] }';
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [' + Array(2000).fill(element).join(",") + "] }";
    const started = Date.now();
    assert.deepEqual(diagnose(src), []);
    assert.ok(Date.now() - started < 300, `took ${Date.now() - started} ms`);
  });
});
