// @ts-check
/**
 * @fileoverview VS Code-facing helper functions for the OtterScript extension.
 *
 * The `vscode`-free text scanning primitives (non-code masking, string/comment
 * detection, argument parsing, module-name regexes) live in {@link module:scanner}
 * and are re-exported from here so existing `require("./helpers")` callers keep
 * working. Everything defined directly in this file may touch the `vscode` API.
 *
 * Dependencies:
 * - vscode (required for OutputChannel, CompletionItem, etc.)
 * - ./scanner (pure text primitives)
 *
 * @module helpers
 */

const vscode = require("vscode");

// Pure text-scanning primitives. Imported for internal use below and re-exported
// from this module's `module.exports` for backward compatibility.
const {
  createCodeScanState,
  createTemplateScanState,
  maskNonCodeSpans,
  advanceScanState,
  maskOutsideTemplateTags,
  documentUsesTemplateTags,
  findTemplateTagDelimiters,
  isInStringOrComment,
  getActiveParameterIndex,
  splitSignatureParameters,
  maskClosedGroups,
  MODULE_NAME_TOKEN_REGEX,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  findModuleDeclarations,
  indexVariableOccurrences,
  variableKey,
} = require("./scanner");

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
 *   adaptiveCardMaxVersion: string
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
    adaptiveCardMaxVersion: config.get("adaptiveCards.maxVersion", "1.6")
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
// MODULE NAVIGATION
// ============================================================

/**
 * A `module <Name>` declaration in an open document.
 * `range` covers just the name; `lineRange` covers the whole declaration line
 * (used as the DocumentSymbol's full range).
 *
 * @typedef {{ name: string, range: vscode.Range, lineRange: vscode.Range }} ModuleDeclaration
 */

/**
 * @typedef {{
 *   version: number,
 *   declarations: ModuleDeclaration[],
 *   refsByName: Map<string, vscode.Location[]>
 * }} ModuleInfoCacheEntry
 */

/**
 * Per-document module analysis, keyed by `uri.toString()` and invalidated by
 * `document.version`. Entries are dropped on close via {@link clearDocumentCaches}.
 * @type {Map<string, ModuleInfoCacheEntry>}
 */
const moduleInfoCache = new Map();

/**
 * Carried scanning state for cross-line constructs. Defined in {@link module:scanner};
 * aliased here so JSDoc in this file can refer to it.
 *
 * @typedef {import("./scanner").CodeScanState} CodeScanState
 */

/**
 * Returns all module declarations in a document (cached per document version).
 *
 * @param {vscode.TextDocument} document
 * @returns {ModuleDeclaration[]}
 */
function getModuleDeclarations(document) {
  return getModuleInfo(document).declarations;
}

/**
 * Builds and caches module declarations and module call references for a document version.
 *
 * @param {vscode.TextDocument} document
 * @returns {{ declarations: ModuleDeclaration[], refsByName: Map<string, vscode.Location[]> }}
 */
function getModuleInfo(document) {
  const cacheKey = document.uri.toString();
  const cached = moduleInfoCache.get(cacheKey);
  if (cached && cached.version === document.version) {
    return { declarations: cached.declarations, refsByName: cached.refsByName };
  }

  // Declarations: reuse the shared pure scanner so the `module <Name>` scan
  // lives in exactly one place ({@link module:scanner}.findModuleDeclarations).
  /** @type {ModuleDeclaration[]} */
  const declarations = findModuleDeclarations(document.getText()).map(hit => ({
    name: hit.name,
    range: new vscode.Range(
      new vscode.Position(hit.line, hit.character),
      new vscode.Position(hit.line, hit.character + hit.name.length)
    ),
    lineRange: document.lineAt(hit.line).range,
  }));

  // Call references: a second length-preserving masked pass, line by line.
  /** @type {Map<string, vscode.Location[]>} */
  const refsByName = new Map();
  const scanState = createCodeScanState();

  for (let line = 0; line < document.lineCount; line++) {
    const maskedLineText = maskNonCodeSpans(document.lineAt(line).text, scanState);

    MODULE_CALL_TARGET_GLOBAL_REGEX.lastIndex = 0;
    for (const callMatch of maskedLineText.matchAll(MODULE_CALL_TARGET_GLOBAL_REGEX)) {
      const moduleName = callMatch[1];
      if (typeof moduleName !== "string" || typeof callMatch.index !== "number") {
        continue;
      }

      const start = callMatch.index + callMatch[0].indexOf(moduleName);
      const range = new vscode.Range(
        new vscode.Position(line, start),
        new vscode.Position(line, start + moduleName.length)
      );
      const location = new vscode.Location(document.uri, range);

      const existing = refsByName.get(moduleName);
      if (existing) {
        existing.push(location);
      } else {
        refsByName.set(moduleName, [location]);
      }
    }
  }

  moduleInfoCache.set(cacheKey, {
    version: document.version,
    declarations,
    refsByName
  });

  return { declarations, refsByName };
}

