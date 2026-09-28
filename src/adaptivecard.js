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
 * of what any template hole evaluates to: every literal `"type": "..."`
 * value inside the Adaptive Card object must be a real element/action type
 * name (see adaptivecard-data.js) -- except inside free-form payloads such as
 * an action's `data`, Teams' `msteams` extension or `Authentication.buttons`,
 * where `"type"` is arbitrary -- that object must have a `"version"` property,
 * and no element or action may need a newer card version than it declares
 * (unless it, or an element around it, provides a `"fallback"`).
 *
 * @module adaptivecard
 */

const vscode = require("vscode");
const { createTemplateScanState, maskTemplateTagContents, isUnescapedQuoteAt } = require("./scanner");
const { ADAPTIVE_CARD_TYPES } = require("./adaptivecard-data");

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
 * Whether `keyName` is used as a JSON key anywhere, regardless of what its
 * value is (string, number, object, ...). A string token followed by nothing
 * but whitespace and then `:` can only be a key in well-formed JSON, so -- as
 * with {@link findStringProperties} -- this can't be triggered by unrelated
 * string content.
 *
 * @param {JsonView} json
 * @param {string} keyName
 * @returns {boolean}
 */
function hasKeyProperty(json, keyName) {
  return json.tokens.some(
    (token) => token.value === keyName && valueStartAfterKey(json.text, token) !== -1
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
 * Every element/action `"type"` in the card that needs a newer card version
 * than `cardVersion`. Skipped: free-form payloads, and any element that has
 * a `"fallback"` (or sits inside one that does) -- that's the standard way to
 * use a newer element on purpose while still targeting older hosts.
 *
 * @param {JsonView} card
 * @param {[number, number]} cardVersion
 * @returns {{ value: string, valueStart: number, valueEnd: number, required: string }[]}
 */
function findTooNewTypes(card, cardVersion) {
  /** @type {{ value: string, valueStart: number, valueEnd: number, required: string }[]} */
  const results = [];
  /** @type {{ start: number, end: number }[] | null} computed only if something is too new */
  let skippedSpans = null;
  for (const { value, valueStart, valueEnd } of findStringProperties(card, "type")) {
    const required = ADAPTIVE_CARD_TYPES.get(value);
    const requiredVersion = required && parseCardVersion(required);
    if (!required || !requiredVersion || compareCardVersions(requiredVersion, cardVersion) <= 0) continue;

    skippedSpans ??= [...findFreeFormSpans(card), ...findFallbackSpans(card)];
    if (isInsideAny(skippedSpans, valueStart)) continue;

    results.push({ value, valueStart, valueEnd, required });
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
 * @returns {vscode.Diagnostic[]}
 */
function findAdaptiveCardDiagnostics(document, text) {
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

  if (!hasKeyProperty(card, "version")) {
    addIssue(0, 1, 'Adaptive Card is missing its required "version" property.', "adaptivecard-missing-version");
  }

  const freeFormSpans = findFreeFormSpans(card);
  for (const { value, valueStart, valueEnd } of findStringProperties(card, "type")) {
    if (ADAPTIVE_CARD_TYPES.has(value)) continue;
    if (isInsideAny(freeFormSpans, valueStart)) continue;
    addIssue(valueStart, valueEnd, `Unknown Adaptive Card type '${value}'.`, "adaptivecard-unknown-type");
  }

  const versionProperty = findOwnVersionProperty(card);
  const cardVersion = versionProperty && parseCardVersion(versionProperty.value);
  if (versionProperty && cardVersion) {
    const versionLocation = new vscode.Location(
      document.uri,
      new vscode.Range(
        document.positionAt(objStart + versionProperty.valueStart),
        document.positionAt(objStart + versionProperty.valueEnd)
      )
    );
    for (const { value, valueStart, valueEnd, required } of findTooNewTypes(card, cardVersion)) {
      const diagnostic = addIssue(
        valueStart, valueEnd,
        `'${value}' requires Adaptive Card version ${required} or later, but this card declares version ${versionProperty.value.trim()}.`,
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
  for (const { required } of findTooNewTypes(located.card, cardVersion)) {
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

module.exports = {
  createCardVersionFix,
  findAdaptiveCardDiagnostics,
};
