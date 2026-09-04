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
  maskNonCodeSpans,
  advanceScanState,
  isInStringOrComment,
  getActiveParameterIndex,
  stripStrings,
  MODULE_NAME_TOKEN_REGEX,
  MODULE_DECLARATION_REGEX,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
} = require("./scanner");

// Namespace allowlist — the single source of truth lives with the data it
// describes. Plain data module, no vscode dependency.
const { NAMESPACES } = require("./language-data");

// ============================================================
// CONFIGURATION
// ============================================================

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
 *   codeLensEnabled: boolean
 * }}
 *
 * @example
 * // .vscode/settings.json
 * // {
 * //   "otterscript.completion.enable": false,
 * //   "otterscript.hover.enable": true
 * // }
 */
function loadConfig() {
  const config = vscode.workspace.getConfiguration("otterscript");

  return {
    completionEnabled: config.get("completion.enable", true),
    hoverEnabled: config.get("hover.enable", true),
    signatureHelpEnabled: config.get("signatureHelp.enable", true),
    codeLensEnabled: config.get("codeLens.enable", true)
  };
}

// ============================================================
// CONSTANTS
// ============================================================

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
 * Returns current time formatted as HH:MM:SS.
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
 * Centralized logger for OtterScript Language extension.
 *
 * @example
 * log.info('Extension activated');
 * log.warn('Missing documentation field');
 * log.error('Failed to load docs', err);
 * log.debug('Processing line', lineIndex);
 */
