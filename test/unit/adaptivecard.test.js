// @ts-check
/**
 * @fileoverview Unit tests for src/adaptivecard.js — the content-triggered, best-effort
 * Adaptive Card checks: types, versions and property values.
 *
 * Requires the vscode stub before adaptivecard.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { makeDocument } = require("./fake-document");
const {
  findAdaptiveCardDiagnostics,
  findCardCompletions,
  createCardVersionFix,
  createContentTypeFix,
  createInvalidValueFix,
  createTemplatingKeywordFix,
  createToggleTargetFix,
} = require("../../src/adaptivecard.js");

/**
 * A fake document for the quick-fix factories (see fake-document.js).
 *
 * @param {string} source
 * @returns {any}
 */
const oneLineDocument = (source) => makeDocument(source);

/**
 * @param {string} source
 * @param {{ maxVersion?: string }} [options]
 * @returns {any[]}
 */
function diagnose(source, options) {
  const document = makeDocument(source);
  return findAdaptiveCardDiagnostics(document, source, options);
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
      '    { "contentType": "application/vnd.microsoft.card.adaptive", "content": {',
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

  it("does not flag a non-string 'version' (it's present, just not a string)", () => {
    assert.deepEqual(
      only('{ "type": "AdaptiveCard", "version": 1.2, "body": [] }', "adaptivecard-missing-version"),
      []
    );
  });

  it("still flags when 'version' appears only on a nested object", () => {
    const src = '{ "type": "AdaptiveCard", "actions": [ { "type": "Action.Submit", "data": { "version": "2" } } ] }';
    assert.equal(only(src, "adaptivecard-missing-version").length, 1);
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

  it("knows the Teams-only elements and their version", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.4", "body": [ { "type": "Badge" }, { "type": "Chart.Pie" } ] }';
    assert.deepEqual(only(src, "adaptivecard-unknown-type"), []);
    assert.equal(only(src, "adaptivecard-version-too-low").length, 2);
  });
});

describe("findAdaptiveCardDiagnostics — property version too low", () => {
  it("flags a property newer than the card's version, on the property's key", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "ColumnSet", "columns": [ { "type": "Column", "rtl": true } ] } ] }';
    const [d] = only(src, "adaptivecard-version-too-low");
    assert.ok(d);
    assert.equal(d.message, "'rtl' on Column requires Adaptive Card version 1.5 or later, but this card declares version 1.2.");
    assert.equal(d.range.start.character, src.indexOf("rtl"));
    assert.equal(d.range.end.character, src.indexOf("rtl") + 3);
  });

  it("finds inherited properties, such as an input's 1.3 'label'", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Input.Text", "id": "a", "label": "Name" } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low").map((d) => d.message.split(" requires")[0]), ["'label' on Input.Text"]);
  });

  it("checks the key whatever its value is (object, boolean, template)", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.0", "selectAction": { "type": "Action.OpenUrl", "url": "x" } }';
    assert.equal(only(src, "adaptivecard-version-too-low").length, 1);
  });

  it("skips properties of an element that has a fallback", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Input.Text", "id": "a", "label": "Name", "fallback": "drop" } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });

  it("ignores keys inside free-form payloads and on objects with no known type", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.0", "actions": [ { "type": "Action.Submit", "data": { "type": "Column", "rtl": true } } ], "body": [ { "rtl": true } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });

  it("does not mistake a string value for a key", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.0", "body": [ { "type": "TextBlock", "text": "rtl" } ] }';
    assert.deepEqual(only(src, "adaptivecard-version-too-low"), []);
  });
});

