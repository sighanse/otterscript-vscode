// @ts-check
/**
 * @fileoverview Completion for OtterScript: functions and variables after a
 * `$`, `@` or `%` sigil (including the file's own variables), operations and
 * keywords, an operation's argument names inside its call, module names after
 * `call`, and values inside an Adaptive Card in a text template.
 *
 * Each provider's work is an exported function ({@link provideSigilItems},
 * {@link provideOperationItems}, {@link provideCardItems}), built from small
 * helpers, so it can be tested without VS Code.
 */

const vscode = require("vscode");
const { keywordDocs, mapFunctionDocs, operationDocs, operationForms, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const {
  buildCompletionItem,
  buildSigilCompletionItems,
  getTypedIdentifier,
  isAvailableIn,
  isValidCompletionPosition,
  resolveCompletionDocumentation,
} = require("../helpers");
const { findCallArguments, getDocumentVariables, getMaskedTextAfter, getMaskedTextBefore, getModuleDeclarations } = require("../document-index");
const { findOperationArgumentContext } = require("../scanner");
const { findCardCompletions } = require("../adaptivecard");

/**
 * The settings completion reads: whether it's on, and the
 * `otterscript.product` setting.
 *
 * @typedef {Pick<import("../helpers").Settings, "completionEnabled" | "product">} CompletionSettings
 */

// ============================================================
// AFTER A SIGIL ($, @, %)
// ============================================================
// After `$`: scalar functions ($ToJson) and runtime variables ($PackageName).
// After `@`: vector functions (@Split) and variables (@AffectedPackages).
// After `%`: map functions (%FromJson) and the %( ... ) map literal.
// Each also offers the variables of that sigil the file itself uses.

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
const MAP_LITERAL_ITEM = buildCompletionItem(
  syntaxDocs.mapExpr, vscode.CompletionItemKind.Snippet, "~", new vscode.SnippetString(syntaxDocs.mapExpr.snippet ?? "%(${0})"), false
);

/**
 * The sigil of the name being typed at the end of `prefix` (the line up to
 * the cursor), or undefined when none is.
 *
 * @param {string} prefix
 * @returns {"$" | "@" | "%" | undefined}
 */
function sigilAt(prefix) {
  return /** @type {"$" | "@" | "%" | undefined} */ (/([$@%])(?:[A-Za-z][\w-]*)?$/.exec(prefix)?.[1]);
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
 * Completion after a sigil: the file's own variables of that sigil, then its
 * documented functions and variables, then (after `%`) the map literal.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {CompletionSettings} settings
 * @returns {vscode.CompletionItem[]}
 */
function provideSigilItems(document, position, settings) {
  if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];
  const sigil = sigilAt(document.lineAt(position.line).text.slice(0, position.character));
  if (!sigil) return [];
  const typed = getTypedIdentifier(document, position, sigil);
  if (typed === null) return [];
  const { tables, sort, documented } = SIGIL_COMPLETIONS[sigil];
  return [
    ...documentVariableItems(document, position, sigil, typed, documented),
    ...tables.flatMap((table) => buildSigilCompletionItems(table, typed, sort, settings.product)),
    ...(sigil === "%" ? [MAP_LITERAL_ITEM] : []),
  ];
}

// ============================================================
// OPERATIONS, KEYWORDS, ARGUMENTS AND MODULES
// ============================================================
// Operations and keywords where a statement starts, argument names inside an
// operation or module call, and module names after `call`.
//
// Unlike the sigil completions above, operations have NO prefix character.
// Manual invoke (Ctrl+Space) can return every operation and keyword;
// auto-trigger needs two typed characters to reduce noise. `(` and `,`
// trigger only argument names (the opening of an argument list, or the
// next argument).

/**
 * The module name being typed after `call` at the end of `prefix`: the typed
 * part, and whether a raft (`call Raft::Name`) qualifies it. Null when the
 * prefix doesn't end in a `call`.
 *
 * @param {string} prefix - The line up to the cursor
 * @returns {{ raft: boolean, typedName: string } | null}
 */
function callPrefix(prefix) {
  const match = /\bcall\s+(?:([A-Za-z]\w*)::)?([A-Za-z][\w-]*)?$/i.exec(prefix);
  return match ? { raft: Boolean(match[1]), typedName: match[2] ?? "" } : null;
}

/**
 * The operation name being typed at the end of `prefix`: the identifier
 * fragment before the cursor (letters, digits and dashes), and a
 * `Namespace::` typed before it (`ProGet::Cr`).
 *
 * @param {string} prefix - The line up to the cursor
 * @returns {{ namespaceTyped: string, typed: string }}
 */
function parseOperationPrefix(prefix) {
  const match = prefix.match(/(?:([A-Za-z][A-Za-z0-9]*)::)?([A-Za-z][A-Za-z0-9-]*)?$/);
  return { namespaceTyped: match?.[1] ?? "", typed: match?.[2] ?? "" };
}

/**
 * Operation items (sorted first) for what's typed: each same-named operation
 * of another namespace too (`DotNet::Build` beside `DevEnv::Build`), the
 * ones the product has.
 *
 * @param {string} typed - The name typed so far
 * @param {string} namespaceTyped - A `Namespace::` typed before it, or ""
 * @param {string} product - The `otterscript.product` setting
 * @param {vscode.Range} range - The typed name, to replace
 * @returns {vscode.CompletionItem[]}
 */
function operationItems(typed, namespaceTyped, product, range) {
  const lowerTyped = typed.toLowerCase();
  const lowerNamespaceTyped = namespaceTyped.toLowerCase();
  // Replace only the name after any "::". VS Code treats "::" as a word
  // boundary, so extending the range back over the namespace would make VS
  // Code filter the items out. Instead, when a "Namespace::" is typed, that
  // exact prefix comes off the snippet so it doesn't double up
  // ("ProGet::ProGet::Create-Directory"). Only the typed prefix -- a
  // different namespace is never rewritten.
  const typedNamespacePrefixRegex = namespaceTyped ? new RegExp(`^${namespaceTyped}::`, "i") : null;
  /**
   * @param {string} text
   * @returns {string} `text` without the typed `Namespace::` in front
   */
  const stripTypedNamespace = (text) => (typedNamespacePrefixRegex ? text.replace(typedNamespacePrefixRegex, "") : text);

  /** @type {vscode.CompletionItem[]} */
  const items = [];
  for (const name of Object.keys(operationDocs)) {
    if (typed && !name.toLowerCase().startsWith(lowerTyped)) continue;
    operationForms(name).forEach((doc, i) => {
      // Not in the product the `otterscript.product` setting names.
      if (!isAvailableIn(doc, product)) return;
      // Behind a typed "Namespace::", only that namespace's operations: a
      // core or other-namespace one there is invalid ("ProGet::Log-Information").
      // An operation with no namespace (`null`) is a built-in, which the
      // optional `Core::` prefix names.
      if (namespaceTyped && (doc.namespace ?? "Core").toLowerCase() !== lowerNamespaceTyped) return;
      // A variant is offered with its namespace, which tells it apart.
      const qualifier = i > 0 && !namespaceTyped ? `${doc.namespace ?? "Core"}::` : "";
      const snippetText = `${qualifier}${doc.snippet ?? `${name} "\${0}";`}`;
      const snippet = new vscode.SnippetString(stripTypedNamespace(snippetText));
      const shown = qualifier ? { ...doc, name: `${qualifier}${doc.name}` } : doc;
      const item = buildCompletionItem(shown, vscode.CompletionItemKind.Function, "0_", snippet, true);
      item.filterText = name;
      item.range = range;
      items.push(item);
    });
  }
  return items;
}

/**
 * Keyword items (sorted after operations) for what's typed.
 *
 * @param {string} typed - The word typed so far
 * @param {vscode.Range} range - The typed word, to replace
 * @returns {vscode.CompletionItem[]}
 */
function keywordItems(typed, range) {
  const lowerTyped = typed.toLowerCase();
  /** @type {vscode.CompletionItem[]} */
  const items = [];
  for (const [name, doc] of Object.entries(keywordDocs)) {
    if (typed && !name.toLowerCase().startsWith(lowerTyped)) continue;
    const snippet = doc.snippet ? new vscode.SnippetString(doc.snippet) : name;
    const item = buildCompletionItem(doc, vscode.CompletionItemKind.Keyword, "1_", snippet, false);
    item.range = range;
    items.push(item);
  }
  return items;
}

/**
 * Argument-name items for an operation or module call: the arguments not
 * given yet, required ones first, each inserted as `Name: ` (an output as
 * `Name => `).
 *
 * @param {{ callee: string, params: { name: string, required: boolean, format?: string, description?: string, output?: true }[] }} called -
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
      item.detail = `${param.output ? "Output" : param.required ? "Required" : "Optional"} argument of ${called.callee}`;
      if (param.description) item.documentation = param.description;
      // An output goes into a variable: `ResponseBody => $body`.
      item.insertText = param.output ? `${param.name} => ` : `${param.name}: `;
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
 * @param {import("../document-index").ListWorkspaceModules} listWorkspaceModules
 * @returns {Promise<vscode.CompletionItem[]>}
 */
async function moduleItems(document, range, listWorkspaceModules) {
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

/**
 * Completion without a sigil: argument names inside a call, module names
 * after `call`, else operations and keywords.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {vscode.CompletionTriggerKind} triggerKind - How completion was asked for
 * @param {CompletionSettings} settings
 * @param {import("../document-index").ListWorkspaceModules} listWorkspaceModules
 * @returns {Promise<vscode.CompletionItem[]>}
 */
async function provideOperationItems(document, position, triggerKind, settings, listWorkspaceModules) {
  if (!isValidCompletionPosition(document, position, settings.completionEnabled)) return [];

  // At an argument name inside an operation or module call: its arguments --
  // or nothing when the call can't be resolved (an unknown operation, `call
  // Missing(`): operations and keywords don't belong in an argument list.
  const argumentContext = findOperationArgumentContext(getMaskedTextBefore(document, position), getMaskedTextAfter(document, position));
  if (argumentContext) {
    const called = await findCallArguments(document, argumentContext, listWorkspaceModules);
    return called ? argumentItems(called, argumentContext, position) : [];
  }
  // `(` and `,` trigger only argument names.
  if (triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) return [];

  const cursor = position.character;
  const prefix = document.lineAt(position.line).text.slice(0, cursor);

  // After `call`, the only thing that fits is a module name -- one we can
  // see, so not behind a raft (`call Raft::Name`).
  const call = callPrefix(prefix);
  if (call) {
    if (call.raft) return [];
    return moduleItems(document, new vscode.Range(position.line, cursor - call.typedName.length, position.line, cursor), listWorkspaceModules);
  }

  const { namespaceTyped, typed } = parseOperationPrefix(prefix);
  // Typed automatically, at least 2 characters, to keep the noise down --
  // unless a "Namespace::" was typed, which is signal enough. Ctrl+Space
  // offers everything, even with nothing typed.
  if (triggerKind !== vscode.CompletionTriggerKind.Invoke && typed.length < 2 && !namespaceTyped) return [];

  const range = new vscode.Range(new vscode.Position(position.line, cursor - typed.length), position);
  return [
    ...operationItems(typed, namespaceTyped, settings.product, range),
    // Behind a "Namespace::", only operations are valid.
    ...(namespaceTyped ? [] : keywordItems(typed, range)),
  ];
}

// ============================================================
// INSIDE AN ADAPTIVE CARD
// ============================================================
// Inside a card's string values -- where the completions above never offer
// anything: `"type"` values, a property's allowed values, and the ids a
// ToggleVisibility can target (see findCardCompletions). Triggered by the
// opening quote; VS Code doesn't suggest while typing in a string, so
// Ctrl+Space brings the list back after that.

/**
 * The item kind for each kind of card value.
 * @type {Readonly<Record<string, vscode.CompletionItemKind>>}
 */
const CARD_ITEM_KINDS = Object.freeze({
  type: vscode.CompletionItemKind.Class,
  value: vscode.CompletionItemKind.EnumMember,
  id: vscode.CompletionItemKind.Reference,
});

/**
 * Completion inside an Adaptive Card's string value, in the card's order.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {CompletionSettings} settings
 * @returns {vscode.CompletionItem[]}
 */
function provideCardItems(document, position, settings) {
  if (!settings.completionEnabled) return [];
  const found = findCardCompletions(document.getText(), document.offsetAt(position));
  if (!found) return [];

  // Insert at the cursor, or replace the rest of the value up to its closing
  // quote (when it has one on this line).
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

/**
 * Registers the completion providers.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {import("../document-index").ListWorkspaceModules} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerCompletion(settings, listWorkspaceModules) {
  return [
    vscode.languages.registerCompletionItemProvider("otterscript", {
      provideCompletionItems: (document, position) => provideSigilItems(document, position, settings),
      resolveCompletionItem: resolveCompletionDocumentation,
    }, "$", "@", "%"),
    vscode.languages.registerCompletionItemProvider("otterscript", {
      provideCompletionItems: (document, position, _token, context) =>
        provideOperationItems(document, position, context.triggerKind, settings, listWorkspaceModules),
      resolveCompletionItem: resolveCompletionDocumentation,
    }, "(", ","),
    vscode.languages.registerCompletionItemProvider("otterscript", {
      provideCompletionItems: (document, position) => provideCardItems(document, position, settings),
    }, '"'),
  ];
}

module.exports = {
  argumentItems,
  callPrefix,
  documentVariableItems,
  keywordItems,
  moduleItems,
  operationItems,
  parseOperationPrefix,
  provideCardItems,
  provideOperationItems,
  provideSigilItems,
  registerCompletion,
  sigilAt,
};