/**
 * Finds the declaration range of a module in the document.
 *
 * @param {vscode.TextDocument} document
 * @param {string} moduleName
 * @returns {vscode.Range | null}
 */
function findModuleDeclarationRange(document, moduleName) {
  const { declarations } = getModuleInfo(document);
  const declaration = declarations.find(entry => entry.name === moduleName);
  return declaration?.range ?? null;
}

/**
 * Returns module call references by name from cached module analysis.
 *
 * This reuses `getModuleInfo(document)` and optionally filters to a subset
 * of module names.
 *
 * @param {vscode.TextDocument} document
 * @param {ReadonlySet<string>} [allowedModuleNames] - Optional filter of module names to include
 * @returns {Map<string, vscode.Location[]>}
 */
function getModuleCallReferencesByName(document, allowedModuleNames) {
  const { refsByName } = getModuleInfo(document);
  if (!allowedModuleNames) {
    return refsByName;
  }

  /** @type {Map<string, vscode.Location[]>} */
  const filtered = new Map();
  for (const moduleName of allowedModuleNames) {
    const refs = refsByName.get(moduleName);
    if (refs) {
      filtered.set(moduleName, refs);
    }
  }

  return filtered;
}

/**
 * Per-document variable index ({@link indexVariableOccurrences}), keyed by
 * `uri.toString()` and invalidated by `document.version`, so highlighting on
 * every cursor move doesn't rescan an unchanged document. Entries are dropped
 * on close via {@link clearDocumentCaches}.
 * @type {Map<string, { version: number, index: Map<string, import("./scanner").VariableOccurrence[]> }>}
 */
const variableIndexCache = new Map();

/**
 * Scan states at the start of each line, per document version: `states[i]`
 * is the state on entering line `i`. Filled in lazily, only as far as a
 * request has needed, so hover, completion and highlight on every keystroke
 * don't rescan the document from line 1. Dropped on close via
 * {@link clearDocumentCaches}.
 * @type {Map<string, { version: number, states: import("./scanner").CodeScanState[] }>}
 */
const lineStartStateCache = new Map();

/**
 * Every reference to one variable in a document (see
 * {@link indexVariableOccurrences}), from a per-version cache.
 *
 * @param {vscode.TextDocument} document
 * @param {string} sigil - `$`, `@`, or `%`
 * @param {string} name - Variable name without its sigil
 * @returns {import("./scanner").VariableOccurrence[]}
 */
function getVariableOccurrences(document, sigil, name) {
  const cacheKey = document.uri.toString();
  let cached = variableIndexCache.get(cacheKey);
  if (!cached || cached.version !== document.version) {
    cached = { version: document.version, index: indexVariableOccurrences(document.getText()) };
    variableIndexCache.set(cacheKey, cached);
  }
  return cached.index.get(variableKey(sigil, name)) ?? [];
}

/**
 * Clears the per-document caches (module info, variable index and line-start
 * scan states) for a document URI.
 *
 * @param {import('vscode').Uri} uri
 * @returns {void}
 */
function clearDocumentCaches(uri) {
  moduleInfoCache.delete(uri.toString());
  variableIndexCache.delete(uri.toString());
  lineStartStateCache.delete(uri.toString());
}

/**
 * The module name under the cursor, when it is a real module reference: the
 * name in a `module X` declaration or a `call X` statement, outside strings
 * and comments. Shared by Go to Definition, Find References and Highlight.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{ name: string, range: vscode.Range, isDeclaration: boolean } | null}
 */
function getModuleNameAt(document, position) {
  const range = document.getWordRangeAtPosition(position, MODULE_NAME_TOKEN_REGEX);
  if (!range || isInStringOrCommentDoc(document, range.start)) return null;

  const lineText = document.lineAt(range.start.line).text;
  const isDeclaration = isModuleDeclarationContext(lineText, range.start.character);
  if (!isDeclaration && !isModuleCallContext(lineText, range.start.character)) return null;

  return { name: document.getText(range), range, isDeclaration };
}

/**
 * Finds references to a module declaration and module calls in the document.
 *
 * @param {vscode.TextDocument} document
 * @param {string} moduleName
 * @param {boolean} includeDeclaration
 * @returns {vscode.Location[]}
 */
