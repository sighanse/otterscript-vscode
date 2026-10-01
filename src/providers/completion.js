// @ts-check
/**
 * @fileoverview Completion for OtterScript: functions and variables after a
 * `$`, `@` or `%` sigil, and operations and keywords.
 */

const vscode = require("vscode");
const { keywordDocs, mapFunctionDocs, operationDocs, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const { buildCompletionItem, buildSigilCompletionItems, getTypedIdentifier, isValidCompletionPosition } = require("../helpers");

/**
 * Registers the completion providers.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @returns {vscode.Disposable[]}
 */
function registerCompletion(settings) {
  // ============================================================
  // SIGIL COMPLETION PROVIDERS ($, @, %)
  // ============================================================
  // After `$`: scalar functions ($ToJson) and runtime variables ($PackageName).
  // After `@`: vector functions (@Split) and variables (@AffectedPackages).
  // After `%`: map functions (%FromJson) and the %( ... ) map literal; map
  // variables are user-defined and can't be enumerated.
  // buildSigilCompletionItems turns every table into items the same way.

  const scalarCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];
          const typed = getTypedIdentifier(document, position, "$");
          if (typed === null) return [];
          // Functions first; the few runtime variables in scalarFunctionDocs
          // (no '(' in the signature) sort with variableDocs.
          return [
            ...buildSigilCompletionItems(scalarFunctionDocs, typed, { functionSort: "1_", variableSort: "2_" }),
            ...buildSigilCompletionItems(variableDocs, typed, { functionSort: "1_", variableSort: "2_" }),
          ];
        }
      },
      "$"
    );

  const vectorCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];
          const typed = getTypedIdentifier(document, position, "@");
          if (typed === null) return [];
          // Vector variables (@AffectedPackages) sort before the functions.
          return buildSigilCompletionItems(vectorFunctionDocs, typed, { functionSort: "2_", variableSort: "1_" });
        }
      },
      "@"
    );

  const mapCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];
          const typed = getTypedIdentifier(document, position, "%");
          if (typed === null) return [];

          const items = buildSigilCompletionItems(mapFunctionDocs, typed, { functionSort: "1_", variableSort: "2_" });

          // -- The %( ... ) map literal, sorted last
          if (syntaxDocs?.mapExpr) {
            const snippet = syntaxDocs.mapExpr.snippet
              ? new vscode.SnippetString(syntaxDocs.mapExpr.snippet)
              : new vscode.SnippetString(`${syntaxDocs.mapExpr.name} "(\${0})"`);
            items.push(buildCompletionItem(syntaxDocs.mapExpr, vscode.CompletionItemKind.Snippet, "~", snippet, false));
          }
          return items;
        }
      },
      "%"
    );

  // ============================================================
  // OPERATION COMPLETION PROVIDER
  // ============================================================
  // Provides completions for OtterScript operations and keywords.
  //
  // Unlike scalar ($) and vector (@) completions, operations have NO prefix.

  const operationCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position, _token, localContext) {
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];

          const line = document.lineAt(position.line).text;
          const cursor = position.character;
          const prefix = line.slice(0, cursor);

          // -- Match the identifier fragment immediately before the cursor (letters +
          // hyphens), plus an optional "Namespace::" prefix the user may have already
          // typed (e.g. "ProGet::Cr").
          // Manual invoke (Ctrl+Space) should still return suggestions even when typed is empty.
          const match = prefix.match(/(?:([A-Za-z][A-Za-z0-9]*)::)?([A-Za-z][A-Za-z-]*)?$/);
          const namespaceTyped = match?.[1] ?? "";
          const typed = match?.[2] ?? "";
          const isManualInvoke = localContext.triggerKind === vscode.CompletionTriggerKind.Invoke;

          // -- For auto-triggered suggestions, require at least 2 typed characters to
          // avoid noise -- unless a "Namespace::" prefix was typed, which is signal enough.
          if (!isManualInvoke && typed.length < 2 && !namespaceTyped) {
            return [];
          }

          const lowerTyped = typed.toLowerCase();
          const lowerNamespaceTyped = namespaceTyped.toLowerCase();

          // -- Replace only the identifier fragment after any "::". VS Code treats "::"
          // as a word boundary, so extending the range back over the namespace would
          // make VS Code filter the items out. Instead, when the user has already typed
          // a "Namespace::" prefix, strip that exact prefix off the snippet so it does
          // not double up ("ProGet::ProGet::Create-Directory"). Only strip the prefix
          // the user actually typed -- never rewrite a different namespace.
          const replaceRange = new vscode.Range(
            new vscode.Position(position.line, cursor - typed.length),
            position
          );
          const typedNamespacePrefixRegex = namespaceTyped
            ? new RegExp(`^${namespaceTyped}::`, "i")
            : null;
          const stripTypedNamespace = (/** @type {string} */ text) =>
            typedNamespacePrefixRegex ? text.replace(typedNamespacePrefixRegex, "") : text;

          const items = [];

          // -- Operations (priority 0_)
          for (const [name, doc] of Object.entries(operationDocs)) {
              // -- When a "Namespace::" prefix is typed, only offer operations that
              // belong to that namespace -- inserting a core/other-namespace operation
              // after the prefix would produce invalid code ("ProGet::Log-Information").
              // An operation with no namespace (`null`) is a built-in, which the
              // optional `Core::` prefix names.
              if (namespaceTyped && (doc.namespace ?? "Core").toLowerCase() !== lowerNamespaceTyped) {
                  continue;
              }
              if (!typed || name.toLowerCase().startsWith(lowerTyped)) {
                  const snippetText = doc.snippet ?? `${name} "\${0}";`;
                  const snippet = new vscode.SnippetString(stripTypedNamespace(snippetText));
                  const item = buildCompletionItem(doc, vscode.CompletionItemKind.Function, '0_', snippet, true);
                  item.range = replaceRange;
                  items.push(item);
              }
          }

          // -- Keywords (priority 1_). Skipped once a "Namespace::" prefix is typed --
          // only operations are valid there.
          if (!namespaceTyped) {
            for (const [name, doc] of Object.entries(keywordDocs)) {
                if (!typed || name.toLowerCase().startsWith(lowerTyped)) {
                    const snippet = doc.snippet
                      ? new vscode.SnippetString(doc.snippet)
                      : name;
                    const item = buildCompletionItem(doc, vscode.CompletionItemKind.Keyword, '1_', snippet, false);
                    item.range = replaceRange;
                    items.push(item);
                }
            }
          }

          return items;
        }
      }
      // Manual invoke (Ctrl+Space) can return all operations/keywords.
      // Auto-trigger still requires a short typed prefix to reduce noise.
    );

  return [scalarCompletionProvider, vectorCompletionProvider, mapCompletionProvider, operationCompletionProvider];
}

module.exports = { registerCompletion };
