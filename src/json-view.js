// @ts-check
/**
 * @fileoverview A light, error-tolerant view of JSON text, for checking JSON
 * that isn't a single valid document -- such as a text template's literal
 * output, where `<% %>` tags have been blanked and values may be OtterScript
 * expressions. It finds string tokens, which `{` encloses each one, and
 * matching brackets, in one pass; it never parses values.
 *
 * Used by the Adaptive Card checks (adaptivecard.js). vscode-free.
 *
 * @module json-view
 */

const { isUnescapedQuoteAt } = require("./scanner");

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

module.exports = {
  analyzeJson,
  findJsonStringTokens,
  findStringProperties,
  hasOwnKeyProperty,
  valueStartAfterKey,
};