function findModuleReferences(document, moduleName, includeDeclaration) {
  /** @type {vscode.Location[]} */
  const locations = [];

  const { declarations, refsByName } = getModuleInfo(document);

  if (includeDeclaration) {
    const declaration = declarations.find(entry => entry.name === moduleName);
    if (declaration) {
      locations.push(new vscode.Location(document.uri, declaration.range));
    }
  }

  const callRefs = refsByName.get(moduleName);
  if (callRefs) {
    locations.push(...callRefs);
  }

  return locations;
}

// ============================================================
// STRING & COMMENT DETECTION
// ============================================================

/**
 * Document-aware version of {@link isInStringOrComment}.
 *
 * Scans from the beginning of the document with carried {@link CodeScanState}
 * so that multi-line block comments (`/* ... *\/`) and swim-strings that
 * opened on a previous line are correctly detected.
 *
 * Use this in providers that have access to a full `TextDocument` object.
 * Fall back to {@link isInStringOrComment} only for isolated single-line
 * analysis (e.g. inside loops that already carry external state).
 *
 * @param {import('vscode').TextDocument} document - The open text document
 * @param {import('vscode').Position} position - Cursor or token position to test
 * @returns {boolean} true if the position is inside a string, comment, or swim-string
 */
function isInStringOrCommentDoc(document, position) {
  return isInStringOrComment(
    document.lineAt(position.line).text,
    position.character,
    getLineStartScanState(document, position.line)
  );
}

/**
 * The scan state on entering `line` (a fresh copy the caller may change).
 *
 * @param {vscode.TextDocument} document
 * @param {number} line
 * @returns {import("./scanner").CodeScanState}
 */
