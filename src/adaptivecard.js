// @ts-check
/**
 * @fileoverview Best-effort, content-triggered checks for Adaptive Card JSON
 * embedded in an OtterScript text template (e.g. a Microsoft Teams webhook
 * body).
 *
 * Deliberately narrow in scope: no schema-driven structural/required-property
 * validation, and no attempt to resolve what a `<% foreach %>` loop or an
 * embedded `$` expression actually produces at runtime -- a template can
 * legitimately render many different concrete JSON shapes depending on data
 * that only exists at execution time, and this module does not try to
 * enumerate or approximate them. It only checks things that hold regardless
 * of what any template hole evaluates to:
 * - every literal `"type": "..."` value inside the Adaptive Card object must
 *   be a real element/action type name (see adaptivecard-data.js) -- except
 *   inside free-form payloads such as an action's `data`, Teams' `msteams`
 *   extension or `Authentication.buttons`, where `"type"` is arbitrary;
 * - the card must have a `"version"` property, no newer than the target host
 *   supports (the `otterscript.adaptiveCards.maxVersion` setting);
 * - no element, action or property may need a newer card version than the
 *   card declares (unless it, or an element around it, has a `"fallback"`);
 * - a property limited to a fixed list (`"weight"`, `"spacing"`, ...) must
 *   have one of its values, unless the value is filled in by OtterScript.
 *
 * @module adaptivecard
 */

const vscode = require("vscode");
const { createTemplateScanState, maskTemplateTagContents, isUnescapedQuoteAt } = require("./scanner");
const { editDistance } = require("./helpers");
const { ADAPTIVE_CARD_TYPES, ADAPTIVE_CARD_PROPERTIES, ADAPTIVE_CARD_VALUE_LISTS } = require("./adaptivecard-data");

/**
 * Splits `text` into its double-quoted JSON string-literal tokens, honoring
 * backslash escaping (so `\"` inside a string doesn't end it early). Used
 * instead of a raw regex so a string VALUE that happens to contain
 * characters resembling `"type": "X"` (e.g. a TextBlock showing example
 * JSON to the user) stays part of its OWN token and is never re-split into
 * fake key/value tokens.
 *
 * @param {string} text
 * @returns {{ value: string, start: number, end: number }[]} `start`/`end`
 *   are the indices of the surrounding quotes; `value` is the raw text
 *   between them (escape sequences left undecoded).
 */
function findJsonStringTokens(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') { i++; continue; }
    const start = i;
    let j = i + 1;
    while (j < text.length && !(text[j] === '"' && isUnescapedQuoteAt(text, j))) j++;
    if (j >= text.length) break; // unterminated -- malformed JSON, not this module's concern
    tokens.push({ value: text.slice(start + 1, j), start, end: j });
    i = j + 1;
  }
  return tokens;
}

/**
 * One text's JSON structure, computed once so every lookup below is cheap
 * (re-scanning the text per lookup made a large card quadratic):
 * - `tokens` -- its string tokens ({@link findJsonStringTokens})
 * - `enclosing[i]` -- index of the innermost `{` containing `tokens[i]`, or -1
 * - `closeOf` -- each `{` / `[` index mapped to its matching `}` / `]`
 *
 * Braces and brackets are matched independently (a `}` only closes a `{`),
 * and string tokens are skipped whole, so brackets inside string values
 * don't count.
 *
 * @typedef {{
 *   text: string,
 *   tokens: { value: string, start: number, end: number }[],
 *   enclosing: number[],
 *   closeOf: Map<number, number>
 * }} JsonView
 */

/**
 * Builds the {@link JsonView} of `text` in one pass.
 *
 * @param {string} text
 * @returns {JsonView}
 */
