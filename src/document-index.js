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
  createTemplateScanState,
  documentUsesTemplateTags,
  findExecutionDirectives,
  findModuleDeclarations,
  indexVariableOccurrences,
  isInStringOrComment,
  isModuleCallContext,
  isModuleDeclarationContext,
  maskNonCodeSpans,
  maskOutsideTemplateTags,
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
 * Per-document `with` directives and `await` statements
 * ({@link getExecutionDirectives}), keyed by `uri.toString()`.
 * @type {Map<string, { version: number, index: ExecutionDirectiveIndex }>}
 */
const executionDirectiveCache = new Map();

/**
 * A module declared in a workspace file: its name, file and name range
 * (from the workspace module index, workspace-symbols.js).
 *
 * @typedef {{ name: string, uri: vscode.Uri, range: vscode.Range }} WorkspaceModule
 */

/**
 * Every module declared in the workspace, building the index on first use
 * (`listModules` of workspace-symbols.js). Passed to the providers that
 * resolve a `call` in another file.
 *
 * @typedef {() => Promise<WorkspaceModule[]>} ListWorkspaceModules
 */

/**
 * Carried scanning state for cross-line constructs. Defined in {@link module:scanner};
 * aliased here so JSDoc in this file can refer to it.
 *
 * @typedef {import("./scanner").CodeScanState} CodeScanState
 */

/**
 * The scan state on entering a line: `code` for the OtterScript, and -- in a
 * text template (see `documentUsesTemplateTags`) -- `tags`, whether the line
 * starts inside a `<% %>` tag, for blanking the literal output around the
 * tags first ({@link codeView}). `tags` is null outside a template.
 *
 * @typedef {{ code: CodeScanState, tags: import("./scanner").TemplateScanState | null }} LineScanState
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
  // lives in exactly one place (`findModuleDeclarations` in scanner.js).
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

    // matchAll works on a copy of the regex, so its lastIndex needs no reset.
    for (const callMatch of maskedLineText.matchAll(MODULE_CALL_TARGET_GLOBAL_REGEX)) {
      const moduleName = callMatch[1];
      const start = /** @type {number} */ (callMatch.index) + callMatch[0].indexOf(moduleName);
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
 * The document's module call references, by module name (from the cached
 * module analysis; the caller must not change the map).
 *
 * @param {vscode.TextDocument} document
 * @returns {ReadonlyMap<string, vscode.Location[]>} Keyed by {@link moduleKey}
 */