function getLineStartScanState(document, line) {
  const cacheKey = document.uri.toString();
  let cached = lineStartStateCache.get(cacheKey);
  if (!cached || cached.version !== document.version) {
    cached = { version: document.version, states: [createCodeScanState()] };
    lineStartStateCache.set(cacheKey, cached);
  }
  const { states } = cached;
  // Use advanceScanState (not maskNonCodeSpans) for the lines in between: only
  // the state is needed, not the masked text.
  while (states.length <= line) {
    const state = { ...states[states.length - 1] };
    advanceScanState(document.lineAt(states.length - 1).text, state);
    states.push(state);
  }
  return { ...states[line] };
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
 * @param {Readonly<{ name: string, signature?: string, overloads?: { product: string, signature: string }[], description?: string, documentation?: string, namespace?: string | null }>} doc
 *   - name: Required - Display name (e.g., "$ToJson")
 *   - signature: Optional - Function signature (monospace formatted)
 *   - overloads: Optional - The function's form in other Inedo products, each
 *     shown as "**In <product>:** `signature`"
 *   - description: Optional - Short description
 *   - documentation: Optional - Extended Markdown documentation
 *   - namespace: Optional - Owning OtterScript namespace (shown as provenance)
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
function buildHoverMarkdown(doc) {
  const md = new vscode.MarkdownString();

  // Heading (### is h3 in Markdown, renders bold in VS Code)
  md.appendMarkdown(`### ${doc.name}\n\n`);

  // Signature (monospace for code clarity)
  if (doc.signature) {
    md.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
  }
  // The same function's form in other Inedo products, when it differs
  for (const overload of doc.overloads ?? []) {
    md.appendMarkdown(`**In ${overload.product}:** \`${overload.signature}\`\n\n`);
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
 * @returns {vscode.CompletionItem[]}
 */
function buildSigilCompletionItems(table, typed, sort) {
  const lowerTyped = typed.toLowerCase();
  return Object.entries(table)
    .filter(([key]) => key.toLowerCase().startsWith(lowerTyped))
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
// DIAGNOSTIC CHECKS
// ============================================================

/**
 * Checks for missing '$' before variable names in if conditions.
 *
 * Only the first operand after `if` (and any opening parens) is checked, and
 * only when it is directly followed by a comparison operator -- e.g.
 * `if count == 5` or `if (count > 5)`.
 *
 * @param {string} line - The line, already masked by {@link maskNonCodeSpans}
 *   (so identifiers inside strings/comments are not seen)
 * @param {number} lineIndex - The line number (0-indexed)
 * @param {Set<string>} nonVariableIdentifiers - Set of literals (true, false, null)
 * @returns {vscode.Diagnostic | null} - Diagnostic if missing '$' found, null otherwise
 */
function checkMissingDollar(line, lineIndex, nonVariableIdentifiers) {
  const match = line.match(/^\s*if\s*(?:\(\s*)*([a-zA-Z][a-zA-Z0-9_]*)\s*(=|==|!=|<=|>=|<|>)/);

  // -- Guard: ensure regex matched and we have a valid index position
  if (!match || typeof match.index !== 'number') return null;

  const varName = match[1];

  // -- Skip known literals that don't need '$' (true, false, null)
  if (nonVariableIdentifiers.has(varName)) {
    return null;
  }

  // -- Calculate exact position of variable name within the line
  const varNameIndex = match.index + match[0].indexOf(varName);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(lineIndex, varNameIndex),
      new vscode.Position(lineIndex, varNameIndex + varName.length)
    ),
    `Missing '$' before variable: ${varName}. Use $${varName}`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.code = "missing-dollar";
  diagnostic.source = "OtterScript";

  return diagnostic;
}

/**
 * Finds the matching ')' for the '(' at `openParenIndex` in text already
 * masked by {@link maskNonCodeSpans} (so no string-awareness is needed).
 * Unlike scanner's `findBalancedParenEnd`, this may cross line breaks.
 *
 * @param {string} maskedText
 * @param {number} openParenIndex - Index of the opening '('
 * @returns {number} Matching ')' index, or -1 when not found
 * @private
 */
function findMatchingParen(maskedText, openParenIndex) {
  let depth = 1;
  for (let i = openParenIndex + 1; i < maskedText.length; i++) {
    if (maskedText[i] === "(") depth++;
    if (maskedText[i] === ")") depth--;
    if (depth === 0) return i;
  }
  return -1;
}

/**
 * Finds duplicate keys inside map expressions and returns diagnostics, given
 * text that has ALREADY been masked by {@link maskNonCodeSpans}.
 *
 * This performs a best-effort scan of `%(... )` blocks and warns when the
 * same key appears more than once at the top level of a map. `updateDiagnostics`
 * masks every line during its own scan and passes that masked copy straight in,
 * so strings, comments, and swim-strings are ignored identically to every other
 * feature. A raw-text caller must run `maskNonCodeSpans` line by line first
 * (see `createCodeScanState`).
 *
 * @param {vscode.TextDocument} document - Document to analyze; used only for
 *   `positionAt()` offset-to-position conversion, not for its text.
 * @param {string} maskedText - Document text already run through
 *   `maskNonCodeSpans`, with strings, comments, and swim-strings blanked out
 *   and line length/offsets preserved (so `document.positionAt()` stays valid).
 * @returns {vscode.Diagnostic[]} Duplicate-key diagnostics
 */
function findDuplicateMapKeyDiagnosticsFromMasked(document, maskedText) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  /**
   * Parses a map expression body and reports duplicate top-level keys.
   *
   * @param {number} start - Start index of map body (after '%(')
   * @param {number} end - End index of map body (at matching ')')
   * @returns {void}
   */
  function scanMapBody(start, end) {
    let nestingDepth = 0;
    let segmentStart = start;
    const seenKeys = new Set();

    for (let i = start; i <= end; i++) {
      const ch = i === end ? ',' : maskedText[i];

      if (ch === '(' || ch === '[' || ch === '{') {
        nestingDepth++;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (nestingDepth > 0) nestingDepth--;
        continue;
      }

      if (ch === ',' && nestingDepth === 0) {
        const segmentText = maskedText.slice(segmentStart, i);
        const keyMatch = segmentText.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/);

        if (keyMatch) {
          const key = keyMatch[1];
          const keyStart = segmentStart + keyMatch[0].indexOf(key);

          if (seenKeys.has(key)) {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(
                document.positionAt(keyStart),
                document.positionAt(keyStart + key.length)
              ),
              `Duplicate key '${key}' in map expression.`,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = "duplicate-map-key";
            diagnostic.source = "OtterScript";
            issues.push(diagnostic);
          } else {
            seenKeys.add(key);
          }
        }

        segmentStart = i + 1;
      }
    }
  }

  // Every `%(` gets its own scan -- including maps nested inside another map,
  // whose keys scanMapBody deliberately ignores when scanning the outer one.
  for (let i = 0; i < maskedText.length - 1; i++) {
    if (maskedText[i] === '%' && maskedText[i + 1] === '(') {
      const close = findMatchingParen(maskedText, i + 1);
      if (close !== -1) {
        scanMapBody(i + 2, close);
      }
    }
  }

  return issues;
}

/**
 * Parses a `$Name(...)` / `@Name(...)` / `%Name(...)` doc signature and returns the maximum
 * number of arguments the call can take, or `null` when the signature isn't a
 * fixed-arity parenthesized call (a bare property like `$ExecutionId`, or a
 * vararg signature containing a literal `...` parameter such as
 * `$PathCombine(path1, path2, ...)`).
 *
 * Only the total slot count is computed -- required vs. `[optional]` isn't
 * distinguished, since that's all a "too many arguments" check needs and it
 * avoids relying on the optional-bracket convention being 100% consistent.
 *
 * @param {string} signature - e.g. `"$ToJson(data)"`
 * @returns {number | null}
 */
function parseFixedMaxArity(signature) {
  const m = signature.match(/^[$@%][A-Za-z]\w*\(([\s\S]*)\)$/);
  if (!m) return null;

  const argsText = m[1].trim();
  if (argsText === "") return 0;

  const parts = argsText.split(",").map((s) => s.trim());
  if (parts.some((p) => p === "...")) return null;

  return parts.length;
}

/**
 * The signature fields the argument-count check reads from a docs entry.
 * @typedef {{ signature?: string, overloads?: { product: string, signature: string }[] }} FunctionSignatures
 */

/**
 * The most arguments any documented form of a function takes: its
 * `signature` and its other products' `overloads` (e.g. BuildMaster's
 * three-argument `$PackageProperty` next to ProGet's two-argument one). `null`
 * when any form is not fixed-arity, so a call is never flagged for using a
 * form that is valid somewhere.
 *
 * @param {FunctionSignatures} doc
 * @returns {number | null}
 */
function maxFixedArity(doc) {
  let max = 0;
  for (const signature of [doc.signature, ...(doc.overloads ?? []).map((o) => o.signature)]) {
    if (!signature) continue;
    const arity = parseFixedMaxArity(signature);
    if (arity === null) return null;
    max = Math.max(max, arity);
  }
  return max;
}

/**
 * Finds calls to known scalar/vector/map functions that pass more arguments than
 * their documented signature allows, given text already masked by
 * {@link maskNonCodeSpans} (and, for template-aware documents,
 * {@link maskOutsideTemplateTags}). Only functions with a fixed-arity,
 * parenthesized signature are checked -- see {@link parseFixedMaxArity}.
 *
 * This deliberately does NOT flag too few arguments: which parameters are
 * truly required (vs. documented as optional) is a softer signal than the
 * hard ceiling on total slots, so under-counting stays silent to avoid false
 * positives.
 *
 * @param {vscode.TextDocument} document - Used only for `positionAt()`.
 * @param {string} maskedText - Full document text, already masked.
 * @param {Record<string, FunctionSignatures>} scalarFunctionDocs
 * @param {Record<string, FunctionSignatures>} vectorFunctionDocs
 * @param {Record<string, FunctionSignatures>} [mapFunctionDocs] - `%Name(...)` functions
 * @returns {vscode.Diagnostic[]}
 */
function findArgumentCountDiagnosticsFromMasked(document, maskedText, scalarFunctionDocs, vectorFunctionDocs, mapFunctionDocs = {}) {
  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  /**
   * @param {number} start - Index just after the call's '('
   * @param {number} end - Index of the matching ')'
   * @returns {number} Number of top-level comma-separated arguments
   */
  function countArgs(start, end) {
    const body = maskedText.slice(start, end);
    if (body.trim() === "") return 0;

    let depth = 0;
    let count = 1;
    for (const ch of body) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") { if (depth > 0) depth--; }
      else if (ch === "," && depth === 0) count++;
    }
    return count;
  }

  /**
   * @param {RegExp} nameRegex - Global regex; group 1 is the function name
   * @param {Record<string, FunctionSignatures>} docs
   * @param {string} sigil - `"$"`, `"@"`, or `"%"`, for the diagnostic message
   */
  function scan(nameRegex, docs, sigil) {
    for (const match of maskedText.matchAll(nameRegex)) {
      const name = match[1];
      const doc = lookupOwn(docs, name);
      if (!doc?.signature) continue;

      const maxArity = maxFixedArity(doc);
      if (maxArity === null) continue;

      const openParenIndex = /** @type {number} */ (match.index) + match[0].length - 1;
      const closeParenIndex = findMatchingParen(maskedText, openParenIndex);
      if (closeParenIndex === -1) continue;

      const argCount = countArgs(openParenIndex + 1, closeParenIndex);
      if (argCount <= maxArity) continue;

      const nameStart = /** @type {number} */ (match.index) + 1;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(
          document.positionAt(nameStart),
          document.positionAt(nameStart + name.length)
        ),
        `'${sigil}${name}' takes at most ${maxArity} argument${maxArity === 1 ? "" : "s"}, got ${argCount}.`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.code = "too-many-arguments";
      diagnostic.source = "OtterScript";
      issues.push(diagnostic);
    }
  }

  scan(/\$([A-Za-z][A-Za-z0-9_]*)\s*\(/g, scalarFunctionDocs, "$");
  scan(/@([A-Za-z][A-Za-z0-9_]*)\s*\(/g, vectorFunctionDocs, "@");
  scan(/%([A-Za-z][A-Za-z0-9_]*)\s*\(/g, mapFunctionDocs, "%");

  return issues;
}

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
 * Gets the diagnostic code as a string, unwrapping the `{ value, target }`
 * object form; returns '' when the diagnostic has no code.
 * @param {vscode.Diagnostic} diagnostic
 * @returns {string}
 */
function getDiagnosticCode(diagnostic) {
  const code = diagnostic.code;
  if (code === undefined || code === null) return '';
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

// ============================================================
// CODE ACTION FACTORY
// ============================================================

/**
 * Generic code action factory for creating quick-fix actions.
 *
 * This factory centralizes the creation of VS Code CodeAction objects,
 * reducing duplication across multiple fix providers.
 *
 * @private
 * @param {string} title - Human-readable action title shown in lightbulb menu
 * @param {vscode.Diagnostic} diagnostic - The diagnostic this action fixes
 * @param {(edit: vscode.WorkspaceEdit) => void} applyFix - Callback that applies the fix to a WorkspaceEdit
 * @returns {vscode.CodeAction} Configured code action ready to be returned to VS Code
 *
 * @example
 * // Create a fix that inserts a character
 * createCodeAction("Insert '$'", diagnostic, (edit) => {
 *   edit.insert(uri, position, "$");
 * });
 *
 */
function createCodeAction(title, diagnostic, applyFix) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  const edit = new vscode.WorkspaceEdit();
  applyFix(edit);
  action.edit = edit;
  return action;
}

/**
 * Creates a quick-fix that inserts a missing '$' at the diagnostic position.
 *
 * This code action appears in the lightbulb menu (💡) when a variable
 * is used without a '$' prefix in an if condition.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the missing '$' error
 * @returns {vscode.CodeAction} A code action that inserts '$' at the diagnostic position
 *
 * @example
 * // For diagnostic on "if x > 5"
 * // The action inserts "$" before "x" -> "if $x > 5"
 */
function createMissingDollarFix(document, diagnostic) {
  const uri = document.uri;
  const start = diagnostic.range.start;

  return createCodeAction("Insert missing '$'", diagnostic, (edit) => {
    edit.insert(uri, start, "$");
  });
}

/**
 * Creates a quick-fix that replaces invalid boolean operators.
 *
 * This code action appears in the lightbulb menu (💡) when a single
 * '&' or '|' is used instead of '&&' or '||'.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the invalid operator
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 *
 * @example
 * // For diagnostic on "&" -> creates action to replace with "&&"
 */
function createInvalidOperatorFix(document, diagnostic) {
  const text = document.getText(diagnostic.range);
  const replacement = text === "&" ? "&&" : text === "|" ? "||" : null;

  if (!replacement) return null;

  return createCodeAction(`Replace '${text}' with '${replacement}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, replacement);
  });
}

/**
 * Creates a quick-fix that replaces assignment-like '=' with '==' in conditions.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with assignment-like usage
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 */
function createAssignmentInConditionFix(document, diagnostic) {
  const text = document.getText(diagnostic.range);
  if (text !== "=") return null;

  return createCodeAction("Replace '=' with '=='", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, "==");
  });
}

/**
 * Creates a quick-fix that replaces incorrect 'for' loop usage with 'foreach'.
 * Only for the `for $item in @list` form, which then reads as a valid
 * `foreach`; the counting form (`for $i = 1 to 10`) has no `foreach`
 * equivalent, so it gets no fix.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the incorrect 'for' usage
 * @returns {vscode.CodeAction | null} A code action that replaces 'for' with
 *   'foreach', or null for the counting form
 */
function createForToForeachFix(document, diagnostic) {
  const line = document.lineAt(diagnostic.range.start.line).text;
  if (!/^\s*for\s+[$@%]?[A-Za-z](?:[\w-]*[A-Za-z0-9])?\s+in\s/i.test(line)) return null;

  return createCodeAction("Replace 'for' with 'foreach'", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, 'foreach');
  });
}

/**
 * Creates a quick-fix that replaces a template block terminator keyword
 * (`<% end %>`, `<% endforeach %>`, ...) with `}`, so it becomes `<% } %>`.
 * The diagnostic range covers exactly the keyword token.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The `template-end-keyword` diagnostic
 * @returns {vscode.CodeAction} A code action that replaces the keyword with `}`
 */
function createTemplateEndFix(document, diagnostic) {
  return createCodeAction("Replace with '}'", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, "}");
  });
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
 * Picks the closest known namespace to `token`: an exact case-insensitive match
 * wins (canonical casing), otherwise the smallest edit distance within a small
 * threshold. Returns null when nothing is close enough to suggest.
 *
 * @param {string} token - The unrecognized namespace as written
 * @returns {string | null}
 */
function nearestNamespace(token) {
  const lower = token.toLowerCase();
  /** @type {string | null} */
  let best = null;
  let bestDistance = Infinity;
  for (const known of NAMESPACES) {
    if (known.toLowerCase() === lower) return known;
    const d = editDistance(lower, known.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  // Only suggest when it is a plausible typo, not an unrelated word.
  return bestDistance <= Math.max(2, Math.ceil(token.length / 3)) ? best : null;
}

/**
 * Creates a quick-fix that replaces an unknown namespace token with the closest
 * known one (`Frobnicate::Op` -> `Firewall::Op`, `proget::Op` -> `ProGet::Op`).
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The unknown-namespace diagnostic; its
 *   range covers exactly the namespace token (no `::`)
 * @returns {vscode.CodeAction | null} Code action, or null when nothing is close
 */
function createUnknownNamespaceFix(document, diagnostic) {
  const token = document.getText(diagnostic.range);
  const suggestion = nearestNamespace(token);
  if (!suggestion || suggestion === token) return null;

  return createCodeAction(`Change namespace to '${suggestion}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, suggestion);
  });
}