function analyzeJson(text) {
  const tokens = findJsonStringTokens(text);
  /** @type {number[]} */
  const enclosing = [];
  /** @type {Map<number, number>} */
  const closeOf = new Map();
  /** @type {number[]} */
  const braces = [];
  /** @type {number[]} */
  const brackets = [];

  let t = 0;
  for (let i = 0; i < text.length; i++) {
    if (t < tokens.length && i === tokens[t].start) {
      enclosing.push(braces.length ? braces[braces.length - 1] : -1);
      i = tokens[t].end; // skip the string; the loop's i++ lands just past it
      t++;
      continue;
    }
    const ch = text[i];
    if (ch === "{") braces.push(i);
    else if (ch === "[") brackets.push(i);
    else if (ch === "}") { const open = braces.pop(); if (open !== undefined) closeOf.set(open, i); }
    else if (ch === "]") { const open = brackets.pop(); if (open !== undefined) closeOf.set(open, i); }
  }
  return { text, tokens, enclosing, closeOf };
}

/**
 * If `token` is a JSON key (followed by only whitespace and `:`), returns the
 * index where its value starts (first non-whitespace after the colon);
 * otherwise -1.
 *
 * @param {string} text
 * @param {{ end: number }} token - A token from {@link findJsonStringTokens}
 * @returns {number}
 */
function valueStartAfterKey(text, token) {
  let i = token.end + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== ":") return -1;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Finds every `"<keyName>": "<value>"` property -- i.e. every place a string
 * token equal to `keyName` is immediately followed (only whitespace and a
 * `:` between) by another string token. Two JSON string tokens separated by
 * nothing but a colon can only mean a key/value pair in well-formed JSON (a
 * value is never followed directly by a bare colon), so this can't be fooled
 * by unrelated string content the way a plain regex scanning raw characters
 * can.
 *
 * @param {JsonView} json
 * @param {string} keyName
 * @returns {{ value: string, valueStart: number, valueEnd: number, objectStart: number }[]}
 *   `valueStart`/`valueEnd` bracket just the value's content, excluding its
 *   surrounding quotes; `objectStart` is the `{` of the object the property
 *   belongs to (-1 if none).
 */
function findStringProperties(json, keyName) {
  const { text, tokens, enclosing } = json;
  const results = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].value !== keyName) continue;
    const between = text.slice(tokens[i].end + 1, tokens[i + 1].start);
    if (!/^\s*:\s*$/.test(between)) continue;
    const valueToken = tokens[i + 1];
    results.push({
      value: valueToken.value,
      valueStart: valueToken.start + 1,
      valueEnd: valueToken.end,
      objectStart: enclosing[i + 1],
    });
  }
  return results;
}

/**
 * Whether the root object (the `{` at offset 0) has its own `keyName` key,
 * regardless of what its value is (string, number, `<% %>` template, ...).
 * The same key on a nested object, e.g. inside an `Action.Submit` `data`
 * payload, doesn't count. A string token followed by nothing but whitespace
 * and then `:` can only be a key in well-formed JSON, so -- as with
 * {@link findStringProperties} -- this can't be triggered by unrelated string
 * content.
 *
 * @param {JsonView} json
 * @param {string} keyName
 * @returns {boolean}
 */
function hasOwnKeyProperty(json, keyName) {
  return json.tokens.some(
    (token, i) =>
      token.value === keyName &&
      json.enclosing[i] === 0 &&
      valueStartAfterKey(json.text, token) !== -1
  );
}

/**
 * Keys whose value is free-form JSON rather than Adaptive Card content, so a
 * `"type"` anywhere inside it is NOT an element/action discriminator:
 * - `data` — the arbitrary payload of `Action.Submit` / `Action.Execute`
 * - `msteams` — Teams' card extension, e.g. mention entities
 *   (`"entities": [{ "type": "mention", ... }]`)
 * - `buttons` — `Authentication.buttons`, whose `"type"` is a free-form
 *   sign-in kind (e.g. `"signin"`), not an element/action name
 * @type {ReadonlySet<string>}
 */
const FREE_FORM_KEYS = new Set(["data", "msteams", "buttons"]);

/**
 * Finds the `[start, end]` spans of every object/array value belonging to a
 * {@link FREE_FORM_KEYS} key. A scalar value (e.g. `"data": "x"`) contains
 * nothing nested, so it yields no span.
 *
 * @param {JsonView} json
 * @returns {{ start: number, end: number }[]}
 */
