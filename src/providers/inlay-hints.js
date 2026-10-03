// @ts-check
/**
 * @fileoverview Parameter-name inlay hints for function calls (the
 * `otterscript.inlayHints.parameterNames` setting, on by default):
 * `$Substring($x, Offset: 2, Length: 3)`, where `Offset:` and `Length:` are
 * shown by the editor, not part of the text.
 */

const vscode = require("vscode");
const { FUNCTION_TABLES } = require("../language-data");
const { lookupOwn, productSignatures } = require("../helpers");
const {
  createCodeScanState,
  createTemplateScanState,
  documentUsesTemplateTags,
  maskComments,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
  splitSignatureParameters,
} = require("../scanner");

/** A function call: sigil (group 1), name (group 2), up to its `(`. Not `<%` or a `%(` literal. */
const FUNCTION_CALL_REGEX = /(?<!<)([$@%])([A-Za-z][A-Za-z0-9_]*)\s*\(/g;

/**
 * The code of `text` with comments and -- in a text template -- the literal
 * output blanked, offsets unchanged; strings are blanked too, unless
 * `keepStrings` (quotes included).
 *
 * @param {string} text
 * @param {boolean} [keepStrings]
 * @returns {string}
 */
function maskCode(text, keepStrings = false) {
  const scanState = createCodeScanState();
  const mask = keepStrings ? maskComments : maskNonCodeSpans;
  const lines = text.split("\n");
  if (!documentUsesTemplateTags(text)) return lines.map((line) => mask(line, scanState)).join("\n");
  const templateState = createTemplateScanState();
  return lines.map((line) => mask(maskOutsideTemplateTags(line, templateState), scanState)).join("\n");
}

/**
 * A function form's parameter names before any `...` tail, and how many of
 * them are required (not `[optional]`).
 *
 * @param {string} signature - `$Substring(Text, Offset, [Length])`
 * @returns {{ names: string[], required: number, vararg: boolean }}
 */
function formParameters(signature) {
  const labels = splitSignatureParameters(signature);
  const vararg = labels.findIndex((label) => label.includes("..."));
  const fixed = vararg === -1 ? labels : labels.slice(0, vararg);
  return {
    names: fixed.map((label) => label.replace(/^\[|\]$/g, "").trim()),
    required: fixed.filter((label) => !label.startsWith("[")).length,
    vararg: vararg !== -1,
  };
}

/**
 * The parameter names to hint for a call with `count` arguments: those of
 * the one form that takes that many (BuildMaster's `$PackageProperty` takes
 * two or three, ProGet's one or two), or of the first form when none does.
 * Null when several forms take that many and name the arguments differently
 * -- a guess would label them wrongly -- or the names are fewer than two.
 *
 * @param {string[]} signatures - The call's forms, from `productSignatures`
 * @param {number} count - How many arguments the call has
 * @returns {string[] | null}
 */
function hintedParameterNames(signatures, count) {
  const forms = signatures.map(formParameters);
  const fitting = forms.filter((form) => count >= form.required && (form.vararg || count <= form.names.length));
  const candidates = fitting.length ? fitting : forms.slice(0, 1);
  const names = candidates[0]?.names.slice(0, count) ?? [];
  const agree = candidates.every((form) => names.every((name, i) => form.names[i]?.toLowerCase() === name.toLowerCase()));
  return agree && candidates[0].names.length >= 2 ? names : null;
}

/**
 * Where each parameter-name hint goes: before every positional argument of a
 * documented function call with two or more fixed parameters, except arguments
 * past a `...` tail and an argument that is just a variable of the
 * parameter's name (`$Text` for `Text`). A function with another form in the
 * selected product uses that form's names (see {@link hintedParameterNames}).
 *
 * @param {string} text - The document's text
 * @param {string} [product] - The `otterscript.product` setting
 * @returns {{ offset: number, label: string }[]} `offset` is where the argument starts
 */
function findParameterNameHints(text, product = "any") {
  // A braced variable's `{ }` (`${my var}`) isn't a block's.
  const masked = maskCode(text).replace(/[$@%]\{[^{}\n]*\}/g, (m) => `${m[0]}${"_".repeat(m.length - 1)}`);
  // The arguments as written, comments blanked: where one starts, and what it is.
  const withStrings = maskCode(text, true);
  /** @type {{ offset: number, label: string }[]} */
  const hints = [];
  for (const match of masked.matchAll(FUNCTION_CALL_REGEX)) {
    const [whole, sigil, name] = match;
    const doc = lookupOwn(FUNCTION_TABLES[/** @type {"$" | "@" | "%"} */ (sigil)], name);
    const signatures = doc ? productSignatures(doc, product).filter((s) => s.includes("(")) : [];
    if (!signatures.length) continue;

    // Walk the top-level arguments up to the matching `)`: where each starts
    // (looked up in `withStrings`, as strings are blank in `masked` and a
    // comment before the argument, `$F(\n  # why\n  $x, ...`, isn't its
    // start) and what it is.
    /** @type {{ offset: number, argument: string }[]} */
    const args = [];
    let depth = 0;
    let segmentStart = /** @type {number} */ (match.index) + whole.length;
    for (let i = segmentStart; i < masked.length && depth >= 0; i++) {
      const ch = masked[i];
      // An unclosed call (still being typed) ends at its statement.
      if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (depth >= 0 && !(ch === "," && depth === 0)) continue;
      const segment = withStrings.slice(segmentStart, i);
      const start = segment.search(/\S/);
      args.push({ offset: start === -1 ? -1 : segmentStart + start, argument: segment.trim() });
      segmentStart = i + 1;
    }

    const params = hintedParameterNames(signatures, args.filter((a) => a.offset !== -1).length);
    if (!params) continue;
    args.forEach(({ offset, argument }, index) => {
      const param = params[index];
      // Already self-describing: a variable of the parameter's name
      // (`$Text` or `${Text}` for `Text`).
      const named = param !== undefined && /^[$@%]/.test(argument) &&
        argument.slice(1).replace(/^\{(.*)\}$/, "$1").toLowerCase() === param.toLowerCase();
      if (param && offset !== -1 && !named) hints.push({ offset, label: `${param}:` });
    });
  }
  return hints.sort((a, b) => a.offset - b.offset);
}

/**
 * Registers the inlay hints provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @returns {vscode.Disposable[]}
 */
function registerInlayHints(settings) {
  /**
   * The last document's hints, for that document object and version and
   * the product they were made for: scrolling asks per range. Not by URI: a
   * new untitled document can reuse a closed one's name (`Untitled-1`) and
   * version.
   * @type {{ document: vscode.TextDocument, version: number, product: string, hints: { offset: number, label: string }[] } | null}
   */
  let cache = null;

  // Switching the setting, or the product (whose forms of a function the
  // names come from), re-requests the hints (VS Code asks again later, after
  // extension.js has reloaded the settings).
  const changed = new vscode.EventEmitter();
  const settingListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("otterscript.inlayHints") || e.affectsConfiguration("otterscript.product")) changed.fire(undefined);
  });

  const inlayHintsProvider = vscode.languages.registerInlayHintsProvider("otterscript", {
    onDidChangeInlayHints: changed.event,
    provideInlayHints(document, range) {
      if (!settings.parameterNameHints) return [];
      if (cache?.document !== document || cache.version !== document.version || cache.product !== settings.product) {
        cache = { document, version: document.version, product: settings.product, hints: findParameterNameHints(document.getText(), settings.product) };
      }
      const start = document.offsetAt(range.start);
      const end = document.offsetAt(range.end);
      return cache.hints
        .filter((hint) => hint.offset >= start && hint.offset <= end)
        .map((hint) => {
          const inlay = new vscode.InlayHint(document.positionAt(hint.offset), hint.label, vscode.InlayHintKind.Parameter);
          inlay.paddingRight = true;
          return inlay;
        });
    },
  });
  return [inlayHintsProvider, settingListener, changed];
}

module.exports = { findParameterNameHints, hintedParameterNames, registerInlayHints };