describe("findAdaptiveCardDiagnostics — invalid value", () => {
  it("flags a value that isn't in the property's list, naming the allowed values", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "weight": "bold" } ] }';
    const [d] = only(src, "adaptivecard-invalid-value");
    assert.ok(d);
    assert.equal(d.message, "'bold' is not a valid value for 'weight' on TextBlock. Expected one of: default, lighter, bolder.");
    assert.equal(d.range.start.character, src.indexOf("bold\""));
    assert.equal(d.range.end.character, src.indexOf("bold\"") + 4);
  });

  it("compares case-insensitively, as hosts do", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "weight": "Bolder", "size": "MEDIUM" } ] }';
    assert.deepEqual(only(src, "adaptivecard-invalid-value"), []);
  });

  it("uses each type's own list for a shared property name", () => {
    const valid = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Container", "style": "emphasis", "items": [ { "type": "TextBlock", "text": "x", "style": "heading" } ] } ], "actions": [ { "type": "Action.OpenUrl", "url": "x", "style": "positive" } ] }';
    assert.deepEqual(only(valid, "adaptivecard-invalid-value"), []);
    const invalid = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "style": "emphasis" } ] }';
    assert.equal(only(invalid, "adaptivecard-invalid-value").length, 1);
  });

  it("accepts the values Teams adds to the schema's lists", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.5", "body": [ { "type": "Image", "url": "x", "style": "roundedCorners", "spacing": "extraSmall" }, { "type": "TextBlock", "text": "x", "style": "columnHeader" } ] }';
    assert.deepEqual(only(src, "adaptivecard-invalid-value"), []);
  });

  it("skips values filled in by the template, and empty values", () => {
    for (const value of ["$Weight", "$(Weight)", "<% $w %>", "@x", "%m.w", ""]) {
      const src = `{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "weight": "${value}" } ] }`;
      assert.deepEqual(only(src, "adaptivecard-invalid-value"), [], value);
    }
  });

  it("leaves properties that also accept free text alone (e.g. an Image's pixel height)", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Image", "url": "x", "height": "50px" } ] }';
    assert.deepEqual(only(src, "adaptivecard-invalid-value"), []);
  });

  it("does not check Teams-only elements, which the schema doesn't describe", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.5", "body": [ { "type": "Badge", "size": "huge" } ] }';
    assert.deepEqual(only(src, "adaptivecard-invalid-value"), []);
  });
});

describe("createInvalidValueFix", () => {
  /** @param {string} source */
  function fixFor(source) {
    const [d] = only(source, "adaptivecard-invalid-value");
    return createInvalidValueFix(oneLineDocument(source), d);
  }

  it("offers the closest allowed value", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "weight": "bold" } ] }';
    const fix = /** @type {any} */ (fixFor(src));
    assert.equal(fix.title, "Change to 'bolder'");
    const [[, , range, text]] = fix.edit.edits;
    assert.equal(range.start.character, src.indexOf("bold\""));
    assert.equal(text, "bolder");
  });

  it("offers nothing when no allowed value is close", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "text": "x", "color": "red" } ] }';
    assert.equal(fixFor(src), null);
  });
});

describe("findAdaptiveCardDiagnostics — version too high", () => {
  const card = (/** @type {string} */ version) => `{ "type": "AdaptiveCard", "version": "${version}", "body": [] }`;

  it("flags a card version above the host's maximum, on the version value", () => {
    const src = card("1.6");
    const [d] = diagnose(src, { maxVersion: "1.5" });
    assert.equal(d.code, "adaptivecard-version-too-high");
    assert.match(d.message, /^Adaptive Card version 1\.6 is newer than 1\.5, the highest version the target host supports/);
    assert.equal(d.range.start.character, src.indexOf("1.6"));
  });

  it("allows the maximum itself and anything older", () => {
    for (const version of ["1.6", "1.2"]) {
      assert.deepEqual(diagnose(card(version), { maxVersion: "1.6" }), [], version);
    }
  });

  it("is off without a usable maximum, or when the version is templated", () => {
    assert.deepEqual(diagnose(card("1.6")), []);
    assert.deepEqual(diagnose(card("1.6"), { maxVersion: "latest" }), []);
    assert.deepEqual(diagnose(card("$CardVersion"), { maxVersion: "1.5" }), []);
  });
});

describe("createCardVersionFix — host maximum", () => {
  const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Table" } ] }';
  /** @param {string | undefined} maxVersion */
  const fixWith = (maxVersion) => {
    const [d] = only(src, "adaptivecard-version-too-low");
    return /** @type {any} */ (createCardVersionFix(oneLineDocument(src), d, { maxVersion }));
  };

  it("is the preferred fix when the new version is within the host's maximum", () => {
    const fix = fixWith("1.6");
    assert.equal(fix.title, "Change card version to 1.5");
    assert.equal(fix.isPreferred, true);
  });

  it("says so, and isn't preferred (Fix All skips it), when the new version is above the maximum", () => {
    const fix = fixWith("1.4");
    assert.equal(fix.title, "Change card version to 1.5 (above the host's maximum, 1.4)");
    assert.equal(fix.isPreferred, false);
  });
});

