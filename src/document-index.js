// @ts-check
/**
 * @fileoverview Per-document indexes over an open OtterScript document, each
 * cached per document version: module declarations and `call` references,
 * variable occurrences, and the scan state at the start of every line (for
 * telling whether a position is in a string or comment). Used by the
 * navigation, completion and hover providers; extension.js drops a document's
 * entries when it closes ({@link clearDocumentCaches}).
 *
 * @module document-index
 */

const vscode = require("vscode");
const {
  advanceScanState,
  BRACED_NAME_PATTERN,
  createCodeScanState,
  findModuleDeclarations,
  indexVariableOccurrences,
  isInStringOrComment,
  isModuleCallContext,
  isModuleDeclarationContext,
  maskNonCodeSpans,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  MODULE_NAME_TOKEN_REGEX,
  NAME_PATTERN,
  parseModuleParameters,
  variableKey,
} = require("./scanner");
const { lookupOperation, operationArguments, operationForms } = require("./language-data");

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
 * The key a module name is compared by: names are case-insensitive, as
 * variable names are (`call greet` calls `module Greet`).
 *
 * @param {string} name
 * @returns {string}
 */
function moduleKey(name) {
  return name.toLowerCase();
}

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
 *   `refsByName` is keyed by {@link moduleKey}.
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

      const existing = refsByName.get(moduleKey(moduleName));
      if (existing) {
        existing.push(location);
      } else {
        refsByName.set(moduleKey(moduleName), [location]);
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
  const declaration = declarations.find(entry => moduleKey(entry.name) === moduleKey(moduleName));
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
 * @returns {Map<string, vscode.Location[]>} Keyed by {@link moduleKey}
 */
function getModuleCallReferencesByName(document, allowedModuleNames) {
  const { refsByName } = getModuleInfo(document);
  if (!allowedModuleNames) {
    return refsByName;
  }

  /** @type {Map<string, vscode.Location[]>} */
  const filtered = new Map();
  for (const moduleName of allowedModuleNames) {
    const refs = refsByName.get(moduleKey(moduleName));
    if (refs) {
      filtered.set(moduleKey(moduleName), refs);
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
  return getVariableIndex(document).get(variableKey(sigil, name)) ?? [];
}

/**
 * The document's variable index ({@link indexVariableOccurrences}), from the
 * per-version cache.
 *
 * @param {vscode.TextDocument} document
 * @returns {Map<string, import("./scanner").VariableOccurrence[]>}
 */
function getVariableIndex(document) {
  const cacheKey = document.uri.toString();
  let cached = variableIndexCache.get(cacheKey);
  if (!cached || cached.version !== document.version) {
    cached = { version: document.version, index: indexVariableOccurrences(document.getText()) };
    variableIndexCache.set(cacheKey, cached);
  }
  return cached.index;
}

/**
 * A `$name` / `@name` / `%name` token, or its braced `${name}` form (whose
 * name may contain spaces), per Inedo's variable-name rules.
 */
const VARIABLE_AT_CURSOR_REGEX = new RegExp(String.raw`[$@%](?:\{${BRACED_NAME_PATTERN}\}|${NAME_PATTERN})`);

/**
 * The variable token under the cursor, with every occurrence of that
 * variable in the document. `isReference` is false when the token isn't a
 * real reference -- in a comment or single-quoted string, or a function
 * call's name -- so callers can stop there instead of trying other symbols.
 * Used by highlighting and Go to Definition.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{ sigil: string, name: string, range: vscode.Range, isReference: boolean, occurrences: import("./scanner").VariableOccurrence[] } | null}
 *   null when no variable token is under the cursor
 */
function getVariableAt(document, position) {
  const range = document.getWordRangeAtPosition(position, VARIABLE_AT_CURSOR_REGEX);
  if (!range) return null;
  const token = document.getText(range);
  const name = token[1] === "{" ? token.slice(2, -1) : token.slice(1);
  const occurrences = getVariableOccurrences(document, token[0], name);
  const isReference = occurrences.some((o) => o.line === range.start.line && o.character === range.start.character);
  return { sigil: token[0], name, range, isReference, occurrences };
}

/**
 * The distinct variables of one sigil used in a document, for completion:
 * each with the name as first written (the first assignment, else the first
 * use), whether the document assigns it, and that line.
 *
 * @param {vscode.TextDocument} document
 * @param {string} sigil - `$`, `@`, or `%`
 * @returns {{ name: string, assigned: boolean, line: number, occurrences: import("./scanner").VariableOccurrence[] }[]}
 */
function getDocumentVariables(document, sigil) {
  const result = [];
  for (const [key, occurrences] of getVariableIndex(document)) {
    if (key[0] !== sigil || occurrences.length === 0) continue;
    const first = occurrences.find((o) => o.write) ?? occurrences[0];
    const token = document.lineAt(first.line).text.slice(first.character, first.character + first.length);
    const name = token[1] === "{" ? token.slice(2, -1) : token.slice(1);
    result.push({ name, assigned: first.write, line: first.line, occurrences });
  }
  return result;
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
    const declaration = declarations.find(entry => moduleKey(entry.name) === moduleKey(moduleName));
    if (declaration) {
      locations.push(new vscode.Location(document.uri, declaration.range));
    }
  }

  const callRefs = refsByName.get(moduleKey(moduleName));
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

/** How far back {@link getMaskedTextBefore} looks: plenty for one statement. */
const MASKED_PREFIX_MAX_LINES = 200;

/**
 * The code before `position`, from up to {@link MASKED_PREFIX_MAX_LINES}
 * lines back, with strings and comments masked ({@link maskNonCodeSpans}) --
 * for finding the call the cursor is in.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {string}
 */
function getMaskedTextBefore(document, position) {
  const first = Math.max(0, position.line - MASKED_PREFIX_MAX_LINES);
  const state = getLineStartScanState(document, first);
  const lines = [];
  for (let line = first; line <= position.line; line++) {
    const text = document.lineAt(line).text;
    lines.push(maskNonCodeSpans(line === position.line ? text.slice(0, position.character) : text, state));
  }
  return lines.join("\n");
}

/**
 * The code from `position` on, to up to {@link MASKED_PREFIX_MAX_LINES}
 * lines further, masked like {@link getMaskedTextBefore} -- for the rest of
 * the call the cursor is in.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {string}
 */
function getMaskedTextAfter(document, position) {
  const state = getLineStartScanState(document, position.line);
  const first = document.lineAt(position.line).text;
  maskNonCodeSpans(first.slice(0, position.character), state);
  const lines = [maskNonCodeSpans(first.slice(position.character), state)];
  const last = Math.min(document.lineCount - 1, position.line + MASKED_PREFIX_MAX_LINES);
  for (let line = position.line + 1; line <= last; line++) {
    lines.push(maskNonCodeSpans(document.lineAt(line).text, state));
  }
  return lines.join("\n");
}

/**
 * Where the module a `call` in `document` names is declared: in `document`
 * itself, or else in the one workspace file that declares it (as Go to
 * Definition resolves it). Null when no file or several other files do.
 *
 * @param {vscode.TextDocument} document
 * @param {string} name
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules
 * @returns {Promise<{ document: vscode.TextDocument, range: vscode.Range } | null>}
 */
async function resolveModule(document, name, listWorkspaceModules) {
  const local = findModuleDeclarationRange(document, name);
  if (local) return { document, range: local };
  const elsewhere = (await listWorkspaceModules()).filter((m) => moduleKey(m.name) === moduleKey(name));
  if (elsewhere.length !== 1) return null;
  const home = await vscode.workspace.openTextDocument(elsewhere[0].uri);
  const range = findModuleDeclarationRange(home, name);
  return range ? { document: home, range } : null;
}

/** How many lines a module's `< ... >` parameter list may span. */
const MODULE_HEADER_MAX_LINES = 50;

/**
 * The parameters of the module declared at `range` (see
 * {@link parseModuleParameters}).
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} range - The declaration's name
 * @returns {import("./scanner").ModuleParameter[]}
 */
function getModuleParameters(document, range) {
  const first = range.start.line;
  const last = Math.min(document.lineCount - 1, first + MODULE_HEADER_MAX_LINES);
  const state = getLineStartScanState(document, first);
  const lines = [];
  for (let line = first; line <= last; line++) lines.push(maskNonCodeSpans(document.lineAt(line).text, state));
  return parseModuleParameters(lines.join("\n"));
}

/**
 * The arguments the call in `context` takes: an operation's from its docs
 * (see `operationArguments`; a same-named operation's callee is shown with
 * its namespace, `DotNet::Build`), a module's from its declaration (see {@link resolveModule}), in the
 * shape of an operation's `params` -- a module parameter's `format` is how
 * it's declared (`$path`, `out $result`). Null when the callee is unknown or
 * is a module in another raft (`call Raft::Name`).
 *
 * @param {vscode.TextDocument} document
 * @param {import("./scanner").OperationArgumentContext} context
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules
 * @returns {Promise<{ callee: string, params: { name: string, required: boolean, format?: string, description?: string }[] } | null>}
 */
async function findCallArguments(document, context, listWorkspaceModules) {
  if (!context.module) {
    const doc = lookupOperation(context.operation, context.namespace);
    const params = operationArguments(context.operation, context.namespace);
    if (!doc || !params) return null;
    const qualified = context.namespace && operationForms(context.operation).length > 1;
    return { callee: qualified ? `${doc.namespace ?? "Core"}::${doc.name}` : doc.name, params };
  }
  if (context.namespace) return null;
  const resolved = await resolveModule(document, context.operation, listWorkspaceModules);
  if (!resolved) return null;
  return {
    callee: `module ${context.operation}`,
    params: getModuleParameters(resolved.document, resolved.range).map((p) => ({
      name: p.name,
      required: !p.optional,
      format: `${p.direction === "in" ? "" : `${p.direction} `}${p.sigil}${p.name}`,
    })),
  };
}

module.exports = {
  clearDocumentCaches,
  findCallArguments,
  findModuleDeclarationRange,
  findModuleReferences,
  getDocumentVariables,
  getMaskedTextAfter,
  getMaskedTextBefore,
  getModuleCallReferencesByName,
  getModuleDeclarations,
  getModuleNameAt,
  getModuleParameters,
  getVariableAt,
  getVariableOccurrences,
  isInStringOrCommentDoc,
  moduleKey,
  resolveModule,
};
