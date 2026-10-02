// @ts-check
/**
 * @fileoverview Signature help for OtterScript functions and operations: the
 * documented signature, with the parameter the cursor is on highlighted.
 */

const vscode = require("vscode");
const { operationDocs, scalarFunctionDocs, vectorFunctionDocs, mapFunctionDocs } = require("../language-data");
const { lookupOwn } = require("../helpers");
const { getActiveParameterIndex, maskClosedGroups, splitSignatureParameters } = require("../scanner");

/**
 * The function call the cursor is in, from the text before the cursor:
 * sigil (group 1), name (group 2), arguments typed so far (group 3). A `%(`
 * map literal has no name, so it never matches.
 */
const FUNCTION_SIGNATURE_REGEX = /([$@%])([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/;

/**
 * The operation call the cursor is in: name (group 1), arguments typed so far
 * (group 2). The optional segment after the name allows one default/positional
 * argument before the `(` -- a quoted string or a single bare token, as in
 * `ProGet::Create-Directory my/folder/path\n(` -- but no whitespace or `=`,
 * so it can't swallow an assignment like `set $x = (`.
 */
const OPERATION_SIGNATURE_REGEX = /(?:^|\s)(?:[A-Za-z][\w-]*::)?([A-Za-z][A-Za-z-]*)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s(){};=]+))?\s*\(([^()]*)$/;

/** The function table for each call sigil. */
const FUNCTION_TABLES = Object.freeze({ "$": scalarFunctionDocs, "@": vectorFunctionDocs, "%": mapFunctionDocs });

/**
 * The documented call the cursor is in, given the (masked) text before it.
 *
 * @param {string} textBeforeCursor
 * @returns {{ doc: import("../language-data").DocEntry, args: string, isOperation: boolean } | null}
 */
function findSignatureCall(textBeforeCursor) {
  const fn = FUNCTION_SIGNATURE_REGEX.exec(textBeforeCursor);
  const fnDoc = fn && lookupOwn(FUNCTION_TABLES[/** @type {"$" | "@" | "%"} */ (fn[1])], fn[2]);
  if (fn && fnDoc) return { doc: fnDoc, args: fn[3], isOperation: false };
  const op = OPERATION_SIGNATURE_REGEX.exec(textBeforeCursor);
  const opDoc = op && lookupOwn(operationDocs, op[1]);
  return op && opDoc ? { doc: opDoc, args: op[2], isOperation: true } : null;
}

/**
 * Registers the signature help provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @returns {vscode.Disposable[]}
 */
function registerSignatureHelp(settings) {

  // ============================================================
  // SIGNATURE HELP PROVIDER
  // ============================================================
  // Shows parameter hints for:
  //   - Scalar functions: $ToJson(value)
  //   - Vector functions: @Split(text, delimiter)
  //   - Operations: Post-Http(Url: ..., [options...])

  const signatureHelpProvider =
    vscode.languages.registerSignatureHelpProvider(
      "otterscript",
      {
        provideSignatureHelp(document, position) {
          // -- Check if the signature help provider is enabled in settings
          if (!settings.signatureHelpEnabled) return null;

          // -- Get the text before the cursor, up to 10 lines back, so a call
          // whose arguments span several lines is still detected. Closed
          // groups and strings are blanked, so an earlier nested call such as
          // `$Substring($Trim($x), ` doesn't hide the call the cursor is in.
          const textBeforeCursor = maskClosedGroups(document.getText(new vscode.Range(
            new vscode.Position(Math.max(0, position.line - 10), 0),
            position
          )));
          // -- The documented call the cursor is in
          const call = findSignatureCall(textBeforeCursor);
          if (!call?.doc.signature) return null;
          const { doc: fn, args, isOperation } = call;
          const signature = call.doc.signature;

          // ------------------------------------------------------------
          // Active parameter detection
          // ------------------------------------------------------------

          const activeParam = getActiveParameterIndex(args);

          // ------------------------------------------------------------
          // Build signature help UI
          // ------------------------------------------------------------

          // -- Qualify the displayed signature with its namespace when it belongs
          // to one and the stored signature string doesn't already spell it out.
          // Operations only: "Namespace::Operation" is grammatically valid, whereas
          // the syntax for namespaced $/@ functions is not surfaced here.
          const signatureLabel =
            isOperation && fn.namespace && !signature.includes("::")
              ? `${fn.namespace}::${signature}`
              : signature;

          const sig = new vscode.SignatureInformation(signatureLabel, fn.documentation);

          sig.parameters = splitSignatureParameters(signature).map(p => new vscode.ParameterInformation(p));

          // -- Prepare the response
          const help = new vscode.SignatureHelp();
          help.signatures = [sig];
          help.activeSignature = 0;

          // -- Only set activeParameter when parameters were extracted
          if (sig.parameters.length > 0) {
            help.activeParameter = Math.min(activeParam, sig.parameters.length - 1);
          }

          return help;
        }
      },
      "(",  // -- Trigger on opening parenthesis
      ","   // -- Trigger on comma (when moving to next parameter)
    );

  return [signatureHelpProvider];
}

module.exports = { FUNCTION_SIGNATURE_REGEX, OPERATION_SIGNATURE_REGEX, findSignatureCall, registerSignatureHelp };
