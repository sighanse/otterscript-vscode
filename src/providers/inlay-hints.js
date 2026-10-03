// @ts-check
/**
 * @fileoverview Parameter-name inlay hints for function calls (the
 * `otterscript.inlayHints.parameterNames` setting, on by default):
 * `$Substring($x, Offset: 2, Length: 3)`, where `Offset:` and `Length:` are
 * shown by the editor, not part of the text.
 */

const vscode = require("vscode");
const { mapFunctionDocs, scalarFunctionDocs, vectorFunctionDocs } = require("../language-data");
const { lookupOwn } = require("../helpers");
const {
  createCodeScanState,
  createTemplateScanState,
  documentUsesTemplateTags,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
  splitSignatureParameters,
} = require("../scanner");

/** The function table for each call sigil. */
const FUNCTION_TABLES = Object.freeze({ "$": scalarFunctionDocs, "@": vectorFunctionDocs, "%": mapFunctionDocs });

/** A function call: sigil (group 1), name (group 2), up to its `(`. Not `<%` or a `%(` literal. */
const FUNCTION_CALL_REGEX = /(?<!<)([$@%])([A-Za-z][A-Za-z0-9_]*)\s*\(/g;

/**
 * The code of `text` with strings, comments and -- in a text template -- the
 * literal output blanked, offsets unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
function maskCode(text) {
  const scanState = createCodeScanState();
  const lines = text.split("\n");
  if (!documentUsesTemplateTags(text)) return lines.map((line) => maskNonCodeSpans(line, scanState)).join("\n");
  const templateState = createTemplateScanState();
  return lines.map((line) => maskNonCodeSpans(maskOutsideTemplateTags(line, templateState), scanState)).join("\n");
}

/**
 * Where each parameter-name hint goes: before every positional argument of a
 * documented function call with two or more fixed parameters, except arguments
 * past a `...` tail and an argument that is just a variable of the
 * parameter's name (`$Text` for `Text`).
 *
 * @param {string} text - The document's text
 * @returns {{ offset: number, label: string }[]} `offset` is where the argument starts
 */
function findParameterNameHints(text) {
  // A braced variable's `{ }` (`${my var}`) isn't a block's.
  const masked = maskCode(text).replace(/[$@%]\{[^{}\n]*\}/g, (m) => `${m[0]}${"_".repeat(m.length - 1)}`);
  /** @type {{ offset: number, label: string }[]} */
  const hints = [];
  for (const match of masked.matchAll(FUNCTION_CALL_REGEX)) {
    const [whole, sigil, name] = match;
    const signature = lookupOwn(FUNCTION_TABLES[/** @type {"$" | "@" | "%"} */ (sigil)], name)?.signature;
    if (!signature?.includes("(")) continue;
    const names = splitSignatureParameters(signature).map((p) => p.replace(/^\[|\]$/g, "").trim());
    const vararg = names.indexOf("...");
    const params = vararg === -1 ? names : names.slice(0, vararg);
    if (params.length < 2) continue;

    // Walk the top-level arguments up to the matching `)`.
    let depth = 0;
    let index = 0;
    let segmentStart = /** @type {number} */ (match.index) + whole.length;
    for (let i = segmentStart; i < masked.length && depth >= 0; i++) {
      const ch = masked[i];
      // An unclosed call (still being typed) ends at its statement.
      if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (depth >= 0 && !(ch === "," && depth === 0)) continue;
      // An argument ends: hint at its first character (strings are blank in
      // `masked`, so look in the text).
      const segment = text.slice(segmentStart, i);
      const start = segment.search(/\S/);
      const param = params[index];
      // Already self-describing: a variable of the parameter's name.
      const named = new RegExp(`^[$@%]\\{?${param}\\}?$`, "i").test(segment.trim());
      if (param && start !== -1 && !named) {
        hints.push({ offset: segmentStart + start, label: `${param}:` });
      }
      index++;
      segmentStart = i + 1;
    }
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
   * The last document's hints, for that document object and version:
   * scrolling asks per range. Not by URI: a new untitled document can reuse
   * a closed one's name (`Untitled-1`) and version.
   * @type {{ document: vscode.TextDocument, version: number, hints: { offset: number, label: string }[] } | null}
   */
  let cache = null;

  // Switching the setting re-requests the hints (VS Code asks again later,
  // after extension.js has reloaded the settings).
  const changed = new vscode.EventEmitter();
  const settingListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("otterscript.inlayHints")) changed.fire(undefined);
  });

  const inlayHintsProvider = vscode.languages.registerInlayHintsProvider("otterscript", {
    onDidChangeInlayHints: changed.event,
    provideInlayHints(document, range) {
      if (!settings.parameterNameHints) return [];
      if (cache?.document !== document || cache.version !== document.version) {
        cache = { document, version: document.version, hints: findParameterNameHints(document.getText()) };
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

module.exports = { findParameterNameHints, registerInlayHints };
