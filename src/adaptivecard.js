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
 *   have one of its values, unless the value is filled in by OtterScript;
 * - Adaptive Card Templating keys (`"$data"`, ...) are flagged, since
 *   OtterScript expands them as its own variables;
 * - when the card is sent as a Teams message attachment, the attachment
 *   needs the Adaptive Card `contentType`, and `Action.Submit` (unsupported
 *   by incoming webhooks and Workflows) is flagged.
 *
 * @module adaptivecard
 */

const vscode = require("vscode");
const { createTemplateScanState, maskTemplateTagContents } = require("./scanner");
const { editDistance } = require("./helpers");
const { analyzeJson, findStringProperties, hasOwnKeyProperty, valueStartAfterKey } = require("./json-view");
const { ADAPTIVE_CARD_TYPES, ADAPTIVE_CARD_PROPERTIES, ADAPTIVE_CARD_VALUE_LISTS } = require("./adaptivecard-data");

/** @typedef {import("./json-view").JsonView} JsonView */

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
 * @returns {{ objStart: number, card: JsonView, literal: JsonView } | null}
 *   `card` is the {@link JsonView} of the card object's literal text, from
 *   its `{` to its matching `}`; offsets inside it are relative to
 *   `objStart`. `literal` is the whole document's literal text, for looking
 *   at what surrounds the card (see {@link findWebhookEnvelope}).
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

  return { objStart, card: analyzeJson(literal.text.slice(objStart, objEnd + 1)), literal };
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
 * Adaptive Card Templating's reserved keys. In a text template OtterScript
 * expands `$data` & co. in the literal output as its own variables, so a card
 * copied from a templating example breaks when the template runs.
 * @type {ReadonlySet<string>}
 */
const TEMPLATING_KEYWORDS = new Set(["$data", "$when", "$root", "$index", "$host"]);

/**
 * Every templating keyword used as a key in the card. An escaped one
 * (`` "`$data" ``) is a different token value, so it isn't found.
 *
 * @param {JsonView} card
 * @returns {{ value: string, start: number, end: number }[]} `start`/`end`
 *   bracket the key without its quotes.
 */
function findTemplatingKeywords(card) {
  return card.tokens
    .filter((token) => TEMPLATING_KEYWORDS.has(token.value) && valueStartAfterKey(card.text, token) !== -1)
    .map((token) => ({ value: token.value, start: token.start + 1, end: token.end }));
}

/** The `contentType` a Teams message attachment needs for an Adaptive Card. */
const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/**
 * The Teams message around the card, when the card is the `"content"` of an
 * attachment -- the shape a Teams incoming webhook or Workflows trigger takes:
 *
 *     { "type": "message", "attachments": [
 *         { "contentType": "application/vnd.microsoft.card.adaptive", "content": { card } } ] }
 *
 * All offsets are in the document's literal text.
 *
 * @param {JsonView} literal - From {@link locateCard}
 * @param {number} objStart - The card's `{`
 * @returns {{
 *   contentKey: { start: number, end: number },
 *   contentType: { value: string, valueStart: number, valueEnd: number } | undefined,
 *   isMessage: boolean
 * } | null} `contentKey` is the `content` key without its quotes;
 *   `contentType` is undefined when the attachment has none; `isMessage`
 *   tells whether the attachment sits in a `"type": "message"` object's
 *   `attachments`. Null when the card isn't an attachment's `content`.
 */
