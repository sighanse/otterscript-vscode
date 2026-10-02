// @ts-check
/**
 * @fileoverview Shared helpers for the OtterScript extension: settings, the
 * logger, per-document timers, docs-table validation and lookup, and the
 * hover and completion item builders.
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


// Namespace allowlist — the single source of truth lives with the data it
// describes. Plain data module, no vscode dependency.
const { NAMESPACES } = require("./language-data");

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
    diagnosticRules: config.get("diagnostics.rules", {}),
    adaptiveCardMaxVersion: config.get("adaptiveCards.maxVersion", "1.6"),
    product: config.get("product", "any")
  };
}

// ============================================================
// CONSTANTS
// ============================================================

/** The Inedo products a docs entry's `products` may list. */
const PRODUCTS = ["ProGet", "Otter", "BuildMaster"];

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
 * @type {Set<string>}
 */
const NON_VARIABLE_IDENTIFIERS = new Set([
  "true",   // Boolean literal
  "false",  // Boolean literal
  "null"    // Null literal
]);

// ============================================================
// TIME UTILITIES
// ============================================================

/**
 * Returns the current local time as a 24-hour clock string (e.g. "14:03:59";
 * exact format follows the host locale).
 * @returns {string}
 * @private
 */
function timestamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

// ============================================================
// LOGGER
// ============================================================

const LOGPREFIX = '[OtterScript] ';
/** @type {import('vscode').OutputChannel | null} */
let outputChannel = null;

/**
 * Gets or creates the OtterScript output channel.
 * The channel appears in VS Code under View → Output → OtterScript.
 *
 * @returns {import('vscode').OutputChannel}
 */
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('OtterScript');
  }
  return outputChannel;
}

/**
 * Appends a line to the cached output channel with lazy initialization.
 *
 * @param {string} line
 * @returns {void}
 */
function appendOutputLine(line) {
  getOutputChannel().appendLine(line);
}

/**
 * Centralized logger for OtterScript Language extension.
 *
 * `info` / `warn` / `error` write to both the developer console and the
 * OtterScript output channel; `debug` writes to the console only.
 *
 * @example
 * log.info('Extension activated');
 * log.warn('Missing documentation field');
 * log.error('Failed to load docs', err);
 * log.debug('Processing line', lineIndex);
 */