function getModuleCallReferencesByName(document) {
  return getModuleInfo(document).refsByName;
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
 * @type {Map<string, { version: number, states: LineScanState[] }>}
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
 * Clears the per-document caches (module info, variable index, line-start
 * scan states and execution directives) for a document URI.
 *
 * @param {import('vscode').Uri} uri
 * @returns {void}
 */
function clearDocumentCaches(uri) {
  moduleInfoCache.delete(uri.toString());
  variableIndexCache.delete(uri.toString());
  lineStartStateCache.delete(uri.toString());
  executionDirectiveCache.delete(uri.toString());
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
  const { code, tags } = getLineStartScanState(document, position.line);
  const text = document.lineAt(position.line).text;
  if (!tags) return isInStringOrComment(text, position.character, code);

  // In a text template, the literal output around the tags isn't code --
  // except a `$` expression in it (`$PackageName`), which the template
  // expands, and a `$` just typed there.
  const before = { inTemplateTag: tags.inTemplateTag, code: { ...tags.code } };
  maskOutsideTemplateTags(text.slice(0, position.character), before);
  const view = codeView(text, tags);
  const kept = (/** @type {number} */ i) => i >= 0 && i < view.length && view[i] !== " ";
  const inExpression = kept(position.character) || kept(position.character - 1) ||
    /\$\{?[\w-]*$/.test(text.slice(0, position.character));
  if (!before.inTemplateTag && !inExpression) return true;
  return isInStringOrComment(view, position.character, code);
}

/**
 * A line as the OtterScript scan sees it: in a text template (`tags` not
 * null) the literal output around the `<% %>` tags is blanked, offsets
 * unchanged, as the diagnostics do (`maskOutsideTemplateTags`); else the line
 * itself.
 *
 * @param {string} text - A whole line
 * @param {import("./scanner").TemplateScanState | null} tags - Mutated in place
 * @returns {string}
 */
function codeView(text, tags) {
  return tags ? maskOutsideTemplateTags(text, tags) : text;
}

/**
 * A copy of a {@link LineScanState} that can be changed without changing it.
 *
 * @param {LineScanState} state
 * @returns {LineScanState}
 */
function copyLineScanState({ code, tags }) {
  return { code: { ...code }, tags: tags && { inTemplateTag: tags.inTemplateTag, code: { ...tags.code } } };
}

/**
 * The scan state on entering `line` (a fresh copy the caller may change).
 * Whether the document is a text template is decided once per version.
 *
 * @param {vscode.TextDocument} document
 * @param {number} line
 * @returns {LineScanState}
 */
function getLineStartScanState(document, line) {
  const cacheKey = document.uri.toString();
  let cached = lineStartStateCache.get(cacheKey);
  if (!cached || cached.version !== document.version) {
    const text = document.getText();
    const template = text.includes("<%") && documentUsesTemplateTags(text);
    cached = { version: document.version, states: [{ code: createCodeScanState(), tags: template ? createTemplateScanState() : null }] };
    lineStartStateCache.set(cacheKey, cached);
  }
  const { states } = cached;
  // Use advanceScanState (not maskNonCodeSpans) for the lines in between: only
  // the state is needed, not the masked text.
  while (states.length <= line) {
    const state = copyLineScanState(states[states.length - 1]);
    advanceScanState(codeView(document.lineAt(states.length - 1).text, state.tags), state.code);
    states.push(state);
  }
  return copyLineScanState(states[line]);
}

/** How far {@link getMaskedTextBefore} looks back, and {@link getMaskedTextAfter} ahead: plenty for one statement. */
const MASKED_CONTEXT_MAX_LINES = 200;

/**
 * The code before `position`, from up to `maxLines` lines back, with
 * strings and comments masked ({@link maskNonCodeSpans}, from the cached
 * scan state at the first line), and in a text template the literal output
 * too ({@link codeView}) -- for finding the call the cursor is in.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {number} [maxLines] - Default {@link MASKED_CONTEXT_MAX_LINES}
 * @returns {string}
 */
function getMaskedTextBefore(document, position, maxLines = MASKED_CONTEXT_MAX_LINES) {
  const first = Math.max(0, position.line - maxLines);
  const { code, tags } = getLineStartScanState(document, first);
  const lines = [];
  for (let line = first; line <= position.line; line++) {
    // The whole line's view, then cut: the literal output's quotes are
    // tracked per line, from its start.
    const text = codeView(document.lineAt(line).text, tags);
    lines.push(maskNonCodeSpans(line === position.line ? text.slice(0, position.character) : text, code));
  }
  return lines.join("\n");
}

/**
 * The code from `position` on, to up to {@link MASKED_CONTEXT_MAX_LINES}
 * lines further, masked like {@link getMaskedTextBefore} -- for the rest of
 * the call the cursor is in.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {string}
 */
function getMaskedTextAfter(document, position) {
  const { code, tags } = getLineStartScanState(document, position.line);
  const first = codeView(document.lineAt(position.line).text, tags);
  maskNonCodeSpans(first.slice(0, position.character), code);
  const lines = [maskNonCodeSpans(first.slice(position.character), code)];
  const last = Math.min(document.lineCount - 1, position.line + MASKED_CONTEXT_MAX_LINES);
  for (let line = position.line + 1; line <= last; line++) {
    lines.push(maskNonCodeSpans(codeView(document.lineAt(line).text, tags), code));
  }
  return lines.join("\n");
}

/**
 * A document's `with` directives and `await` statements, by place.
 *
 * @typedef {{
 *   directives: { name: string, range: vscode.Range, value: string | undefined }[],
 *   asyncBlocks: { token: string, line: number }[],
 *   awaits: { token: string, range: vscode.Range }[]
 * }} ExecutionDirectiveIndex
 *   `directives`: every directive of every `with` header, at its name;
 *   `asyncBlocks`: each `with async=token` block's token and line; `awaits`:
 *   each `await token;` (one without a token isn't listed), at the token.
 */

/**
 * The document's `with` directives and `await` statements
 * ({@link findExecutionDirectives}), cached per version, for completion,
 * hover and the quick fixes. The diagnostics find them in their own masked
 * text.
 *
 * @param {vscode.TextDocument} document
 * @returns {ExecutionDirectiveIndex}
 */
function getExecutionDirectives(document) {
  const cacheKey = document.uri.toString();
  const cached = executionDirectiveCache.get(cacheKey);
  if (cached && cached.version === document.version) return cached.index;

  const last = document.lineCount - 1;
  const masked = getMaskedTextBefore(document, new vscode.Position(last, document.lineAt(last).text.length), document.lineCount);
  /** @type {string[]} */
  const lines = [];
  for (let line = 0; line <= last; line++) lines.push(document.lineAt(line).text);
  const text = lines.join("\n");
  // The offsets are into `text`, whose lines end in "\n" alone (not the
  // document's own line endings), so they're mapped to positions here.
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  /**
   * @param {number} offset
   * @returns {vscode.Position}
   */
  const positionAt = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return new vscode.Position(low, offset - lineStarts[low]);
  };
  /**
   * @param {number} start
   * @param {number} length
   * @returns {vscode.Range}
   */
  const rangeAt = (start, length) => new vscode.Range(positionAt(start), positionAt(start + length));

  const { withs, awaits } = findExecutionDirectives(masked, text);
  /** @type {ExecutionDirectiveIndex} */
  const index = { directives: [], asyncBlocks: [], awaits: [] };
  for (const { start, directives } of withs) {
    for (const { name, nameStart, value } of directives) {
      index.directives.push({ name, range: rangeAt(nameStart, name.length), value });
      if (name.toLowerCase() === "async" && value && !value.startsWith("$")) index.asyncBlocks.push({ token: value, line: positionAt(start).line });
    }
  }
  for (const { token, tokenStart } of awaits) {
    if (token) index.awaits.push({ token, range: rangeAt(tokenStart, token.length) });
  }
  executionDirectiveCache.set(cacheKey, { version: document.version, index });
  return index;
}

/**
 * Where the module a `call` in `document` names is declared: in `document`
 * itself, or else in the one workspace file that declares it (as Go to
 * Definition resolves it). Null when no file or several other files do.
 *
 * @param {vscode.TextDocument} document
 * @param {string} name
 * @param {ListWorkspaceModules} listWorkspaceModules
 * @returns {Promise<{ document: vscode.TextDocument, range: vscode.Range } | null>}
 */
async function resolveModule(document, name, listWorkspaceModules) {
  const local = findModuleDeclarationRange(document, name);
  if (local) return { document, range: local };
  const elsewhere = (await listWorkspaceModules()).filter((m) => moduleKey(m.name) === moduleKey(name));
  if (elsewhere.length !== 1) return null;
  /** @type {vscode.TextDocument} */
  let home;
  try {
    home = await vscode.workspace.openTextDocument(elsewhere[0].uri);
  } catch {
    return null; // deleted or unreadable since it was indexed
  }
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
  const { code, tags } = getLineStartScanState(document, first);
  const lines = [];
  for (let line = first; line <= last; line++) lines.push(maskNonCodeSpans(codeView(document.lineAt(line).text, tags), code));
  return parseModuleParameters(lines.join("\n"));
}

/**
 * The arguments the call in `context` takes: an operation's from its docs
 * (see `operationArguments`; when the call names a namespace and other
 * namespaces have a same-named operation, the callee is shown qualified,
 * `DotNet::Build`), a module's from its declaration (see
 * {@link resolveModule}), in the shape of an operation's `params` -- a
 * module parameter's `format` is how it's declared (`$path`, `out $result`).
 * Null when the callee is unknown or is a module in another raft
 * (`call Raft::Name`).
 *
 * @param {vscode.TextDocument} document
 * @param {import("./scanner").OperationArgumentContext} context
 * @param {ListWorkspaceModules} listWorkspaceModules
 * @returns {Promise<{ callee: string, params: { name: string, required: boolean, format?: string, description?: string, output?: true }[] } | null>}
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
  codeView,
  findCallArguments,
  findModuleDeclarationRange,
  findModuleReferences,
  getDocumentVariables,
  getExecutionDirectives,
  getMaskedTextAfter,
  getMaskedTextBefore,
  getLineStartScanState,
  getModuleCallReferencesByName,
  getModuleDeclarations,
  getModuleNameAt,
  getModuleParameters,
  getVariableAt,
  getVariableOccurrences,
  isInStringOrCommentDoc,
  MASKED_CONTEXT_MAX_LINES,
  moduleKey,
  resolveModule,
};