function findWebhookEnvelope(literal, objStart) {
  const { tokens, enclosing, closeOf, text } = literal;

  // The key right before the card's `{` must be "content".
  let k = tokens.length - 1;
  while (k >= 0 && tokens[k].start > objStart) k--;
  if (k < 0 || tokens[k].value !== "content" || valueStartAfterKey(text, tokens[k]) !== objStart) return null;
  const attachment = enclosing[k];
  if (attachment === -1) return null;

  const contentType = findStringProperties(literal, "contentType").find((p) => p.objectStart === attachment);

  // An object around the attachment with "type": "message" and an
  // "attachments" key of its own.
  const isMessage = findStringProperties(literal, "type").some(({ value, objectStart: o }) => {
    if (value !== "message" || o === -1 || o >= attachment) return false;
    const end = closeOf.get(o);
    return end !== undefined && end > attachment &&
      tokens.some((t, i) => t.value === "attachments" && enclosing[i] === o && valueStartAfterKey(text, t) !== -1);
  });

  return {
    contentKey: { start: tokens[k].start + 1, end: tokens[k].end },
    contentType: contentType && { value: contentType.value, valueStart: contentType.valueStart, valueEnd: contentType.valueEnd },
    isMessage,
  };
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
  const { objStart, card, literal } = located;

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

  for (const { value, start, end } of findTemplatingKeywords(card)) {
    addIssue(
      start, end,
      `'${value}' is an Adaptive Card Templating keyword, but OtterScript expands it here as the variable ` +
      `'${value}'. Teams webhooks don't run templating; if a templating host expands this card, write '\`${value}'.`,
      "adaptivecard-templating-keyword"
    );
  }

  // -- Teams message checks: only when the card is an attachment's "content".
  const envelope = findWebhookEnvelope(literal, objStart);
  if (envelope) {
    const { contentKey, contentType } = envelope;
    if (!contentType) {
      addIssue(
        contentKey.start - objStart, contentKey.end - objStart,
        `This attachment has no "contentType". Teams shows the card only with "contentType": "${ADAPTIVE_CARD_CONTENT_TYPE}".`,
        "adaptivecard-content-type"
      );
    } else if (!isTemplatedValue(contentType.value) && contentType.value.trim().toLowerCase() !== ADAPTIVE_CARD_CONTENT_TYPE) {
      addIssue(
        contentType.valueStart - objStart, contentType.valueEnd - objStart,
        `'${contentType.value}' is not the Adaptive Card content type. Teams shows the card only with "${ADAPTIVE_CARD_CONTENT_TYPE}".`,
        "adaptivecard-content-type"
      );
    }
  }
  if (envelope?.isMessage) {
    for (const { value, valueStart, valueEnd } of findStringProperties(card, "type")) {
      if (value !== "Action.Submit" || isInsideAny(freeFormSpans, valueStart)) continue;
      addIssue(
        valueStart, valueEnd,
        "Teams incoming webhooks and Workflows don't support 'Action.Submit': the button is shown, but there's nothing " +
        "to receive what it sends. Use 'Action.OpenUrl', 'Action.ShowCard' or 'Action.ToggleVisibility' instead.",
        "adaptivecard-webhook-submit"
      );
    }
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
 * When that version is above the host's maximum, the fix is still offered
 * (it's the only way to keep the feature) but says so in its title and is
 * not preferred, so Fix All leaves it to the user: applying it would trade
 * these warnings for `adaptivecard-version-too-high`.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @param {{ maxVersion?: string }} [options] - As for {@link findAdaptiveCardDiagnostics}
 * @returns {vscode.CodeAction | null}
 */
function createCardVersionFix(document, diagnostic, options = {}) {
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

  const maxVersion = options.maxVersion ? parseCardVersion(options.maxVersion) : null;
  const aboveMax = maxVersion !== null && compareCardVersions(highest, maxVersion) > 0;
  const title = aboveMax
    ? `Change card version to ${highestText} (above the host's maximum, ${options.maxVersion?.trim()})`
    : `Change card version to ${highestText}`;

  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = !aboveMax;
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

/**
 * Quick fix for `adaptivecard-templating-keyword`: escapes the keyword with a
 * backtick (`` "`$data" ``), so OtterScript outputs it literally for a
 * templating host to expand.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic - Its range is the key without quotes
 * @returns {vscode.CodeAction}
 */
function createTemplatingKeywordFix(document, diagnostic) {
  const keyword = document.getText(diagnostic.range);
  const action = new vscode.CodeAction(`Escape as '\`${keyword}'`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.edit = new vscode.WorkspaceEdit();
  action.edit.insert(document.uri, diagnostic.range.start, "`");
  return action;
}

/**
 * Quick fix for `adaptivecard-content-type`: sets the attachment's
 * `contentType` to the Adaptive Card one -- replacing a wrong value, or
 * adding the property before `"content"` when it's missing (the diagnostic
 * is then on the `content` key).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic} diagnostic
 * @returns {vscode.CodeAction}
 */
function createContentTypeFix(document, diagnostic) {
  const action = new vscode.CodeAction(`Set contentType to '${ADAPTIVE_CARD_CONTENT_TYPE}'`, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.edit = new vscode.WorkspaceEdit();
  if (document.getText(diagnostic.range) === "content") {
    // Before the key's opening quote.
    const keyQuote = document.positionAt(document.offsetAt(diagnostic.range.start) - 1);
    action.edit.insert(document.uri, keyQuote, `"contentType": "${ADAPTIVE_CARD_CONTENT_TYPE}", `);
  } else {
    action.edit.replace(document.uri, diagnostic.range, ADAPTIVE_CARD_CONTENT_TYPE);
  }
  return action;
}

module.exports = {
  createCardVersionFix,
  createContentTypeFix,
  createInvalidValueFix,
  createTemplatingKeywordFix,
  findAdaptiveCardDiagnostics,
};