describe("createCardVersionFix", () => {
  /** @param {string} source */
  function fixFor(source) {
    const [d] = only(source, "adaptivecard-version-too-low");
    return createCardVersionFix(oneLineDocument(source), d);
  }

  it("counts properties too when choosing the version", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.0", "rtl": false, "body": [ { "type": "Media" } ] }';
    assert.equal(/** @type {any} */ (fixFor(src)).title, "Change card version to 1.5");
  });

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
    assert.equal(createCardVersionFix(oneLineDocument(src), /** @type {any} */ ({})), null);
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

describe("findAdaptiveCardDiagnostics — templating keywords", () => {
  it("flags a templating key, on the key", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "Container", "$data": "x", "items": [] } ] }';
    const [d] = only(src, "adaptivecard-templating-keyword");
    assert.ok(d);
    assert.match(d.message, /^'\$data' is an Adaptive Card Templating keyword, but OtterScript expands it here/);
    assert.equal(d.range.start.character, src.indexOf("$data"));
    assert.equal(d.range.end.character, src.indexOf("$data") + 5);
  });

  it("finds every keyword, but not an escaped one or a value", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "TextBlock", "$when": "x", "`$root": "y", "text": "$data" } ] }';
    assert.deepEqual(only(src, "adaptivecard-templating-keyword").map((d) => d.message.split("'")[1]), ["$when"]);
  });

  it("escapes the keyword with a backtick", () => {
    const src = '{ "type": "AdaptiveCard", "version": "1.2", "$data": "x" }';
    const [d] = only(src, "adaptivecard-templating-keyword");
    const fix = /** @type {any} */ (createTemplatingKeywordFix(oneLineDocument(src), d));
    assert.equal(fix.title, "Escape as '`$data'");
    const [[op, , position, text]] = fix.edit.edits;
    assert.equal(op, "insert");
    assert.equal(position.character, src.indexOf("$data"));
    assert.equal(text, "`");
  });
});

describe("findAdaptiveCardDiagnostics — Teams message", () => {
  const CARD = '{ "type": "AdaptiveCard", "version": "1.2", "actions": [ { "type": "Action.Submit", "title": "OK", "data": { "type": "Action.Submit" } } ] }';
  /**
   * @param {string} attachment - The attachment's properties before "content"
   * @param {string} [card]
   */
  const message = (attachment, card = CARD) =>
    `{ "type": "message", "attachments": [ { ${attachment}"content": ${card} } ] }`;

  it("flags a wrong contentType, on its value, and fixes it", () => {
    const src = message('"contentType": "application/json", ');
    const [d] = only(src, "adaptivecard-content-type");
    assert.ok(d);
    assert.equal(d.range.start.character, src.indexOf("application/json"));
    const fix = /** @type {any} */ (createContentTypeFix(oneLineDocument(src), d));
    assert.deepEqual(fix.edit.edits[0][3], "application/vnd.microsoft.card.adaptive");
  });

  it("flags a missing contentType on the content key, and adds it", () => {
    const src = message("");
    const [d] = only(src, "adaptivecard-content-type");
    assert.ok(d);
    assert.equal(d.range.start.character, src.indexOf("content"));
    const fix = /** @type {any} */ (createContentTypeFix(oneLineDocument(src), d));
    const [[op, , position, text]] = fix.edit.edits;
    assert.equal(op, "insert");
    assert.equal(position.character, src.indexOf('"content"'));
    assert.equal(text, '"contentType": "application/vnd.microsoft.card.adaptive", ');
  });

  it("accepts the right contentType in any case, and a templated one", () => {
    for (const value of ["application/vnd.microsoft.card.adaptive", "Application/Vnd.Microsoft.Card.Adaptive", "$ContentType"]) {
      assert.deepEqual(only(message(`"contentType": "${value}", `), "adaptivecard-content-type"), [], value);
    }
  });

  it("flags Action.Submit in a Teams message, but not inside a data payload", () => {
    const src = message('"contentType": "application/vnd.microsoft.card.adaptive", ');
    const found = only(src, "adaptivecard-webhook-submit");
    assert.equal(found.length, 1);
    assert.equal(found[0].range.start.character, src.indexOf("Action.Submit"));
  });

  it("leaves a card that isn't sent as a Teams message alone", () => {
    assert.deepEqual(diagnose(CARD), []);
    // An attachment, but not in a "type": "message" object.
    const src = `{ "attachments": [ { "contentType": "application/vnd.microsoft.card.adaptive", "content": ${CARD} } ] }`;
    assert.deepEqual(only(src, "adaptivecard-webhook-submit"), []);
  });
});