function findFreeFormSpans(json) {
  /** @type {{ start: number, end: number }[]} */
  const spans = [];
  for (const token of json.tokens) {
    if (!FREE_FORM_KEYS.has(token.value)) continue;
    const valueStart = valueStartAfterKey(json.text, token);
    if (valueStart === -1) continue;
    const end = json.closeOf.get(valueStart); // only set for a '{' or '['
    if (end !== undefined) spans.push({ start: valueStart, end });
  }
  return spans;
}

/**
 * Finds the `[start, end]` span of every object that has its own
 * `"fallback"` key. A host that doesn't support such an element replaces the
 * whole object -- children included -- with its fallback, so nothing inside
 * the span needs the card's declared version.
 *
 * @param {JsonView} json
 * @returns {{ start: number, end: number }[]}
 */
function findFallbackSpans(json) {
  /** @type {{ start: number, end: number }[]} */
  const spans = [];
  json.tokens.forEach((token, i) => {
    if (token.value !== "fallback" || valueStartAfterKey(json.text, token) === -1) return;
    const start = json.enclosing[i];
    const end = json.closeOf.get(start);
    if (end !== undefined) spans.push({ start, end });
  });
  return spans;
}

/**
 * Whether `index` falls strictly inside any of `spans` (as returned by
 * {@link findFreeFormSpans} / {@link findFallbackSpans}).
 *
 * @param {{ start: number, end: number }[]} spans
 * @param {number} index
 * @returns {boolean}
 */
function isInsideAny(spans, index) {
  return spans.some((s) => index > s.start && index < s.end);
}

/**
 * Parses a `"major.minor"` card version. Anything else -- a templated value
 * such as `"$CardVersion"`, or a malformed one -- yields null, which turns
 * the version comparison off rather than guessing.
 *
 * @param {string} value
 * @returns {[number, number] | null}
 */
function parseCardVersion(value) {
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Compares two parsed card versions.
 *
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number} Negative, zero, or positive, like a sort comparator.
 */
function compareCardVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * Locates the Adaptive Card in a document: the first literal (non-`<% %>`)
 * object with `"type": "AdaptiveCard"` that isn't a lookalike inside a
 * free-form payload.
 *
 * @param {string} text - Full document text
 * @returns {{ objStart: number, card: JsonView } | null} `card` is the
 *   {@link JsonView} of the card object's literal text, from its `{` to its
 *   matching `}`; offsets inside it are relative to `objStart`.
 */
function locateCard(text) {
  const state = createTemplateScanState();
  const literal = analyzeJson(text.split("\n").map((line) => maskTemplateTagContents(line, state)).join("\n"));

  // A payload that merely looks like a card (e.g. an Action.Submit "data"
  // object with "type": "AdaptiveCard") is not the card -- skip such
  // candidates so they neither trigger the checks nor shadow the real root.
  const literalFreeFormSpans = findFreeFormSpans(literal);
  const root = findStringProperties(literal, "type").find(
    (t) => t.value === "AdaptiveCard" && !isInsideAny(literalFreeFormSpans, t.valueStart)
  );
  if (!root) return null;

  const objStart = root.objectStart;
  if (objStart === -1) return null; // malformed JSON -- the unbalanced-symbol check owns this
  const objEnd = literal.closeOf.get(objStart);
  if (objEnd === undefined) return null;

  return { objStart, card: analyzeJson(literal.text.slice(objStart, objEnd + 1)) };
}

/**
 * The card's own `"version"` string property (not one belonging to a nested
 * object), with its value's offsets relative to the card text.
 *
 * @param {JsonView} card - As returned by {@link locateCard}
 * @returns {{ value: string, valueStart: number, valueEnd: number } | undefined}
 */
function findOwnVersionProperty(card) {
  return findStringProperties(card, "version").find((p) => p.objectStart === 0);
}

/**
 * Maps the `{` of every typed object in the card to its `"type"`, leaving out
 * objects inside free-form payloads (whose `"type"` means something else).
 *
 * @param {JsonView} card
 * @returns {Map<number, string>}
 */
