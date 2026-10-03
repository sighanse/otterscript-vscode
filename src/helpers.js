// @ts-check
/**
 * @fileoverview Shared helpers for the OtterScript extension: settings, the
 * logger, per-document timers and bounded concurrency, docs-table lookup and
 * product filtering, the hover and completion item builders, and typo
 * suggestions ({@link closestMatch}).
 *
 * Elsewhere: text scanning in {@link module:scanner}, per-document indexes
 * (modules, variables, string/comment state) in {@link module:document-index},
 * diagnostic checks in diagnostics.js, quick fixes in providers/code-actions.js
 * and folding in providers/navigation.js.
 *
 * @module helpers
 */

const vscode = require("vscode");

const { isInStringOrCommentDoc } = require("./document-index");

// ============================================================
// CONFIGURATION
// ============================================================

/**
 * The extension's settings, as {@link loadConfig} returns them. activate()
 * keeps one such object and updates it in place, so the provider modules it
 * is handed to always see current values.
 * @typedef {ReturnType<typeof loadConfig>} Settings
 */

/**
 * Loads OtterScript configuration from VS Code workspace settings.
 *
 * Settings are stored in .vscode/settings.json or user preferences.
 * Schema defined in package.json under "contributes.configuration".
 *
 * @returns {{
 *   completionEnabled: boolean,
 *   hoverEnabled: boolean,
 *   signatureHelpEnabled: boolean,
 *   codeLensEnabled: boolean,
 *   workspaceSymbolsEnabled: boolean,
 *   parameterNameHints: boolean,
 *   diagnosticRules: Readonly<Record<string, string>>,
 *   adaptiveCardMaxVersion: string,
 *   product: string
 * }}
 *
 * @example
 * // .vscode/settings.json
 * // {
 * //   "otterscript.completion.enable": false,
 * //   "otterscript.hover.enable": true,
 * //   "otterscript.diagnostics.rules": { "unknown-operation": "off" }
 * // }
 */
function loadConfig() {
  const config = vscode.workspace.getConfiguration("otterscript");

  return {
    completionEnabled: config.get("completion.enable", true),
    hoverEnabled: config.get("hover.enable", true),
    signatureHelpEnabled: config.get("signatureHelp.enable", true),
    codeLensEnabled: config.get("codeLens.enable", true),
    workspaceSymbolsEnabled: config.get("workspaceSymbols.enable", true),
    parameterNameHints: config.get("inlayHints.parameterNames", true),
    diagnosticRules: config.get("diagnostics.rules", {}),
    adaptiveCardMaxVersion: config.get("adaptiveCards.maxVersion", "1.6"),
    product: config.get("product", "any")
  };
}

// ============================================================
// CONSTANTS
// ============================================================

/**
 * URI schemes of read-only views of a document's other versions -- the old
 * side of a Git diff (`git`, `gitlens`) or a pull-request review (`pr`,
 * `review`). Diagnostics are not reported for them: they would duplicate or
 * contradict the problems of the real file in the Problems panel.
 * @readonly
 * @type {ReadonlySet<string>}
 */
const READ_ONLY_VIEW_SCHEMES = new Set(["git", "gitlens", "pr", "review"]);

/**
 * Whether a document is a read-only view of another version of a file (see
 * {@link READ_ONLY_VIEW_SCHEMES}) rather than a file the user edits.
 *
 * @param {vscode.TextDocument} document
 * @returns {boolean}
 */
function isReadOnlyView(document) {
  return READ_ONLY_VIEW_SCHEMES.has(document.uri.scheme);
}

/**
 * Set of identifier names that are valid without a '$' prefix in conditions.
 * These are language literals, not user-defined variables.
 *
 * Used by diagnostics to avoid false "missing $" errors on literals.
 * @readonly
 * @type {ReadonlySet<string>}
 */
const NON_VARIABLE_IDENTIFIERS = new Set([
  "true",   // Boolean literal
  "false",  // Boolean literal
  "null"    // Null literal
]);

// ============================================================
// LOGGER
// ============================================================

/** @type {import('vscode').LogOutputChannel | null} */
let outputChannel = null;

/**
 * Gets or creates the OtterScript log output channel, which appears under
 * View → Output → OtterScript. A log channel: VS Code timestamps each line,
 * tags its level, and shows only the levels the user picks (the gear in the
 * Output view, or "Developer: Set Log Level...").
 *
 * @returns {import('vscode').LogOutputChannel}
 */
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("OtterScript", { log: true });
  }
  return outputChannel;
}