describe("findAdaptiveCardDiagnostics — ToggleVisibility targets and ids", () => {
  /**
   * A 1.2 card with the given body elements and one toggle action.
   *
   * @param {string} body
   * @param {string} targets - The `targetElements` array's contents
   */
  const card = (body, targets) =>
    `{ "type": "AdaptiveCard", "version": "1.2", "body": [ ${body} ], ` +
    `"actions": [ { "type": "Action.ToggleVisibility", "title": "More", "targetElements": [ ${targets} ] } ] }`;
  const details = '{ "type": "TextBlock", "id": "details", "text": "x", "isVisible": false }';

  it("accepts targets that are element ids, as strings or elementId objects", () => {
    const src = card(`${details}, { "type": "ColumnSet", "columns": [ { "id": "col", "items": [] } ] }`,
      '"details", { "elementId": "col", "isVisible": true }');
    assert.deepEqual(diagnose(src), []);
  });

  it("flags a target no element has, with a quick fix to the closest id", () => {
    const src = card(details, '"detials"');
    const [d] = only(src, "adaptivecard-unknown-target");
    assert.match(d.message, /'detials'.*Did you mean 'details'\?/);
    assert.equal(d.range.start.character, src.indexOf("detials"));
    const fix = createToggleTargetFix(oneLineDocument(src), d);
    assert.equal(fix?.title, "Change to 'details'");
  });

  it("flags an unknown elementId, and compares ids case-sensitively", () => {
    const src = card(details, '{ "elementId": "Details" }');
    assert.equal(only(src, "adaptivecard-unknown-target").length, 1);
  });

  it("flags a target that is an action's id: a toggle can't hide an action", () => {
    const src = `{ "type": "AdaptiveCard", "version": "1.2", "body": [ ${details} ], "actions": [ ` +
      '{ "type": "Action.OpenUrl", "id": "open", "title": "Open", "url": "https://example.com" }, ' +
      '{ "type": "Action.ToggleVisibility", "title": "More", "targetElements": [ "open" ] } ] }';
    assert.equal(only(src, "adaptivecard-unknown-target").length, 1);
  });

  it("offers no fix when no id is close", () => {
    const src = card(details, '"somethingElse"');
    const [d] = only(src, "adaptivecard-unknown-target");
    assert.doesNotMatch(d.message, /Did you mean/);
    assert.equal(createToggleTargetFix(oneLineDocument(src), d), null);
  });

  it("skips templated targets, and every target when an id is templated", () => {
    assert.deepEqual(only(card(details, '"$Target"'), "adaptivecard-unknown-target"), []);
    const templatedId = '{ "type": "TextBlock", "id": "row$i", "text": "x" }';
    assert.deepEqual(only(card(templatedId, '"row1"'), "adaptivecard-unknown-target"), []);
  });

  it("ignores ids and targetElements in free-form payloads and other actions", () => {
    const src = `{ "type": "AdaptiveCard", "version": "1.2", "body": [], "actions": [ ` +
      '{ "type": "Action.Submit", "title": "Go", "data": { "id": "x", "targetElements": [ "nowhere" ] } } ] }';
    assert.deepEqual(only(src, "adaptivecard-unknown-target"), []);
    assert.deepEqual(only(src, "adaptivecard-duplicate-id"), []);
  });

  it("flags a duplicate id, pointing at the first one", () => {
    const src = card(`${details}, ${details}`, '"details"');
    const [d] = only(src, "adaptivecard-duplicate-id");
    assert.equal(d.range.start.character, src.lastIndexOf("details\", \"text"));
    assert.equal(d.relatedInformation[0].location.range.start.character, src.indexOf("details"));
    assert.deepEqual(only(src, "adaptivecard-unknown-target"), []);
  });

  it("doesn't flag the same id in alternative <% %> branches", () => {
    const src = card(`<% if $x { %>${details}<% } else { %>${details}<% } %>`, '"details"');
    assert.deepEqual(only(src, "adaptivecard-duplicate-id"), []);
  });
});