function findObjectTypes(card) {
  const freeFormSpans = findFreeFormSpans(card);
  /** @type {Map<number, string>} */
  const types = new Map();
  for (const { value, valueStart, objectStart } of findStringProperties(card, "type")) {
    if (objectStart === -1 || types.has(objectStart) || isInsideAny(freeFormSpans, valueStart)) continue;
    types.set(objectStart, value);
  }
  return types;
}

/**
 * One key of a typed object that the property data has something to check
 * for (see `ADAPTIVE_CARD_PROPERTIES`).
 *
 * @typedef {{
 *   type: string,
 *   key: string,
 *   keyStart: number,
 *   keyEnd: number,
 *   valueToken: { value: string, start: number, end: number } | undefined,
 *   info: { version?: string, values?: string }
 * }} CheckedProperty
 *   `keyStart`/`keyEnd` bracket the key's name without its quotes;
 *   `valueToken` is the value when it is a string, otherwise undefined.
 */

/**
 * Every key in the card that has a version or a fixed list of values to
 * check, with the type of the object it belongs to.
 *
 * @param {JsonView} card
 * @param {Map<number, string>} objectTypes - From {@link findObjectTypes}
 * @returns {CheckedProperty[]}
 */
function findCheckedProperties(card, objectTypes) {
  const { text, tokens, enclosing } = card;
  /** @type {CheckedProperty[]} */
  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    const type = objectTypes.get(enclosing[i]);
    const info = type && ADAPTIVE_CARD_PROPERTIES.get(type)?.get(tokens[i].value);
    if (!type || !info) continue;
    const valueStart = valueStartAfterKey(text, tokens[i]);
    if (valueStart === -1) continue; // a string value that happens to match a key name
    const next = tokens[i + 1];
    results.push({
      type,
      key: tokens[i].value,
      keyStart: tokens[i].start + 1,
      keyEnd: tokens[i].end,
      valueToken: next && next.start === valueStart ? next : undefined,
      info,
    });
  }
  return results;
}

/**
 * One element, action or property that needs a newer card version than the
 * card declares. `start`/`end` bracket the type name or the property key;
 * `label` names it in messages (`'Table'`, `'rtl' on Column`).
 *
 * @typedef {{ start: number, end: number, required: string, label: string }} TooNewItem
 */

/**
 * Every element/action `"type"` and property in the card that needs a newer
 * card version than `cardVersion`. Skipped: free-form payloads, and anything
 * in an element that has a `"fallback"` (or sits inside one that does) --
 * that's the standard way to use a newer feature on purpose while still
 * targeting older hosts.
 *
 * @param {JsonView} card
 * @param {[number, number]} cardVersion
 * @returns {TooNewItem[]}
 */
function findTooNewItems(card, cardVersion) {
  /** @type {TooNewItem[]} */
  const results = [];
  /**
   * @param {string | undefined} required
   * @returns {boolean}
   */
  const isTooNew = (required) => {
    const parsed = required ? parseCardVersion(required) : null;
    return parsed !== null && compareCardVersions(parsed, cardVersion) > 0;
  };

  const objectTypes = findObjectTypes(card);
  for (const { value, valueStart, valueEnd, objectStart } of findStringProperties(card, "type")) {
    if (objectTypes.get(objectStart) !== value) continue; // free-form, or a second "type" key
    const required = ADAPTIVE_CARD_TYPES.get(value);
    if (required && isTooNew(required)) results.push({ start: valueStart, end: valueEnd, required, label: `'${value}'` });
  }
  for (const { type, key, keyStart, keyEnd, info } of findCheckedProperties(card, objectTypes)) {
    if (info.version && isTooNew(info.version)) {
      results.push({ start: keyStart, end: keyEnd, required: info.version, label: `'${key}' on ${type}` });
    }
  }
  if (results.length === 0) return results;

  const fallbackSpans = findFallbackSpans(card);
  return results.filter((item) => !isInsideAny(fallbackSpans, item.start));
}

