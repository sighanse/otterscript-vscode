// @ts-check
/**
 * @fileoverview Best-effort, opt-in checks for Adaptive Card JSON embedded in
 * an OtterScript text template (e.g. a Microsoft Teams webhook body).
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

/** Anchor for detecting an Adaptive Card object at all -- see module doc. */
const ROOT_TYPE_REGEX = /"type"\s*:\s*"AdaptiveCard"/;
/** Every `"type": "..."` property inside the located Adaptive Card object. */
const TYPE_PROPERTY_REGEX = /"type"\s*:\s*"([^"]*)"/g;
/** Presence check only -- not validating the version string's own format. */
const VERSION_PROPERTY_REGEX = /"version"\s*:/;

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
 *
 * @param {string} text
 * @param {number} index
 * @returns {number} Matching `{` index, or -1 if none found.
 */
function findEnclosingBraceStart(text, index) {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
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
 * Runs the Adaptive Card checks over one document. Opt-in: does nothing
 * unless the literal (non-`<% %>`) text contains `"type": "AdaptiveCard"`
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

  const rootMatch = ROOT_TYPE_REGEX.exec(literalText);
  if (!rootMatch) return issues;

  const objStart = findEnclosingBraceStart(literalText, rootMatch.index);
  if (objStart === -1) return issues; // malformed JSON -- the unbalanced-symbol check owns this
  const objEnd = findMatchingBrace(literalText, objStart);
  if (objEnd === -1) return issues;

  const span = literalText.slice(objStart, objEnd + 1);

  if (!VERSION_PROPERTY_REGEX.test(span)) {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(objStart), document.positionAt(objStart + 1)),
      'Adaptive Card is missing its required "version" property.',
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = "adaptivecard-missing-version";
    diagnostic.source = "OtterScript";
    issues.push(diagnostic);
  }

  for (const m of span.matchAll(TYPE_PROPERTY_REGEX)) {
    const value = m[1];
    if (ADAPTIVE_CARD_TYPES.has(value)) continue;

    const valueStart = objStart + /** @type {number} */ (m.index) + m[0].lastIndexOf(value);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        document.positionAt(valueStart),
        document.positionAt(valueStart + value.length)
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