const log = {
  /** @param {...any} args - @example log.info('Extension activated') */
  info: (...args) => {
    const now = timestamp();
    console.log(LOGPREFIX, `[${now}]`, ...args);
    appendOutputLine(`[${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - @example log.warn('Missing field') */
  warn: (...args) => {
    const now = timestamp();
    console.warn(LOGPREFIX, `[${now}]`, ...args);
    appendOutputLine(`⚠️ [${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - @example log.error('Failed', err) */
  error: (...args) => {
    const now = timestamp();
    console.error(LOGPREFIX, `[${now}]`, ...args);
    appendOutputLine(`❌ [${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - @example log.debug('Processing', lineIndex) */
  debug: (...args) => {
    const now = timestamp();
    // Debug logs go to console only - intentionally excluded from Output Channel
    // to avoid flooding the user-visible log with internal diagnostics.
    console.debug(LOGPREFIX, `[${now}]`, '[DEBUG]', ...args);
  }
};

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

/** @type {Readonly<Record<"$" | "@", RegExp>>} */
const TYPED_IDENTIFIER_PATTERNS = Object.freeze({
  "$": /\$([a-zA-Z]*)$/,
  "@": /@([a-zA-Z]*)$/,
});

/**
 * Extracts the currently typed identifier after a trigger character.
 *
 * Examples:
 * - "$To" -> "To"
 * - "@Spl" -> "Spl"
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {"$" | "@"} triggerChar
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
 * // Returns: /\b(Log-Information|Log-Error)\b/
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
 * @param {Set<string>} knownOperations - Set of operation names
 * @returns {{
 *   scalarCallRegex: () => RegExp,
 *   vectorCallRegex: () => RegExp,
 *   operationCallRegex: () => RegExp,
 *   scalarSignatureRegex: () => RegExp,
 *   vectorSignatureRegex: () => RegExp,
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
    // Group 1: operation name. Group 2: argument text typed so far (cursor at end).
    // The optional segment after the name allows one default/positional argument
    // between the name and the "(" -- a quoted string or a single bare token --
    // e.g. `ProGet::Create-Directory my/folder/path\n(`. It deliberately excludes
    // whitespace and "=" so it cannot swallow an assignment like `set $x = (`.
    operationSignatureRegex: () => /(?:^|\s)(?:[A-Za-z][\w-]*::)?([A-Za-z][A-Za-z-]*)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s(){};=]+))?\s*\(([^()]*)$/,
    operationRegex: () => buildWordRegex(knownOperations),
  };
}

/**
 * @typedef {{ name: string, range: vscode.Range, lineRange: vscode.Range }} ModuleDeclaration
 */

/**
 * @typedef {{
 *   version: number,
 *   declarations: ModuleDeclaration[],
 *   refsByName: Map<string, vscode.Location[]>
 * }} ModuleInfoCacheEntry
 */

/** @type {Map<string, ModuleInfoCacheEntry>} */
const moduleInfoCache = new Map();

/**
 * Carried scanning state for cross-line constructs. Defined in {@link module:scanner};
 * aliased here so JSDoc in this file can refer to it.
 *
 * @typedef {import("./scanner").CodeScanState} CodeScanState
 */

/**
 * Scans a document and returns all module declarations.
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

  /** @type {ModuleDeclaration[]} */
  const declarations = [];
  /** @type {Map<string, vscode.Location[]>} */
  const refsByName = new Map();
  const scanState = createCodeScanState();

  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    const maskedLineText = maskNonCodeSpans(lineText, scanState);

    const declMatch = MODULE_DECLARATION_REGEX.exec(maskedLineText);
    if (declMatch) {
      const name = declMatch[1];
      const nameStart = maskedLineText.indexOf(name, declMatch.index);
      const range = new vscode.Range(
        new vscode.Position(line, nameStart),
        new vscode.Position(line, nameStart + name.length)
      );

      declarations.push({ name, range, lineRange: document.lineAt(line).range });
    }

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
 * Clears cached module info for a document URI.
 *
 * @param {import('vscode').Uri} uri
 * @returns {void}
 */
function clearModuleInfoCache(uri) {
  moduleInfoCache.delete(uri.toString());
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
  const state = createCodeScanState();

  // Use advanceScanState (not maskNonCodeSpans) for preceding lines — we only
  // need the state side-effect and want to avoid the split/join allocations.
  for (let i = 0; i < position.line; i++) {
    advanceScanState(document.lineAt(i).text, state);
  }

  return isInStringOrComment(
    document.lineAt(position.line).text,
    position.character,
    state
  );
}

// ============================================================
// HOVER & COMPLETION BUILDERS
// ============================================================

/**
 * Builds a standardised hover MarkdownString from a documentation entry.
 *
 * This creates the formatted tooltip content shown when hovering over
 * symbols, keywords, operations, and syntax elements.
 *
 * @param {Readonly<{ name: string, signature?: string, description?: string, documentation?: string, namespace?: string | null }>} doc
 *   - name: Required - Display name (e.g., "$ToJson")
 *   - signature: Optional - Function signature (monospace formatted)
 *   - description: Optional - Short description
 *   - documentation: Optional - Extended Markdown documentation
 *   - namespace: Optional - Owning OtterScript namespace (shown as provenance)
 * @param {boolean} [isTrusted=false] - Set true to allow command URIs in Markdown.
 * Currently unused; reserved for future use.
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
function buildHoverMarkdown(doc, isTrusted = false) {
  const md = new vscode.MarkdownString();

  // Heading (### is h3 in Markdown, renders bold in VS Code)
  md.appendMarkdown(`### ${doc.name}\n\n`);

  // Signature (monospace for code clarity)
  if (doc.signature) {
    md.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
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

  // true would allow richer formatting, but we set the default to false
  md.isTrusted = isTrusted;

  return md;
}

/**
 * Builds a completion item with consistent formatting.
 *
 * This centralizes completion item creation to ensure all providers
 * produce consistent UI elements (labels, details, documentation, sorting).
 *
 * @param {import('../src/language-data.js').DocEntry} doc - Documentation object
 * @param {vscode.CompletionItemKind} kind - Item kind (Function, Variable, Keyword, etc.)
 * @param {string} sortPrefix - Sort order prefix (e.g., "0_" for operations, "1_" for functions)
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
 * Checks for missing '$' before variable names in if conditions.
 *
 * @param {string} line - The raw line of code
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
 * Finds duplicate keys inside map expressions and returns diagnostics.
 *
 * Thin convenience wrapper around {@link findDuplicateMapKeyDiagnosticsFromMasked}
 * for callers that only have raw source text (e.g. tests, or any future caller
 * that hasn't already masked the document). It masks `source` here using the
 * same `CodeScanState`/`maskNonCodeSpans` scanner as `diagnostics.js` and every
 * other feature, so strings, comments, AND swim-strings are masked identically
 * everywhere in the extension — map-shaped text inside a swim-string body no
 * longer produces a false duplicate-key warning.
 *
 * Prefer {@link findDuplicateMapKeyDiagnosticsFromMasked} directly when the
 * caller already has a masked copy of the document, to avoid masking the
 * whole document a second time.
 *
 * @param {vscode.TextDocument} document - Document to analyze
 * @param {string} [source] - Optional pre-fetched raw document text; defaults
 *   to `document.getText()`
 * @returns {vscode.Diagnostic[]} Duplicate-key diagnostics
 */
function findDuplicateMapKeyDiagnostics(document, source = document.getText()) {
  const scanState = createCodeScanState();
  const maskedText = source.split("\n").map(line => maskNonCodeSpans(line, scanState)).join("\n");
  return findDuplicateMapKeyDiagnosticsFromMasked(document, maskedText);
}

/**
 * Finds duplicate keys inside map expressions and returns diagnostics, given
 * text that has ALREADY been masked by {@link maskNonCodeSpans}.
 *
 * This performs a best-effort scan of `%(... )` blocks and warns when the
 * same key appears more than once at the top level of a map. Callers that
 * already have a masked copy of the document on hand (e.g. `updateDiagnostics`,
 * which masks every line during its own scan) should call this directly to
 * avoid masking the whole document a second time. Callers that only have raw
 * source text should use {@link findDuplicateMapKeyDiagnostics} instead, which
 * masks first and then delegates here.
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
   * Finds the matching ')' for an opening '(' position.
   *
   * @param {number} openParenIndex - Index of opening '('
   * @returns {number} Matching ')' index, or -1 when not found
   */
  function findMatchingParen(openParenIndex) {
    let depth = 1;
    for (let i = openParenIndex + 1; i < maskedText.length; i++) {
      if (maskedText[i] === '(') depth++;
      if (maskedText[i] === ')') depth--;
      if (depth === 0) return i;
    }
    return -1;
  }

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

  for (let i = 0; i < maskedText.length - 1; i++) {
    if (maskedText[i] === '%' && maskedText[i + 1] === '(') {
      const close = findMatchingParen(i + 1);
      if (close !== -1) {
        scanMapBody(i + 2, close);
        i = close;
      }
    }
  }

  return issues;
}

/**
 * Gets the diagnostic code as a string.
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
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the incorrect 'for' usage
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 */
function createForToForeachFix(document, diagnostic) {
  return createCodeAction("Replace 'for' with 'foreach'", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, 'foreach');
  });
}

/**
 * Levenshtein edit distance between two short strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 * @private
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
 * @param {string} token - The unrecognised namespace as written
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

/**
 * Creates a diagnostic for unbalanced symbols.
 * @param {number} count - Current count (positive = unclosed, negative = extra closing)
 * @param {number} lastPos - Position of last unmatched symbol
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
  diagnostic.source = "OtterScript";
  return diagnostic;
}

/**
 * Computes folding ranges for an OtterScript document.
 *
 * Reuses the same CodeScanState/scanLineState masking pass as diagnostics,
 * so folding respects strings, swim-strings, and block comments identically
 * to every other feature in the extension — braces inside a string or a
 * swim-string body are never treated as fold boundaries.
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

    // -- <% %> template tags (multi-line tags only; brace folding still applies inside tags)
    let searchIndex = 0;
    while (true) {
      const openIdx = maskedLine.indexOf("<%", searchIndex);
      const closeIdx = maskedLine.indexOf("%>", searchIndex);
      if (openIdx === -1 && closeIdx === -1) break;

      if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
        templateTagStack.push(lineIndex);
        searchIndex = openIdx + 2;
      } else {
        const start = templateTagStack.pop();
        if (start !== undefined && lineIndex > start) {
          ranges.push(new vscode.FoldingRange(start, lineIndex, vscode.FoldingRangeKind.Region));
        }
        searchIndex = closeIdx + 2;
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
  isValidCompletionPosition,
  getTypedIdentifier,
  isInStringOrComment,
  isInStringOrCommentDoc,
  getActiveParameterIndex,
  stripStrings,
  checkMissingDollar,
  findDuplicateMapKeyDiagnostics,
  findDuplicateMapKeyDiagnosticsFromMasked,
  validateDocs,
  createUnbalancedDiagnostic,
  getDiagnosticCode,
  computeFoldingRanges,

  // -- Builders
  buildHoverMarkdown,
  buildCompletionItem,

  // -- Code Actions
  createMissingDollarFix,
  createInvalidOperatorFix,
  createAssignmentInConditionFix,
  createForToForeachFix,
  createUnknownNamespaceFix,
  nearestNamespace,

  // -- Module navigation
  MODULE_NAME_TOKEN_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  getModuleDeclarations,
  createCodeScanState,
  maskNonCodeSpans,
  findModuleDeclarationRange,
  getModuleCallReferencesByName,
  clearModuleInfoCache,
  findModuleReferences,

  // -- Regex
  createRegexPatterns,
  scheduleTimerForUri
};