// ============================================================
// UNBALANCED SYMBOLS
// ============================================================

/**
 * Creates a diagnostic for unbalanced symbols.
 * @param {number} count - Current count (positive = unclosed, negative = extra closing)
 * @param {number} lastPos - Document offset of the symbol to report: the
 *   outermost still-open opener when `count > 0`, or the extra closer when
 *   `count < 0`
 * @param {string} openChar - Opening character ('{', '(', '[')
 * @param {string} closeChar - Closing character ('}', ')', ']')
 * @param {string} name - Display name ('brace', 'parenthesis', 'bracket')
 * @param {vscode.TextDocument} document - The document
 * @returns {vscode.Diagnostic | null}
 */
function createUnbalancedDiagnostic(count, lastPos, openChar, closeChar, name, document) {
  if (count === 0) return null;

  const pos = document.positionAt(lastPos);
  const lineNum = pos.line + 1;
  const colNum = pos.character + 1;
  const message = count > 0
    ? `Unclosed ${name}(s): ${count} '${openChar}' not closed (first at line ${lineNum}, col ${colNum})`
    : `Unexpected closing ${name}: Extra '${closeChar}' at line ${lineNum}, col ${colNum}`;

  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(pos, document.positionAt(lastPos + 1)),
    message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.code = "unbalanced-symbol";
  diagnostic.source = "OtterScript";
  return diagnostic;
}

