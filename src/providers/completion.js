// @ts-check
/**
 * @fileoverview Completion for OtterScript: functions and variables after a
 * `$`, `@` or `%` sigil (including the file's own variables), operations and
 * keywords, an operation's argument names inside its call, module names after
 * `call`, and values inside an Adaptive Card in a text template.
 */

const vscode = require("vscode");
const { keywordDocs, mapFunctionDocs, operationDocs, operationForms, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const {
  buildCompletionItem,
  buildSigilCompletionItems,
  getTypedIdentifier,
  isAvailableIn,
  isValidCompletionPosition,
} = require("../helpers");
const { findCallArguments, getDocumentVariables, getMaskedTextAfter, getMaskedTextBefore, getModuleDeclarations } = require("../document-index");
const { findOperationArgumentContext } = require("../scanner");
const { findCardCompletions } = require("../adaptivecard");

/**
 * Lower-cased names a table documents, so the file's own variable of the same
 * name isn't offered twice.
 *
 * @param {...Readonly<Record<string, { name: string }>>} tables
 * @returns {Set<string>}
 */
function documentedNames(...tables) {
  return new Set(tables.flatMap((t) => Object.values(t).map((doc) => doc.name.slice(1).toLowerCase())));
}

/**
 * Completion items for the variables of one sigil that the file itself uses
 * (`set $myVar = ...`, `foreach %item in ...`, module parameters, ...),
 * sorted before the built-ins. Leaves out the one being typed (it is an
 * occurrence too) and names the docs tables already offer.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {string} sigil - `$`, `@`, or `%`
 * @param {string} typed - What follows the sigil so far
 * @param {ReadonlySet<string>} documented - From {@link documentedNames}
 * @returns {vscode.CompletionItem[]}
 */
function documentVariableItems(document, position, sigil, typed, documented) {
  const lowerTyped = typed.toLowerCase();
  return getDocumentVariables(document, sigil)
    .filter(({ name, occurrences }) =>
      name.toLowerCase().startsWith(lowerTyped) &&
      !documented.has(name.toLowerCase()) &&
      occurrences.some((o) => !(o.line === position.line && o.character + o.length === position.character)))
    .map(({ name, assigned, line }) => {
      const item = new vscode.CompletionItem({ label: `${sigil}${name}`, description: "this file" }, vscode.CompletionItemKind.Variable);
      // The sigil is already typed; a name with spaces needs its braces.
      item.insertText = name.includes(" ") ? `{${name}}` : name;
      item.sortText = `0_${name}`;
      item.detail = `${assigned ? "Assigned" : "Used"} on line ${line + 1}`;
      return item;
    });
}

/**
 * Registers the completion providers.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerCompletion(settings, listWorkspaceModules) {
  // ============================================================
  // SIGIL COMPLETION PROVIDERS ($, @, %)
  // ============================================================
  // After `$`: scalar functions ($ToJson) and runtime variables ($PackageName).
  // After `@`: vector functions (@Split) and variables (@AffectedPackages).
  // After `%`: map functions (%FromJson) and the %( ... ) map literal.
  // Each also offers the variables of that sigil the file itself uses.
  // One provider for all three; buildSigilCompletionItems turns every table
  // into items the same way.

  /**
   * What each sigil offers: its docs tables, and the sort prefixes for their
   * functions and variables (lower sorts first). After `$` the functions come
   * first (the few runtime variables in scalarFunctionDocs, which have no `(`
   * in their signature, sort with variableDocs); after `@` the variables
   * (@AffectedPackages) do.
   * @type {Readonly<Record<string, { tables: Readonly<Record<string, import("../language-data").DocEntry>>[], sort: { functionSort: string, variableSort: string }, documented: Set<string> }>>}
   */
  const SIGIL_COMPLETIONS = Object.freeze({
    "$": { tables: [scalarFunctionDocs, variableDocs], sort: { functionSort: "1_", variableSort: "2_" }, documented: documentedNames(scalarFunctionDocs, variableDocs) },
    "@": { tables: [vectorFunctionDocs], sort: { functionSort: "2_", variableSort: "1_" }, documented: documentedNames(vectorFunctionDocs) },
    "%": { tables: [mapFunctionDocs], sort: { functionSort: "1_", variableSort: "2_" }, documented: documentedNames(mapFunctionDocs) },
  });

  /** The `%( ... )` map literal, offered after `%` and sorted last. */
  const mapLiteralItem = buildCompletionItem(
    syntaxDocs.mapExpr, vscode.CompletionItemKind.Snippet, "~", new vscode.SnippetString(syntaxDocs.mapExpr.snippet ?? "%(${0})"), false
  );

  const sigilCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];
          const sigil = /([$@%])[a-zA-Z]*$/.exec(document.lineAt(position.line).text.slice(0, position.character))?.[1];
          if (!sigil) return [];
          const typed = getTypedIdentifier(document, position, /** @type {"$" | "@" | "%"} */ (sigil));
          if (typed === null) return [];
          const { tables, sort, documented } = SIGIL_COMPLETIONS[sigil];
          return [
            ...documentVariableItems(document, position, sigil, typed, documented),
            ...tables.flatMap((table) => buildSigilCompletionItems(table, typed, sort, settings.product)),
            ...(sigil === "%" ? [mapLiteralItem] : []),
          ];
        }
      },
      "$", "@", "%"
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
        async provideCompletionItems(document, position, _token, localContext) {
          // -- Check if completion is enabled and not in a string/comment
          if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];

          // -- At an argument name inside an operation call: its arguments.
          const argumentContext = findOperationArgumentContext(getMaskedTextBefore(document, position), getMaskedTextAfter(document, position));
          const called = argumentContext && await findCallArguments(document, argumentContext, listWorkspaceModules);
          if (argumentContext && called) return argumentItems(called, argumentContext, position);
          // `(` and `,` trigger only argument names.
          if (localContext.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) return [];

          const line = document.lineAt(position.line).text;
          const cursor = position.character;
          const prefix = line.slice(0, cursor);

          // -- After `call`, the only thing that fits is a module name.
          const callMatch = /\bcall\s+(?:([A-Za-z]\w*)::)?([A-Za-z][\w-]*)?$/i.exec(prefix);
          if (callMatch) {
            // A raft-qualified call (`call Raft::Name`) names a module we can't see.
            if (callMatch[1]) return [];
            const typedName = callMatch[2] ?? "";
            const range = new vscode.Range(position.line, cursor - typedName.length, position.line, cursor);
            return moduleItems(document, range);
          }

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

          // -- Operations (priority 0_), each same-named operation of another
          // namespace too (`DotNet::Build` beside `DevEnv::Build`).
          for (const name of Object.keys(operationDocs)) {
            if (typed && !name.toLowerCase().startsWith(lowerTyped)) continue;
            operationForms(name).forEach((doc, i) => {
              // -- Not in the product the `otterscript.product` setting names.
              if (!isAvailableIn(doc, settings.product)) return;
              // -- When a "Namespace::" prefix is typed, only offer operations that
              // belong to that namespace -- inserting a core/other-namespace operation
              // after the prefix would produce invalid code ("ProGet::Log-Information").
              // An operation with no namespace (`null`) is a built-in, which the
              // optional `Core::` prefix names.
              if (namespaceTyped && (doc.namespace ?? "Core").toLowerCase() !== lowerNamespaceTyped) return;
              // -- A variant is offered with its namespace, which tells it apart.
              const qualifier = i > 0 && !namespaceTyped ? `${doc.namespace ?? "Core"}::` : "";
              const snippetText = `${qualifier}${doc.snippet ?? `${name} "\${0}";`}`;
              const snippet = new vscode.SnippetString(stripTypedNamespace(snippetText));
              const shown = qualifier ? { ...doc, name: `${qualifier}${doc.name}` } : doc;
              const item = buildCompletionItem(shown, vscode.CompletionItemKind.Function, '0_', snippet, true);
              item.filterText = name;
              item.range = replaceRange;
              items.push(item);
            });
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
      // `(` and `,` open an argument list or the next argument.
      , "(", ","
    );

  /**
   * Argument-name items for an operation or module call: the arguments not
   * given yet, required ones first, each inserted as `Name: `.
   *
   * @param {{ callee: string, params: { name: string, required: boolean, format?: string, description?: string }[] }} called -
   *   From findCallArguments
   * @param {import("../scanner").OperationArgumentContext} context
   * @param {vscode.Position} position
   * @returns {vscode.CompletionItem[]}
   */
  function argumentItems(called, context, position) {
    const used = new Set(context.used.map((name) => name.toLowerCase()));
    const range = new vscode.Range(position.translate(0, -context.typed.length), position);
    return called.params
      .filter((param) => !used.has(param.name.toLowerCase()))
      .map((param, i) => {
        const item = new vscode.CompletionItem({ label: param.name, description: param.format }, vscode.CompletionItemKind.Property);
        item.detail = `${param.required ? "Required" : "Optional"} argument of ${called.callee}`;
        if (param.description) item.documentation = param.description;
        item.insertText = `${param.name}: `;
        item.sortText = `${param.required ? 0 : 1}_${String(i).padStart(3, "0")}`;
        item.range = range;
        return item;
      });
  }

  /**
   * Module-name items for `call`: the file's own modules first, then the ones
   * declared in other workspace files.
   *
   * @param {vscode.TextDocument} document
   * @param {vscode.Range} range - The typed part of the name, to replace
   * @returns {Promise<vscode.CompletionItem[]>}
   */
  async function moduleItems(document, range) {
    /** @type {Map<string, vscode.CompletionItem>} */
    const items = new Map();
    for (const { name } of getModuleDeclarations(document)) {
      const item = new vscode.CompletionItem({ label: name, description: "this file" }, vscode.CompletionItemKind.Module);
      item.sortText = `0_${name}`;
      item.range = range;
      items.set(name.toLowerCase(), item);
    }
    for (const { name, uri } of await listWorkspaceModules()) {
      if (items.has(name.toLowerCase()) || uri.toString() === document.uri.toString()) continue;
      const item = new vscode.CompletionItem({ label: name, description: vscode.workspace.asRelativePath(uri) }, vscode.CompletionItemKind.Module);
      item.sortText = `1_${name}`;
      item.range = range;
      items.set(name.toLowerCase(), item);
    }
    return [...items.values()];
  }

  // ============================================================
  // ADAPTIVE CARD COMPLETION PROVIDER
  // ============================================================
  // Inside a card's string values -- where the providers above never offer
  // anything: `"type"` values, a property's allowed values, and the ids a
  // ToggleVisibility can target (see findCardCompletions). Triggered by the
  // opening quote; VS Code doesn't suggest while typing in a string, so
  // Ctrl+Space brings the list back after that.

  /** @type {Record<string, vscode.CompletionItemKind>} */
  const CARD_ITEM_KINDS = {
    type: vscode.CompletionItemKind.Class,
    value: vscode.CompletionItemKind.EnumMember,
    id: vscode.CompletionItemKind.Reference,
  };

  const cardCompletionProvider =
    vscode.languages.registerCompletionItemProvider(
      "otterscript",
      {
        provideCompletionItems(document, position) {
          if (!settings.completionEnabled) return [];
          const offset = document.offsetAt(position);
          const found = findCardCompletions(document.getText(), offset);
          if (!found) return [];

          // Insert at the cursor, or replace the rest of the value up to its
          // closing quote (when it has one on this line).
          const start = document.positionAt(found.start);
          const rest = document.lineAt(position.line).text.slice(position.character);
          const closing = rest.indexOf('"');
          const end = closing === -1 ? position : position.translate(0, closing);
          const range = { inserting: new vscode.Range(start, position), replacing: new vscode.Range(start, end) };

          return found.items.map(({ label, detail, kind }, i) => {
            const item = new vscode.CompletionItem({ label, description: detail }, CARD_ITEM_KINDS[kind]);
            item.range = range;
            item.sortText = String(i).padStart(4, "0"); // keep the data's order
            return item;
          });
        }
      },
      '"'
    );

  return [sigilCompletionProvider, operationCompletionProvider, cardCompletionProvider];
}

module.exports = { registerCompletion };