/**
 * The message and the rest of a log call's arguments, as a LogOutputChannel
 * method takes them (it formats the rest, an Error with its stack).
 *
 * @param {unknown[]} args
 * @returns {[string, ...unknown[]]}
 */
function logArguments(args) {
  const [first, ...rest] = args;
  return [String(first), ...rest];
}

/**
 * Centralized logger for OtterScript Language extension: writes to the
 * OtterScript log output channel ({@link getOutputChannel}). `debug` lines
 * show only when the user sets the channel's level to Debug or Trace.
 *
 * @example
 * log.info('Extension activated');
 * log.warn('Missing documentation field');
 * log.error('Failed to load docs', err);
 * log.debug('Processing line', lineIndex);
 */
const log = {
  /** @param {...unknown} args - e.g. `log.info('Extension activated')` */
  info: (...args) => { getOutputChannel().info(...logArguments(args)); },

  /** @param {...unknown} args - e.g. `log.warn('Missing field')` */
  warn: (...args) => { getOutputChannel().warn(...logArguments(args)); },

  /** @param {...unknown} args - e.g. `log.error('Failed', err)` */
  error: (...args) => { getOutputChannel().error(...logArguments(args)); },

  /** @param {...unknown} args - e.g. `log.debug('Processing', lineIndex)` */
  debug: (...args) => { getOutputChannel().debug(...logArguments(args)); },
};

// ============================================================
// TIMERS & CONCURRENCY
// ============================================================

/**
 * Clears a scheduled timer for the given URI key.
 *
 * @param {Map<string, ReturnType<typeof setTimeout>>} timerMap
 * @param {import('vscode').Uri} uri
 * @returns {void}
 */
function clearTimerForUri(timerMap, uri) {
  const key = uri.toString();
  const timer = timerMap.get(key);
  if (!timer) return;

  clearTimeout(timer);
  timerMap.delete(key);
}

/**
 * Schedules a timer for the given URI key, replacing any existing one.
 *
 * @param {Map<string, ReturnType<typeof setTimeout>>} timerMap
 * @param {import('vscode').Uri} uri
 * @param {number} delayMs
 * @param {() => void} onFire
 * @returns {void}
 */
function scheduleTimerForUri(timerMap, uri, delayMs, onFire) {
  clearTimerForUri(timerMap, uri);

  const key = uri.toString();
  const timer = setTimeout(() => {
    timerMap.delete(key);
    onFire();
  }, delayMs);

  timerMap.set(key, timer);
}

/**
 * Awaits `worker(item)` for every item, keeping at most `limit` in flight.
 *
 * Used to bound concurrent `workspace.fs.readFile` calls when scanning a large
 * workspace, so it can't fire thousands of reads at once. Items are consumed in
 * order; completion order is not guaranteed. A rejecting worker rejects the
 * whole call (callers that must not abort should catch inside the worker).
 *
 * @template T
 * @param {readonly T[]} items
 * @param {number} limit - Max concurrent workers; values < 1 are treated as 1.
 * @param {(item: T) => Promise<unknown>} worker
 * @returns {Promise<void>}
 */
async function mapWithConcurrency(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      await worker(items[next++]);
    }
  };
  const size = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: size }, run));
}

// ============================================================
// COMPLETION HELPERS
// ============================================================

/**
 * Checks if the cursor is in a valid position for showing completions.
 * @param {vscode.TextDocument} document - The current text document
 * @param {vscode.Position} position - The current cursor position
 * @param {boolean} completionEnabled - Whether completion is enabled in settings
 * @returns {boolean}
 */
function isValidCompletionPosition(document, position, completionEnabled) {
  if (!completionEnabled) return false;
  return !isInStringOrCommentDoc(document, position);
}

/** @type {Readonly<Record<"$" | "@" | "%", RegExp>>} */
const TYPED_IDENTIFIER_PATTERNS = Object.freeze({
  "$": /\$((?:[A-Za-z][\w-]*)?)$/,
  "@": /@((?:[A-Za-z][\w-]*)?)$/,
  "%": /%((?:[A-Za-z][\w-]*)?)$/,
});

/**
 * Extracts the currently typed identifier after a trigger character.
 *
 * Examples:
 * - "$To" -> "To"
 * - "@Spl" -> "Spl"
 * - "%From" -> "From"
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {"$" | "@" | "%"} triggerChar
 * @returns {string | null}
 */
function getTypedIdentifier(document, position, triggerChar) {
  const linePrefix = document.lineAt(position.line).text.substring(0, position.character);
  const pattern = TYPED_IDENTIFIER_PATTERNS[triggerChar];
  const match = linePrefix.match(pattern);
  return match ? match[1] : null;
}

