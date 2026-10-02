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
 * Registers the signature help provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {ReturnType<typeof import("../helpers").createRegexPatterns>} patterns
 * @returns {vscode.Disposable[]}
 */
function registerSignatureHelp(settings, patterns) {
  const { scalarSignatureRegex, vectorSignatureRegex, mapSignatureRegex, operationSignatureRegex } = patterns;

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
          // -- Try each pattern to find the call the cursor is inside; the first
          // pattern whose name is documented wins
          let match = null;
          let fn = null;
          let args = null;

          let isOperation = false;

          const candidates = [
            { regex: scalarSignatureRegex,    table: scalarFunctionDocs, operation: false }, // ($Func)
            { regex: vectorSignatureRegex,    table: vectorFunctionDocs, operation: false }, // (@Func)
            { regex: mapSignatureRegex,       table: mapFunctionDocs,    operation: false }, // (%Func)
            { regex: operationSignatureRegex, table: operationDocs,       operation: true  }, // (Log-Information etc...)
          ];

          for (const { regex, table, operation } of candidates) {
            const m = textBeforeCursor.match(regex());
            if (m && lookupOwn(table, m[1])) { match = m; fn = lookupOwn(table, m[1]); args = m[2]; isOperation = operation; break; }
          }

          // -- Validate we have everything needed
          if (!fn?.signature || !match) return null;
          if (typeof args !== 'string') return null;

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
            isOperation && fn.namespace && !fn.signature.includes("::")
              ? `${fn.namespace}::${fn.signature}`
              : fn.signature;

          const sig = new vscode.SignatureInformation(signatureLabel, fn.documentation);

          sig.parameters = splitSignatureParameters(fn.signature).map(p => new vscode.ParameterInformation(p));

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

module.exports = { registerSignatureHelp };