const log = {
  /** @param {...any} args - e.g. `log.info('Extension activated')` */
  info: (...args) => {
    const now = timestamp();
    console.log(LOGPREFIX, `[${now}]`, ...args);
    appendOutputLine(`[${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - e.g. `log.warn('Missing field')` */
  warn: (...args) => {
    const now = timestamp();
    console.warn(LOGPREFIX, `[${now}]`, ...args);
    appendOutputLine(`⚠️ [${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - e.g. `log.error('Failed', err)` */
  error: (...args) => {
    const now = timestamp();
    console.error(LOGPREFIX, `[${now}]`, ...args);
    appendOutputLine(`❌ [${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - e.g. `log.debug('Processing', lineIndex)` */
  debug: (...args) => {
    const now = timestamp();
    // Debug logs go to console only - intentionally excluded from Output Channel
    // to avoid flooding the user-visible log with internal diagnostics.
    console.debug(LOGPREFIX, `[${now}]`, '[DEBUG]', ...args);
  }
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
// VALIDATION
// ============================================================

/**
 * Performs best-effort validation of documentation tables.
 *
 * @param {string} label - Human-readable category label (e.g. "keywordDocs")
 * @param {Record<string, unknown>} docsTable - Documentation table to validate
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateDocs(label, docsTable) {
  const errors = [];
  const warnings = [];

  for (const [key, rawDoc] of Object.entries(docsTable)) {
    /** @type {any} */
    const doc = rawDoc;

    if (!doc || typeof doc !== "object") {
      errors.push(`${label}.${key} is not an object`);
      continue;
    }

    // Required Field: 'name'
    if (!doc.name || typeof doc.name !== "string" || doc.name.trim() === "") {
      errors.push(`${label}.${key} is missing required 'name'`);
    }

    // Required Field: 'description'
    if (!doc.description || typeof doc.description !== "string") {
      errors.push(`${label}.${key} is missing required 'description'`);
    }

    // Required Field: 'namespace' — must be present and either null or one of
    // the known OtterScript namespace tokens (guards against typos / drift).
    if (!("namespace" in doc)) {
      errors.push(`${label}.${key} is missing required 'namespace'`);
    } else if (doc.namespace !== null && !NAMESPACES.has(doc.namespace)) {
      errors.push(
        `${label}.${key} 'namespace' must be null or one of ` +
        `${[...NAMESPACES].join(", ")} (got ${JSON.stringify(doc.namespace)})`
      );
    }

    // Optional Field: 'snippet'
    if (doc.snippet && typeof doc.snippet !== "string") {
      warnings.push(`${label}.${key} 'snippet' must be a string`);
    }

    // Optional Field: 'signature'
    if (doc.signature && typeof doc.signature !== "string") {
      warnings.push(`${label}.${key} 'signature' must be a string`);
    }

    // Optional Field: 'documentation'
    if (doc.documentation && typeof doc.documentation !== "string") {
      warnings.push(`${label}.${key} 'documentation' must be a string`);
    }

    // Optional Field: 'products' -- the Inedo products that have it
    if (doc.products !== undefined && (!Array.isArray(doc.products) ||
        doc.products.some((/** @type {any} */ p) => !PRODUCTS.includes(p)))) {
      warnings.push(`${label}.${key} 'products' must be an array of ${PRODUCTS.join(", ")}`);
    }

    // Optional Field: 'anySigil' -- works with every sigil
    if (doc.anySigil !== undefined && doc.anySigil !== true) {
      warnings.push(`${label}.${key} 'anySigil' must be true when set`);
    }

    // Optional Field: 'overloads' -- other products' forms of the function
    if (doc.overloads !== undefined && (!Array.isArray(doc.overloads) ||
        doc.overloads.some((/** @type {any} */ o) => typeof o?.product !== "string" || typeof o?.signature !== "string"))) {
      warnings.push(`${label}.${key} 'overloads' must be an array of { product, signature } strings`);
    }
  }

  // Log errors
  if (errors.length) {
    log.error(`[docs] ${label} errors:`, errors);
  }
  // Log warnings
  if (warnings.length) {
    log.warn(`[docs] ${label} warnings:`, warnings);
  }

  return { errors, warnings };
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
  "$": /\$([a-zA-Z]*)$/,
  "@": /@([a-zA-Z]*)$/,
  "%": /%([a-zA-Z]*)$/,
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
// REGEX UTILITIES
// ============================================================

/**
 * Builds a word-boundary RegExp that matches any of the given names.
 * Used for creating efficient lookup regexes from Sets of known identifiers.
 *
 * @param {Iterable<string>} names - Collection of strings to match
 * @returns {RegExp} Regular expression with word boundaries
 * @private
 *
 * @example
 * const regex = buildWordRegex(['Log-Information', 'Log-Error']);
 * // Returns: /\b(Log\-Information|Log\-Error)\b/  (regex metacharacters escaped)
 */
function buildWordRegex(names) {
  return new RegExp(
    `\\b(${[...names]
      .map(name =>
        name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
      )
      .join("|")})\\b`
  );
}

/**
 * Creates all regex patterns needed for the extension.
 *
 * Each entry is a factory returning a FRESH RegExp, so callers never share a
 * global regex's `lastIndex` state between scans.
 *
 * - `*CallRegex` (global): find `$Name(` / `@Name(` / bare-word tokens in a line.
 * - `*SignatureRegex` (anchored to end of input): find the call the cursor is inside,
 *   given the text before the cursor; group 1 = name, group 2 = args so far.
 * - `operationRegex`: word-boundary match of any known operation name.
 *
 * @param {Set<string>} knownOperations - Set of operation names
 * @returns {{
 *   scalarCallRegex: () => RegExp,
 *   vectorCallRegex: () => RegExp,
 *   operationCallRegex: () => RegExp,
 *   scalarSignatureRegex: () => RegExp,
 *   vectorSignatureRegex: () => RegExp,
 *   mapSignatureRegex: () => RegExp,
 *   operationSignatureRegex: () => RegExp,
 *   operationRegex: () => RegExp
 * }}
 */
function createRegexPatterns(knownOperations) {
  return {
    scalarCallRegex: () => /\$([A-Za-z][A-Za-z0-9_]*)\s*\(/g,
    vectorCallRegex: () => /@([A-Za-z][A-Za-z0-9_]*)\s*\(/g,
    operationCallRegex: () => /\b([A-Za-z][A-Za-z-]*)\b/g,
    scalarSignatureRegex: () => /\$([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/,
    vectorSignatureRegex: () => /@([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/,
    // Requires a name after `%`, so a `%(` map literal never matches.
    mapSignatureRegex: () => /%([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/,
    // Group 1: operation name. Group 2: argument text typed so far (cursor at end).
    // The optional segment after the name allows one default/positional argument
    // between the name and the "(" -- a quoted string or a single bare token --
    // e.g. `ProGet::Create-Directory my/folder/path\n(`. It deliberately excludes
    // whitespace and "=" so it cannot swallow an assignment like `set $x = (`.
    operationSignatureRegex: () => /(?:^|\s)(?:[A-Za-z][\w-]*::)?([A-Za-z][A-Za-z-]*)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s(){};=]+))?\s*\(([^()]*)$/,
    operationRegex: () => buildWordRegex(knownOperations),
  };
}

// ============================================================
// HOVER & COMPLETION BUILDERS
// ============================================================

/**
 * Builds a standardized hover MarkdownString from a documentation entry.
 *
 * This creates the formatted tooltip content shown when hovering over
 * symbols, keywords, operations, and syntax elements.
 *
 * @param {Readonly<{ name: string, signature?: string, overloads?: { product: string, signature: string }[], description?: string, documentation?: string, namespace?: string | null, products?: ReadonlyArray<string>, anySigil?: boolean }>} doc
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

  // Namespace provenance -- the extension/namespace this construct belongs to.
  // Omitted for pure language constructs (keywords, syntax, Log-*) where it is null.
  if (doc.namespace) {
    md.appendMarkdown(`**Namespace:** \`${doc.namespace}\`\n\n`);
  }

  // Short description
  if (doc.description) {
    md.appendMarkdown(`${doc.description}\n\n`);
  }

  // Extended documentation (supports Markdown)
  if (typeof doc.documentation === "string") {
    md.appendMarkdown(doc.documentation);
  }

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
 * Builds a completion item with consistent formatting.
 *
 * This centralizes completion item creation to ensure all providers
 * produce consistent UI elements (labels, details, documentation, sorting).
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
  item.documentation = buildHoverMarkdown(doc);
  item.sortText = `${sortPrefix}${doc.name}`;

  // Trigger signature help after insertion (for functions with parameters)
  if (triggerSignatureHelp) {
    item.command = {
      command: 'editor.action.triggerParameterHints',
      title: ''  // Title required but not shown for built-in commands
    };
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
  validateDocs,
  lookupOwn,
  isAvailableIn,

  // -- Completion & hover
  isReadOnlyView,
  isValidCompletionPosition,
  getTypedIdentifier,
  buildHoverMarkdown,
  buildCompletionItem,
  buildSigilCompletionItems,

  // -- Text utilities
  editDistance,
  createRegexPatterns,
};