/**
 * Whether a string value is (partly) filled in when the template runs -- an
 * OtterScript variable or expression, or a `<% %>` tag -- so its final text
 * can't be checked.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isTemplatedValue(value) {
  return /[$@%`<]/.test(value);
}

/**
 * The allowed value closest to `value` -- a likely typo such as `"bold"` for
 * `"bolder"` -- or undefined when none is close enough to suggest.
 *
 * @param {string} value
 * @param {readonly string[]} allowed
 * @returns {string | undefined}
 */
function nearestAllowedValue(value, allowed) {
  const lower = value.toLowerCase();
  let best;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const d = editDistance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return bestDistance <= Math.max(2, Math.ceil(value.length / 3)) ? best : undefined;
}

/**
 * One property whose string value isn't in its fixed list. `start`/`end`
 * bracket the value without its quotes.
 *
 * @typedef {{
 *   start: number,
 *   end: number,
 *   value: string,
 *   type: string,
 *   key: string,
 *   allowed: ReadonlyArray<string>,
 *   suggestion: string | undefined
 * }} InvalidValue
 */

/**
 * Every property in the card whose literal string value isn't one of the
 * values its list allows. Compared case-insensitively, as hosts do; templated
 * and empty values are skipped.
 *
 * @param {JsonView} card
 * @returns {InvalidValue[]}
 */
function findInvalidValues(card) {
  /** @type {InvalidValue[]} */
  const results = [];
  for (const { type, key, valueToken, info } of findCheckedProperties(card, findObjectTypes(card))) {
    const allowed = info.values ? ADAPTIVE_CARD_VALUE_LISTS.get(info.values) : undefined;
    if (!allowed || !valueToken) continue;
    const { value } = valueToken;
    if (value === "" || isTemplatedValue(value)) continue;
    const lower = value.toLowerCase();
    if (allowed.some((a) => a.toLowerCase() === lower)) continue;
    results.push({
      start: valueToken.start + 1,
      end: valueToken.end,
      value,
      type,
      key,
      allowed,
      suggestion: nearestAllowedValue(value, allowed),
    });
  }
  return results;
}

/**
 * Runs the Adaptive Card checks over one document. Content-triggered: does
 * nothing unless the literal (non-`<% %>`) text contains `"type": "AdaptiveCard"`
 * somewhere -- everything outside that object (e.g. a Teams message
 * envelope's own `"type": "message"`) is never checked. Only the FIRST such
 * object is the card; an `Action.ShowCard`'s nested card is checked as part
 * of it (its elements against the outer card's `"version"`).
 *
 * @param {vscode.TextDocument} document
 * @param {string} text - `document.getText()`, passed in to avoid recomputing
 * @param {{ maxVersion?: string }} [options] - `maxVersion`: the highest card
 *   version the target host supports (`otterscript.adaptiveCards.maxVersion`);
 *   a missing or malformed value turns the `adaptivecard-version-too-high`
 *   check off
 * @returns {vscode.Diagnostic[]}
 */
