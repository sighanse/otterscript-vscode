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
 * name (see adaptivecard-data.js), and that object must have a `"version"`
 * property.
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
 * Finds every `"<keyName>": "<value>"` property in `text` -- i.e. every
 * place a string token equal to `keyName` is immediately followed (only
 * whitespace and a `:` between) by another string token. Two JSON string
 * tokens separated by nothing but a colon can only mean a key/value pair in
 * well-formed JSON (a value is never followed directly by a bare colon), so
 * this can't be fooled by unrelated string content the way a plain regex
 * scanning raw characters can.
 *
 * @param {string} text
 * @param {string} keyName
 * @returns {{ value: string, valueStart: number, valueEnd: number }[]}
 *   `valueStart`/`valueEnd` bracket just the value's content, excluding
 *   its surrounding quotes.
 */
function findStringProperties(text, keyName) {
  const tokens = findJsonStringTokens(text);
  const results = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].value !== keyName) continue;
    const between = text.slice(tokens[i].end + 1, tokens[i + 1].start);
    if (!/^\s*:\s*$/.test(between)) continue;
    const valueToken = tokens[i + 1];
    results.push({ value: valueToken.value, valueStart: valueToken.start + 1, valueEnd: valueToken.end });
  }
  return results;
}

/**
 * Whether `text` contains `keyName` used as a JSON key at all, regardless of
 * what its value is (string, number, object, ...). A string token followed
 * by nothing but whitespace and then `:` can only be a key in well-formed
 * JSON, so -- as with {@link findStringProperties} -- this can't be
 * triggered by unrelated string content.
 *
 * @param {string} text
 * @param {string} keyName
 * @returns {boolean}
 */
function hasKeyProperty(text, keyName) {
  const tokens = findJsonStringTokens(text);
  for (const token of tokens) {
    if (token.value !== keyName) continue;
    let i = token.end + 1;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === ":") return true;
  }
  return false;
}

/**
 * Finds the matching `}` for an opening `{` at `openBraceIndex`, scanning
 * forward and skipping quoted-string content (so a `}`/`{` inside a JSON
 * string value doesn't confuse the depth count).
 *
 * @param {string} text
 * @param {number} openBraceIndex
 * @returns {number} Matching `}` index, or -1 if unclosed.
 */
function findMatchingBrace(text, openBraceIndex) {
  let depth = 1;
  /** @type {string | null} */
  let quote = null;
  for (let i = openBraceIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && isUnescapedQuoteAt(text, i)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Finds the nearest unmatched `{` at or before `index`, scanning backward --
 * i.e. the JSON object that directly contains whatever text is at `index`.
 * String tokens (see {@link findJsonStringTokens}) are skipped whole, so a
 * `{`/`}` inside a sibling string value doesn't confuse the depth count --
 * the backward counterpart of {@link findMatchingBrace}'s quote handling.
 *
 * @param {string} text
 * @param {number} index
 * @returns {number} Matching `{` index, or -1 if none found.
 */
function findEnclosingBraceStart(text, index) {
  const tokens = findJsonStringTokens(text);
  let t = tokens.length - 1;
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    while (t >= 0 && tokens[t].start > i) t--;
    if (t >= 0 && tokens[t].end >= i) {
      i = tokens[t].start; // loop's i-- then lands just before the opening quote
      t--;
      continue;
    }
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * Runs the Adaptive Card checks over one document. Content-triggered: does
 * nothing unless the literal (non-`<% %>`) text contains `"type": "AdaptiveCard"`
 * somewhere -- everything outside that object (e.g. a Teams message
 * envelope's own `"type": "message"`) is never checked. Only the FIRST such
 * object is checked; a nested `Action.ShowCard`'s own Adaptive Card is out
 * of scope for now.
 *
 * @param {vscode.TextDocument} document
 * @param {string} text - `document.getText()`, passed in to avoid recomputing
 * @returns {vscode.Diagnostic[]}
 */
function findAdaptiveCardDiagnostics(document, text) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  const state = createTemplateScanState();
  const literalText = text.split("\n").map((line) => maskTemplateTagContents(line, state)).join("\n");

  const root = findStringProperties(literalText, "type").find((t) => t.value === "AdaptiveCard");
  if (!root) return issues;

  const objStart = findEnclosingBraceStart(literalText, root.valueStart);
  if (objStart === -1) return issues; // malformed JSON -- the unbalanced-symbol check owns this
  const objEnd = findMatchingBrace(literalText, objStart);
  if (objEnd === -1) return issues;

  const span = literalText.slice(objStart, objEnd + 1);

  if (!hasKeyProperty(span, "version")) {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(objStart), document.positionAt(objStart + 1)),
      'Adaptive Card is missing its required "version" property.',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = "adaptivecard-missing-version";
    diagnostic.source = "OtterScript";
    issues.push(diagnostic);
  }

  for (const { value, valueStart, valueEnd } of findStringProperties(span, "type")) {
    if (ADAPTIVE_CARD_TYPES.has(value)) continue;

    const absoluteStart = objStart + valueStart;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        document.positionAt(absoluteStart),
        document.positionAt(absoluteStart + (valueEnd - valueStart))
      ),
      `Unknown Adaptive Card type '${value}'.`,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = "adaptivecard-unknown-type";
    diagnostic.source = "OtterScript";
    issues.push(diagnostic);
  }

  return issues;
}

module.exports = {
  findAdaptiveCardDiagnostics,
};