describe("findCardCompletions", () => {
  /**
   * The completion labels at the `|` in `source`, or null.
   *
   * @param {string} source
   * @returns {string[] | null}
   */
  const labelsAt = (source) => {
    const offset = source.indexOf("|");
    const found = findCardCompletions(source.slice(0, offset) + source.slice(offset + 1), offset);
    if (found) assert.equal(found.start, source.lastIndexOf('"', offset) + 1, "starts after the opening quote");
    return found && found.items.map((item) => item.label);
  };
  const CARD = '{ "type": "AdaptiveCard", "version": "1.2", ';

  it("offers element types in body, limited to the card's version", () => {
    const labels = labelsAt(`${CARD}"body": [ { "type": "|" } ] }`) ?? [];
    assert.ok(labels.includes("TextBlock") && labels.includes("ActionSet"), labels.join(" "));
    assert.ok(!labels.includes("Table"), "1.5, newer than the card");
    assert.ok(!labels.includes("Action.OpenUrl") && !labels.includes("Column") && !labels.includes("AdaptiveCard"));
  });

  it("offers only actions in actions and selectAction, and Column in columns", () => {
    assert.deepEqual(labelsAt(`${CARD}"actions": [ { "type": "|`)?.every((l) => l.startsWith("Action.")), true);
    assert.deepEqual(labelsAt(`${CARD}"body": [ { "type": "Container", "selectAction": { "type": "Action.Op|" } } ] }`)
      ?.every((l) => l.startsWith("Action.")), true);
    assert.deepEqual(labelsAt(`${CARD}"body": [ { "type": "ColumnSet", "columns": [ { "type": "|" } ] } ] }`), ["Column"]);
  });

  it("offers every type the version allows when the version is templated or missing", () => {
    const labels = labelsAt('{ "type": "AdaptiveCard", "version": "$V", "body": [ { "type": "|" } ] }') ?? [];
    assert.ok(labels.includes("Table"));
  });

  it("offers a property's allowed values, with the object's type before or after the key", () => {
    assert.deepEqual(labelsAt(`${CARD}"body": [ { "type": "TextBlock", "weight": "b|" } ] }`), ["default", "lighter", "bolder"]);
    assert.deepEqual(labelsAt(`${CARD}"body": [ { "weight": "|", "type": "TextBlock" } ] }`), ["default", "lighter", "bolder"]);
    assert.equal(labelsAt(`${CARD}"body": [ { "type": "TextBlock", "text": "|" } ] }`), null, "free text");
  });

  it("offers the card's element ids as ToggleVisibility targets", () => {
    const body = `${CARD}"body": [ { "type": "TextBlock", "id": "details", "text": "x" }, { "type": "Image", "id": "row$i" } ], `;
    assert.deepEqual(labelsAt(`${body}"actions": [ { "type": "Action.ToggleVisibility", "targetElements": [ "|" ] } ] }`), ["details"]);
    assert.deepEqual(labelsAt(`${body}"actions": [ { "type": "Action.ToggleVisibility", "targetElements": [ "a", { "elementId": "|" } ] } ] }`), ["details"]);
    assert.equal(labelsAt(`${body}"actions": [ { "type": "Action.Submit", "targetElements": [ "|" ] } ] }`), null);
    // Not an action's own id.
    assert.deepEqual(labelsAt(`${body}"actions": [ { "type": "Action.Submit", "id": "go", "title": "Go" }, ` +
      '{ "type": "Action.ToggleVisibility", "targetElements": [ "|" ] } ] }'), ["details"]);
  });

  it("offers nothing outside a card, in a key, in a free-form payload or in a <% %> tag", () => {
    assert.equal(labelsAt('{ "type": "message", "weight": "|" }'), null);
    assert.equal(labelsAt(`${CARD}"body": [ { "|`), null);
    assert.equal(labelsAt(`${CARD}"actions": [ { "type": "Action.Submit", "data": { "type": "|" } } ] }`), null);
    assert.equal(labelsAt(`${CARD}"body": [ <% set $x = "|"; %> ] }`), null);
  });

  it("works with <% %> tags around the card's parts", () => {
    const src = `<% if $Notify { %>
${CARD}"body": [
<% foreach $n in @Names { %>
{ "type": "TextBlock", "size": "|" },
<% } %>
] }
<% } %>`;
    assert.ok(labelsAt(src)?.includes("large"));
  });
});