// ============================================================
// HOVER & COMPLETION BUILDERS
// ============================================================

/**
 * One named argument of an operation (a DocEntry's `params`).
 *
 * @typedef {{ name: string, required: boolean, description?: string, format?: string, output?: true }} OperationParam
 */

/**
 * Builds a standardized hover MarkdownString from a documentation entry.
 *
 * This creates the formatted tooltip content shown when hovering over
 * symbols, keywords, operations, and syntax elements.
 *
 * @param {Readonly<{ name: string, signature?: string, overloads?: { product: string, signature: string }[], description?: string, documentation?: string, namespace?: string | null, products?: ReadonlyArray<string>, anySigil?: boolean, superseded?: { by: string, note: string }, params?: ReadonlyArray<OperationParam> }>} doc
 *   - name: Required - Display name (e.g., "$ToJson")
 *   - signature: Optional - Function signature (monospace formatted)
 *   - overloads: Optional - The function's form in other Inedo products, each
 *     shown as "**In <product>:** `signature`"
 *   - description: Optional - Short description
 *   - documentation: Optional - Extended Markdown documentation
 *   - namespace: Optional - Owning OtterScript namespace (shown as provenance)
 *   - products: Optional - The products that have it; a note says so when
 *     `product` isn't one of them (see {@link isAvailableIn})
 *   - anySigil: Optional - Works with every sigil (noted below the signature)
 *   - superseded: Optional - A name Inedo recommends against writing; its
 *     `note` is shown right under the name
 *   - params: Optional - An operation's arguments, listed unless
 *     `documentation` has its own **Arguments:** section
 * @param {string} [product] - The `otterscript.product` setting
 * @returns {vscode.MarkdownString} - Formatted hover content
 *
 * @example
 * const doc = { name: "$ToJson", signature: "$ToJson(data)", description: "Converts to JSON" };
 * const hover = buildHoverMarkdown(doc);
 * // Returns MarkdownString with:
 * // ### $ToJson
 * // **Signature:** `$ToJson(data)`
 * // Converts to JSON
 */
function buildHoverMarkdown(doc, product = "any") {
  const md = new vscode.MarkdownString();

  // Heading (### is h3 in Markdown, renders bold in VS Code)
  md.appendMarkdown(`### ${doc.name}\n\n`);

  // Not in the product the user writes for -- right under the name, where it's seen.
  if (doc.products && !isAvailableIn(doc, product)) {
    md.appendMarkdown(`⚠️ **Not in ${product}:** only in ${doc.products.join(" and ")} (setting \`otterscript.product\`).\n\n`);
  }

  // A name Inedo recommends against writing, and what to write instead
  if (doc.superseded) {
    md.appendMarkdown(`⚠️ ${doc.superseded.note}\n\n`);
  }

  // Signature (monospace for code clarity)
  if (doc.signature) {
    md.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
  }
  // The same function's form in other Inedo products, when it differs
  for (const overload of doc.overloads ?? []) {
    md.appendMarkdown(`**In ${overload.product}:** \`${overload.signature}\`\n\n`);
  }
  if (doc.anySigil) {
    md.appendMarkdown("Works with `$`, `@` and `%`: the sigil picks what it returns.\n\n");
  }

  // Namespace provenance -- the `[ScriptNamespace]` this construct belongs to.
  // Omitted when it is null: keywords, syntax and every `Core::` built-in.
  if (doc.namespace) {
    md.appendMarkdown(`**Namespace:** \`${doc.namespace}\`\n\n`);
  }

  // Short description
  if (doc.description) {
    md.appendMarkdown(`${doc.description}\n\n`);
  }

  // An operation's arguments, unless its documentation lists them itself
  const documentation = typeof doc.documentation === "string" ? doc.documentation : "";
  if (doc.params?.length && !documentation.includes("**Arguments:**")) {
    md.appendMarkdown(`**Arguments:**\n${doc.params.map((p) => `- ${argumentSummary(p)}`).join("\n")}\n\n`);
  }

  // Extended documentation (supports Markdown)
  if (documentation) {
    md.appendMarkdown(documentation);
  }

  return md;
}

/**
 * One operation argument on a line: `` `To` (required, text) - Target directory ``.
 *
 * @param {OperationParam} param
 * @returns {string}
 */
function argumentSummary(param) {
  const flags = [param.output ? "output" : param.required ? "required" : "optional", param.format].filter(Boolean).join(", ");
  return `\`${param.name}\` (${flags})${param.description ? ` - ${param.description}` : ""}`;
}