// ============================================================
// FOLDING RANGES
// ============================================================

/**
 * Computes folding ranges for an OtterScript document.
 *
 * Folds `{ }` blocks, multi-line `%( )` / `@( )` literals, multi-line `<% %>`
 * tags, `#region` / `#endregion` pairs, block comments, and swim-strings.
 *
 * Reuses the same `maskNonCodeSpans` pass as diagnostics, so folding respects
 * strings, swim-strings, and block comments identically to every other feature
 * in the extension — braces inside a string or a swim-string body are never
 * treated as fold boundaries.
 *
 * @param {vscode.TextDocument} document
 * @returns {vscode.FoldingRange[]}
 */
function computeFoldingRanges(document) {
  /** @type {vscode.FoldingRange[]} */
  const ranges = [];
  const braceStack = [];
  const regionStack = [];
  const templateTagStack = [];
  const mapStack = [];   // { line, depthAtOpen } for %(...) / @(... ) literals
  let parenDepth = 0;    // carried across lines — map bodies can span multiple lines
  let blockCommentStart = -1;
  let swimStart = -1;
  const state = createCodeScanState();

  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
    const rawLine = document.lineAt(lineIndex).text;
    const wasInBlockComment = state.inBlockComment;
    const wasInSwim = !!state.swimDelimiter;
    const wasMidStringOrSwim = state.inString || wasInSwim;

    if (!wasInBlockComment && !wasMidStringOrSwim) {
      if (/^\s*#region\b/i.test(rawLine)) {
        regionStack.push(lineIndex);
      } else if (/^\s*#endregion\b/i.test(rawLine) && regionStack.length > 0) {
        const start = regionStack.pop();
        if (start !== undefined && lineIndex > start) {
          ranges.push(new vscode.FoldingRange(start, lineIndex, vscode.FoldingRangeKind.Region));
        }
      }
    }

    const maskedLine = maskNonCodeSpans(rawLine, state);

    // -- Block comments
    if (!wasInBlockComment && state.inBlockComment) {
      blockCommentStart = lineIndex;
    } else if (wasInBlockComment && !state.inBlockComment && blockCommentStart !== -1) {
      if (lineIndex > blockCommentStart) {
        ranges.push(new vscode.FoldingRange(blockCommentStart, lineIndex, vscode.FoldingRangeKind.Comment));
      }
      blockCommentStart = -1;
    }

    // -- Swim-strings (e.g. >END>...multi-line body...>END>)
    if (!wasInSwim && state.swimDelimiter) {
      swimStart = lineIndex;
    } else if (wasInSwim && !state.swimDelimiter && swimStart !== -1) {
      if (lineIndex > swimStart) {
        ranges.push(new vscode.FoldingRange(swimStart, lineIndex, vscode.FoldingRangeKind.Region));
      }
      swimStart = -1;
    }

    // -- <% %> template tags (multi-line tags only; brace folding still applies
    //    inside tags). Delimiter detection is shared with diagnostics via
    //    scanner.findTemplateTagDelimiters.
    for (const delim of findTemplateTagDelimiters(maskedLine)) {
      if (delim.open) {
        templateTagStack.push(lineIndex);
      } else {
        const start = templateTagStack.pop();
        if (start !== undefined && lineIndex > start) {
          ranges.push(new vscode.FoldingRange(start, lineIndex, vscode.FoldingRangeKind.Region));
        }
      }
    }

    // -- Braces
    for (let col = 0; col < maskedLine.length; col++) {
      const ch = maskedLine[col];
      if (ch === "{") {
        braceStack.push(lineIndex);
      } else if (ch === "}") {
        const start = braceStack.pop();
        if (start !== undefined && lineIndex > start) {
          ranges.push(new vscode.FoldingRange(start, lineIndex, vscode.FoldingRangeKind.Region));
        }
      } else if (ch === "(") {
        if (col > 0 && (maskedLine[col - 1] === "%" || maskedLine[col - 1] === "@")) {
          mapStack.push({ line: lineIndex, depthAtOpen: parenDepth });
        }
        parenDepth++;
      } else if (ch === ")") {
        const prevDepth = parenDepth;
        if (parenDepth > 0) parenDepth--;
        if (prevDepth > 0 && mapStack.length > 0 && mapStack[mapStack.length - 1].depthAtOpen === parenDepth) {
          const popped = mapStack.pop();
          if (popped !== undefined && lineIndex > popped.line) {
            ranges.push(new vscode.FoldingRange(popped.line, lineIndex, vscode.FoldingRangeKind.Region));
          }
        }
      }
    }
  }

  return ranges;
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
  clearTimerForUri,

  // -- Helpers
  isReadOnlyView,
  isValidCompletionPosition,
  getTypedIdentifier,
  isInStringOrCommentDoc,
  getActiveParameterIndex,
  splitSignatureParameters,
  maskClosedGroups,
  checkMissingDollar,
  findDuplicateMapKeyDiagnosticsFromMasked,
  findArgumentCountDiagnosticsFromMasked,
  validateDocs,
  createUnbalancedDiagnostic,
  getDiagnosticCode,
  computeFoldingRanges,

  // -- Builders
  buildHoverMarkdown,
  buildCompletionItem,
  buildSigilCompletionItems,

  // -- Code Actions
  createMissingDollarFix,
  createInvalidOperatorFix,
  createAssignmentInConditionFix,
  createForToForeachFix,
  createUnknownNamespaceFix,
  createTemplateEndFix,
  editDistance,
  lookupOwn,
  nearestNamespace,

  // -- Module navigation
  MODULE_NAME_TOKEN_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  getModuleDeclarations,
  findModuleDeclarations,
  getModuleNameAt,
  getVariableOccurrences,
  createCodeScanState,
  createTemplateScanState,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
  documentUsesTemplateTags,
  // findTemplateTagDelimiters (used by computeFoldingRanges) and
  // isInStringOrComment (used by isInStringOrCommentDoc) are imported from
  // ./scanner above but not re-exported -- no external caller needs them here.
  findModuleDeclarationRange,
  getModuleCallReferencesByName,
  clearDocumentCaches,
  findModuleReferences,

  // -- Regex
  createRegexPatterns,
  scheduleTimerForUri,
  mapWithConcurrency
};