function findAdaptiveCardDiagnostics(document, text, options = {}) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  const located = locateCard(text);
  if (!located) return issues;
  const { objStart, card } = located;

  /**
   * Adds a warning spanning `[start, end)` of the card text.
   *
   * @param {number} start
   * @param {number} end
   * @param {string} message
   * @param {string} code
   * @returns {vscode.Diagnostic}
   */
  const addIssue = (start, end, message, code) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(objStart + start), document.positionAt(objStart + end)),
      message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = code;
    diagnostic.source = "OtterScript";
    issues.push(diagnostic);
    return diagnostic;
  };

  if (!hasOwnKeyProperty(card, "version")) {
    addIssue(0, 1, 'Adaptive Card is missing its required "version" property.', "adaptivecard-missing-version");
  }

  const freeFormSpans = findFreeFormSpans(card);
  for (const { value, valueStart, valueEnd } of findStringProperties(card, "type")) {
    if (ADAPTIVE_CARD_TYPES.has(value)) continue;
    if (isInsideAny(freeFormSpans, valueStart)) continue;
    addIssue(valueStart, valueEnd, `Unknown Adaptive Card type '${value}'.`, "adaptivecard-unknown-type");
  }

  for (const { start, end, value, type, key, allowed } of findInvalidValues(card)) {
    addIssue(
      start, end,
      `'${value}' is not a valid value for '${key}' on ${type}. Expected one of: ${allowed.join(", ")}.`,
      "adaptivecard-invalid-value"
    );
  }

  const versionProperty = findOwnVersionProperty(card);
  const cardVersion = versionProperty && parseCardVersion(versionProperty.value);
  if (versionProperty && cardVersion) {
    const declared = versionProperty.value.trim();
    const maxVersion = options.maxVersion ? parseCardVersion(options.maxVersion) : null;
    if (maxVersion && compareCardVersions(cardVersion, maxVersion) > 0) {
      addIssue(
        versionProperty.valueStart, versionProperty.valueEnd,
        `Adaptive Card version ${declared} is newer than ${options.maxVersion?.trim()}, the highest version the target host supports ` +
        "(setting otterscript.adaptiveCards.maxVersion). The host shows the card's fallbackText instead of the card.",
        "adaptivecard-version-too-high"
      );
    }

    const versionLocation = new vscode.Location(
      document.uri,
      new vscode.Range(
        document.positionAt(objStart + versionProperty.valueStart),
        document.positionAt(objStart + versionProperty.valueEnd)
      )
    );
    for (const { start, end, required, label } of findTooNewItems(card, cardVersion)) {
      const diagnostic = addIssue(
        start, end,
        `${label} requires Adaptive Card version ${required} or later, but this card declares version ${declared}.`,
        "adaptivecard-version-too-low"
      );
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(versionLocation, "Card version declared here"),
      ];
    }
  }

  return issues;
}

/**
 * Quick fix for `adaptivecard-version-too-low`: raises the card's declared
 * `"version"` to the highest version any of its elements needs, so one fix
 * clears every such diagnostic in the card. Re-derives everything from the
 * document text (diagnostics handed back by VS Code keep only their public
 * fields), so repeated calls -- e.g. once per diagnostic in Fix All --
 * produce the identical edit.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction | null}
 */
function createCardVersionFix(document, diagnostic) {
  const located = locateCard(document.getText());
  if (!located) return null;
  const versionProperty = findOwnVersionProperty(located.card);
  const cardVersion = versionProperty && parseCardVersion(versionProperty.value);
  if (!versionProperty || !cardVersion) return null;

  let highest = cardVersion;
  let highestText = "";
  for (const { required } of findTooNewItems(located.card, cardVersion)) {
    const parsed = parseCardVersion(required);
    if (parsed && compareCardVersions(parsed, highest) > 0) {
      highest = parsed;
      highestText = required;
    }
  }
  if (!highestText) return null;

  const action = new vscode.CodeAction(`Change card version to ${highestText}`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(located.objStart + versionProperty.valueStart),
      document.positionAt(located.objStart + versionProperty.valueEnd)
    ),
    highestText
  );
  return action;
}

/**
 * Quick fix for `adaptivecard-invalid-value`: replaces the value with the
 * closest allowed one (`"bold"` -> `"bolder"`), when one is close enough to
 * be the intended value. Re-derives the suggestion from the document text,
 * since diagnostics handed back by VS Code keep only their public fields.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction | null}
 */
function createInvalidValueFix(document, diagnostic) {
  const located = locateCard(document.getText());
  if (!located) return null;
  const offset = document.offsetAt(diagnostic.range.start) - located.objStart;
  const invalid = findInvalidValues(located.card).find((v) => v.start === offset);
  if (!invalid?.suggestion) return null;

  const action = new vscode.CodeAction(`Change to '${invalid.suggestion}'`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.edit = new vscode.WorkspaceEdit();
  action.edit.replace(document.uri, diagnostic.range, invalid.suggestion);
  return action;
}

module.exports = {
  createCardVersionFix,
  createInvalidValueFix,
  findAdaptiveCardDiagnostics,
};