/**
 * Hover for an argument name inside an operation or module call (`To:` in
 * `Copy-Files(To: ...)`): the argument, and what it belongs to.
 *
 * @param {string} callee - `Copy-Files`, `module Greet`
 * @param {OperationParam} param
 * @returns {vscode.MarkdownString}
 */
function buildArgumentHoverMarkdown(callee, param) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`### ${param.name}\n\n`);
  md.appendMarkdown(`Argument of \`${callee}\`: ${argumentSummary(param)}\n`);
  return md;
}

/**
 * Whether a docs entry exists in `product` (the `otterscript.product`
 * setting). Entries without a product list, and every entry for `"any"`, are
 * available. ProGet has no generated reference, so an entry that Otter and
 * BuildMaster both have is taken to be part of the core execution engine,
 * which ProGet runs too; one that only Otter or only BuildMaster has (Otter's
 * `Ensure-Server`, BuildMaster's release functions) is not in ProGet.
 *
 * @param {{ products?: readonly string[] }} doc
 * @param {string} product - "any", "ProGet", "Otter" or "BuildMaster"
 * @returns {boolean}
 */
function isAvailableIn(doc, product) {
  if (product === "any" || !doc.products) return true;
  if (doc.products.includes(product)) return true;
  return product === "ProGet" && doc.products.includes("Otter") && doc.products.includes("BuildMaster");
}

/**
 * The signatures of a docs entry that apply to `product` (the
 * `otterscript.product` setting): the product's own form when the entry has
 * one among its `overloads` (BuildMaster's `$PackageProperty(packageName,
 * packageProperty, [sourceName])`), else the main signature; every form for
 * `"any"`, the main one first.
 *
 * @param {{ signature?: string, overloads?: ReadonlyArray<{ product: string, signature: string }> }} doc
 * @param {string} product - "any", "ProGet", "Otter" or "BuildMaster"
 * @returns {string[]} Empty when the entry has no signature
 */
function productSignatures(doc, product) {
  if (!doc.signature) return [];
  const overloads = doc.overloads ?? [];
  if (product === "any") return [doc.signature, ...overloads.map((o) => o.signature)];
  return [overloads.find((o) => o.product === product)?.signature ?? doc.signature];
}

/**
 * The docs entry of each item {@link buildCompletionItem} made whose
 * documentation hasn't been built yet. Weak, so items VS Code drops are
 * garbage-collected.
 * @type {WeakMap<vscode.CompletionItem, import("./language-data.js").DocEntry>}
 */
const pendingDocumentation = new WeakMap();

/**
 * Builds a completion item with consistent formatting.
 *
 * This centralizes completion item creation to ensure all providers
 * produce consistent UI elements (labels, details, documentation, sorting).
 * The documentation is built only when VS Code shows the item's details:
 * a provider that returns these items must also implement
 * `resolveCompletionItem` with {@link resolveCompletionDocumentation}.
 *
 * @param {import('./language-data.js').DocEntry} doc - Documentation object
 * @param {vscode.CompletionItemKind} kind - Item kind (Function, Variable, Keyword, etc.)
 * @param {string} sortPrefix - Sort order prefix; lower sorts first (e.g. "0_"
 *   operations, "1_" keywords / scalar functions, "2_" variables)
 * @param {string | vscode.SnippetString} insertText - Text to insert when selected
 * @param {boolean} [triggerSignatureHelp=false] - Whether to trigger signature help after insertion
 * @returns {vscode.CompletionItem} - Formatted completion item
 *
 * @example
 * // For a scalar function
 * buildCompletionItem(doc, vscode.CompletionItemKind.Function, '1_', snippet, true);
 *
 * // For a variable (no signature help)
 * buildCompletionItem(doc, vscode.CompletionItemKind.Variable, '2_', snippet, false);
 */
function buildCompletionItem(doc, kind, sortPrefix, insertText, triggerSignatureHelp = false) {
  const item = new vscode.CompletionItem(
    { label: doc.name, description: doc.description },
    kind
  );

  item.insertText = insertText;
  item.detail = doc.signature ?? doc.description;
  // Built lazily: a list holds hundreds of items, and VS Code shows the
  // documentation of only the focused one.
  pendingDocumentation.set(item, doc);
  // A superseded name is struck through and listed after the rest.
  item.sortText = `${sortPrefix}${doc.superseded ? "~" : ""}${doc.name}`;
  if (doc.superseded) item.tags = [vscode.CompletionItemTag.Deprecated];

  // Trigger signature help after insertion (for functions with parameters)
  if (triggerSignatureHelp) {
    item.command = {
      command: "editor.action.triggerParameterHints",
      title: ""  // Title required but not shown for built-in commands
    };
  }

  return item;
}

