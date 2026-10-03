// @ts-check
/**
 * @fileoverview Signature help for OtterScript functions and operations: the
 * documented signature, with the parameter the cursor is on highlighted.
 */

const vscode = require("vscode");
const { lookupOperation, scalarFunctionDocs, vectorFunctionDocs, mapFunctionDocs } = require("../language-data");
const { lookupOwn } = require("../helpers");
const { getModuleParameters, resolveModule } = require("../document-index");
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
const OPERATION_SIGNATURE_REGEX = /(?:^|\s)(?:([A-Za-z][\w-]*)::)?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s(){};=]+))?\s*\(([^()]*)$/;

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
  const opDoc = op && lookupOperation(op[2], op[1]);
  return op && opDoc ? { doc: opDoc, args: op[3], isOperation: true } : null;
}

/**
 * A module call the cursor is in: raft (group 1), module (group 2),
 * arguments typed so far (group 3).
 */
const MODULE_SIGNATURE_REGEX = /\bcall\s+(?:([A-Za-z]\w*)::)?([A-Za-z][\w-]*)\s*\(([^()]*)$/i;

/**
 * The module call the cursor is in, with a signature built from the module's
 * declaration (`Greet(name, [greeting], [out result])`), or null -- also for a
 * module in another raft, which can't be seen.
 *
 * @param {vscode.TextDocument} document
 * @param {string} textBeforeCursor
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules
 * @returns {Promise<{ doc: { name: string, signature: string, namespace: null, documentation?: string }, args: string, isOperation: boolean } | null>}
 */
async function findModuleSignatureCall(document, textBeforeCursor, listWorkspaceModules) {
  const match = MODULE_SIGNATURE_REGEX.exec(textBeforeCursor);
  if (!match || match[1]) return null;
  const resolved = await resolveModule(document, match[2], listWorkspaceModules);
  if (!resolved) return null;
  const labels = getModuleParameters(resolved.document, resolved.range).map((p) => {
    const label = `${p.direction === "in" ? "" : `${p.direction} `}${p.name}`;
    return p.optional ? `[${label}]` : label;
  });
  return { doc: { name: match[2], signature: `${match[2]}(${labels.join(", ")})`, namespace: null }, args: match[3], isOperation: false };
}

/**
 * The parameter the cursor is on: the one named by a `Name:` the current
 * argument starts with (named arguments come in any order), else the one at
 * the cursor's position in the list.
 *
 * @param {string} args - The arguments typed so far
 * @param {string[]} parameters - The signature's parameter labels
 * @returns {number}
 */
function activeParameterIndex(args, parameters) {
  const named = /^\s*([A-Za-z][\w-]*)\s*:(?!:)/.exec(args.slice(args.lastIndexOf(",") + 1))?.[1]?.toLowerCase();
  const byName = named === undefined ? -1 : parameters.findIndex((label) =>
    label.replace(/^\[|\]$/g, "").replace(/^(?:in|out|ref)\s+/i, "").split(":")[0].trim().toLowerCase() === named);
  return byName !== -1 ? byName : getActiveParameterIndex(args);
}

/**
 * Registers the signature help provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerSignatureHelp(settings, listWorkspaceModules) {

  // ============================================================
  // SIGNATURE HELP PROVIDER
  // ============================================================
  // Shows parameter hints for:
  //   - Scalar functions: $ToJson(value)
  //   - Vector functions: @Split(text, delimiter)
  //   - Operations: Post-Http(Url: ..., [options...])
  //   - Module calls: call Greet(name: ...)

  const signatureHelpProvider =
    vscode.languages.registerSignatureHelpProvider(
      "otterscript",
      {
        async provideSignatureHelp(document, position) {
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
          // -- The call the cursor is in: a module's (`call Greet(`), else a
          // documented function's or operation's
          const call = await findModuleSignatureCall(document, textBeforeCursor, listWorkspaceModules) ??
            findSignatureCall(textBeforeCursor);
          if (!call?.doc.signature) return null;
          const { doc: fn, args, isOperation } = call;
          const signature = call.doc.signature;
          const parameters = splitSignatureParameters(signature);

          // -- Qualify the displayed signature with its namespace when it belongs
          // to one and the stored signature string doesn't already spell it out.
          // Operations only: "Namespace::Operation" is grammatically valid, whereas
          // the syntax for namespaced $/@ functions is not surfaced here.
          const signatureLabel =
            isOperation && fn.namespace && !signature.includes("::")
              ? `${fn.namespace}::${signature}`
              : signature;

          const sig = new vscode.SignatureInformation(signatureLabel, fn.documentation);
          sig.parameters = parameters.map(p => new vscode.ParameterInformation(p));

          // -- Prepare the response
          const help = new vscode.SignatureHelp();
          help.signatures = [sig];
          help.activeSignature = 0;

          // -- Only set activeParameter when parameters were extracted
          if (sig.parameters.length > 0) {
            help.activeParameter = Math.min(activeParameterIndex(args, parameters), sig.parameters.length - 1);
          }

          return help;
        }
      },
      "(",  // -- Trigger on opening parenthesis
      ","   // -- Trigger on comma (when moving to next parameter)
    );

  return [signatureHelpProvider];
}

module.exports = { FUNCTION_SIGNATURE_REGEX, OPERATION_SIGNATURE_REGEX, activeParameterIndex, findSignatureCall, registerSignatureHelp };