/**
 * Fills in the documentation of an item from {@link buildCompletionItem}
 * (a CompletionItemProvider's `resolveCompletionItem`). Other items are
 * returned as they are.
 *
 * @param {vscode.CompletionItem} item
 * @returns {vscode.CompletionItem}
 */
function resolveCompletionDocumentation(item) {
  const doc = pendingDocumentation.get(item);
  if (doc) {
    item.documentation = buildHoverMarkdown(doc);
    pendingDocumentation.delete(item);
  }
  return item;
}

/**
 * Completion items for the entries of one docs table whose name starts with
 * what the user typed after a sigil (`$To` -> `$ToJson`, ...). Shared by the
 * `$`, `@` and `%` completion providers, so every table is turned into items
 * the same way:
 * - inserted text: the entry's snippet, or `Name(${0})` for a function and
 *   `Name` otherwise -- always without the leading sigil (escaped `\$` or
 *   plain), which the user has already typed;
 * - a function (signature with `(`) is a Function item that opens signature
 *   help; anything else (a runtime variable) is a Variable item.
 *
 * @param {Readonly<Record<string, import('./language-data.js').DocEntry>>} table
 * @param {string} typed - Identifier typed after the sigil (may be empty)
 * @param {{ functionSort: string, variableSort: string }} sort - Sort-text
 *   prefixes for functions and variables (lower sorts first)
 * @param {string} [product] - The `otterscript.product` setting; entries the
 *   product doesn't have are left out (see {@link isAvailableIn})
 * @returns {vscode.CompletionItem[]}
 */
function buildSigilCompletionItems(table, typed, sort, product = "any") {
  const lowerTyped = typed.toLowerCase();
  return Object.entries(table)
    .filter(([key, doc]) => key.toLowerCase().startsWith(lowerTyped) && isAvailableIn(doc, product))
    .map(([, doc]) => {
      const isFunction = doc.signature?.includes("(") ?? false;
      const bareName = doc.name.replace(/^[$@%]/, "");
      const text = doc.snippet
        ? doc.snippet.replace(/^\\?[$@%]/, "")
        : isFunction ? `${bareName}(\${0})` : bareName;
      return buildCompletionItem(
        doc,
        isFunction ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Variable,
        isFunction ? sort.functionSort : sort.variableSort,
        new vscode.SnippetString(text),
        isFunction
      );
    });
}

// ============================================================
// LOOKUP & TEXT UTILITIES
// ============================================================

/**
 * A table's own entry for `key`, or undefined. The docs tables and the fix
 * table are plain objects, so `table[key]` would also find inherited members:
 * hovering `$constructor` used to show `Object`'s constructor as a function.
 *
 * @template T
 * @param {Readonly<Record<string, T>>} table
 * @param {string} key
 * @returns {T | undefined}
 */
function lookupOwn(table, key) {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Levenshtein edit distance between two short strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  /** @type {number[]} */
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const curr = [i];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[cols - 1];
}

/**
 * The candidate closest to `value` by edit distance, ignoring case -- a
 * likely typo's intended word (`"bold"` -> `"bolder"`, `"Windoze"` ->
 * `"Windows"`) -- or undefined when none is close enough to suggest. A
 * case-only difference is distance 0, so it always wins.
 *
 * @param {string} value
 * @param {Iterable<string>} candidates
 * @returns {string | undefined}
 */
function closestMatch(value, candidates) {
  const lower = value.toLowerCase();
  let best;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = editDistance(lower, candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Only a plausible typo, not an unrelated word.
  return bestDistance <= Math.max(2, Math.ceil(value.length / 3)) ? best : undefined;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // -- Configuration
  loadConfig,

  // -- Constants
  NON_VARIABLE_IDENTIFIERS,

  // -- Logger
  log,
  getOutputChannel,

  // -- Timers & concurrency
  clearTimerForUri,
  scheduleTimerForUri,
  mapWithConcurrency,

  // -- Docs tables
  lookupOwn,
  isAvailableIn,
  productSignatures,

  // -- Completion & hover
  isReadOnlyView,
  isValidCompletionPosition,
  getTypedIdentifier,
  buildHoverMarkdown,
  buildArgumentHoverMarkdown,
  buildCompletionItem,
  buildSigilCompletionItems,
  resolveCompletionDocumentation,

  // -- Text utilities
  closestMatch,
};
