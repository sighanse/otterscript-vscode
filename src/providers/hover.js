// @ts-check
/**
 * @fileoverview Hover documentation for OtterScript keywords, operations,
 * functions, variables and syntax (template tags, expression delimiters,
 * swim strings).
 *
 * The hover is found by a chain of resolvers ({@link HOVER_RESOLVERS}), most
 * specific first. Each looks at the position and returns:
 * - `undefined` -- not its kind of thing: the next resolver tries
 * - `null` -- its kind of thing, but no hover (or no hover at all here, such
 *   as inside a string): the chain stops
 * - a `Hover` -- shown, and the chain stops
 */

const vscode = require("vscode");
const { executionDirectiveDocs, keywordDocs, lookupOperation, mapFunctionDocs, operationForms, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const { buildArgumentHoverMarkdown, buildHoverMarkdown, lookupOwn } = require("../helpers");
const {
  findCallArguments,
  getExecutionDirectives,
  getMaskedTextBefore,
  getModuleDeclarations,
  getModuleNameAt,
  getModuleParameters,
  getVariableAt,
  isInStringOrCommentDoc,
  resolveModule,
} = require("../document-index");
const { findOperationArgumentContext, namespaceBefore } = require("../scanner");

/**
 * The code before a word (strings and comments masked) when the word is where
 * a statement starts, so it can be an operation: at the start of the line,
 * or after `;`, `}`, a block's `{` (not a braced variable's `${`) or a
 * template tag's `<%`. The rule the `unknown-operation` diagnostic uses.
 */
const OPERATION_POSITION_REGEX = /(?:^|[;}]|<%|(?<![$@%])\{)\s*$/;

/**
 * What every resolver gets besides the document and position.
 *
 * @typedef {{
 *   product: string,
 *   listWorkspaceModules: import("../document-index").ListWorkspaceModules,
 * }} HoverContext
 *   `product`: the `otterscript.product` setting; `listWorkspaceModules`:
 *   every module declared in the workspace (workspace-symbols.js)
 */

/**
 * One step of the hover chain (see the file overview for what it returns).
 *
 * @typedef {(document: vscode.TextDocument, position: vscode.Position, context: HoverContext) =>
 *   vscode.Hover | null | undefined | Promise<vscode.Hover | null | undefined>} HoverResolver
 */

/**
 * `#region` / `#endregion`: an editor folding marker, not OtterScript syntax
 * (to OtterScript it's a `#` comment). Only at the start of a line, the same
 * rule folding uses -- not inside a string such as `Log "#region";` or a
 * trailing comment. Comes before {@link stopInStringOrComment}, which would
 * take the line for a comment.
 *
 * @type {HoverResolver}
 */
function hoverRegion(document, position, { product }) {
  const regionMatch = /^(\s*)(#(?:end)?region)\b/i.exec(document.lineAt(position.line).text);
  if (!regionMatch) return undefined;
  const start = regionMatch[1].length;
  const end = start + regionMatch[2].length;
  if (position.character < start || position.character > end) return undefined;
  const doc = regionMatch[2].toLowerCase() === "#region" ? syntaxDocs.regionStart : syntaxDocs.regionEnd;
  return new vscode.Hover(buildHoverMarkdown(doc, product), new vscode.Range(position.line, start, position.line, end));
}

/** How many assignment lines a variable's hover shows; the rest are listed by line number. */
const VARIABLE_HOVER_MAX_LINES = 3;
/** How much of an assignment line a variable's hover shows. */
const VARIABLE_HOVER_LINE_LENGTH = 120;

/**
 * Whether a docs table documents this name with this sigil -- a function or
 * runtime variable, which {@link hoverSymbol} shows instead.
 *
 * @param {string} sigil
 * @param {string} name
 * @returns {boolean}
 */
function isDocumentedName(sigil, name) {
  if (sigil === "$") return Boolean(lookupOwn(scalarFunctionDocs, name) ?? lookupOwn(variableDocs, name));
  return Boolean(lookupOwn(sigil === "@" ? vectorFunctionDocs : mapFunctionDocs, name));
}

/**
 * Line numbers as words: `1`, `1 and 3`, `1, 2 and 3`.
 *
 * @param {number[]} lines - 1-based
 * @returns {string}
 */
function listLines(lines) {
  return lines.length === 1 ? `${lines[0]}` : `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
}

/**
 * `lines` as a markdown code block of OtterScript, fenced by more backticks
 * than any run in them, so a line can't end the block early (the text is the
 * file's, which anyone may have written).
 *
 * @param {string[]} lines
 * @returns {string}
 */
function codeBlock(lines) {
  const longest = Math.max(2, ...lines.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}otterscript\n${lines.join("\n")}\n${fence}`;
}

/**
 * What the first assignment says about a variable: a module parameter (with
 * its module, direction and whether it's optional), a loop variable, an
 * operation's output, or a plain variable of the file.
 *
 * @param {vscode.TextDocument} document
 * @param {string} shown - The variable as written, `$x` or `${my var}`
 * @param {string} name - Without its sigil or braces
 * @param {import("../scanner").VariableOccurrence} first - Its first assignment
 * @returns {string} Markdown
 */
function describeAssignment(document, shown, name, first) {
  const line = first.line + 1;
  if (first.assignedBy === "parameter") {
    // The module whose header (which may span lines) this is: the last one
    // declared at or before the parameter.
    const module = getModuleDeclarations(document).filter((m) => m.range.start.line <= first.line).pop();
    const param = module && getModuleParameters(document, module.range).find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (module) {
      const notes = [param && param.direction !== "in" ? param.direction : "", param?.optional && param.direction !== "out" ? "optional" : ""].filter(Boolean);
      return `${inlineCode(shown)}: parameter of module ${inlineCode(module.name)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    }
  }
  if (first.assignedBy === "foreach") return `${inlineCode(shown)}: loop variable of the \`foreach\` on line ${line}`;
  if (first.assignedBy === "output") {
    const argument = /([A-Za-z][\w-]*)\s*=>\s*$/.exec(document.lineAt(first.line).text.slice(0, first.character))?.[1];
    if (argument) return `${inlineCode(shown)}: receives the ${inlineCode(argument)} output on line ${line}`;
  }
  return `${inlineCode(shown)}: variable of this file`;
}

/**
 * A variable of the file itself (not a documented one): how it gets its
 * value, the lines that assign it (up to {@link VARIABLE_HOVER_MAX_LINES}),
 * and how often it's used -- or that the file never assigns it. Before
 * {@link stopInStringOrComment}, as a variable in a string is expanded; the
 * variable index leaves out comments and anything else that isn't one.
 *
 * @type {HoverResolver}
 */
function hoverVariable(document, position) {
  const variable = getVariableAt(document, position);
  if (!variable?.isReference || isDocumentedName(variable.sigil, variable.name)) return undefined;

  const shown = `${variable.sigil}${variable.name.includes(" ") ? `{${variable.name}}` : variable.name}`;
  const writes = variable.occurrences.filter((o) => o.write);
  const uses = variable.occurrences.length - writes.length;
  const used = uses === 0 ? "never used" : uses === 1 ? "used once" : `used ${uses} times`;

  if (!writes.length) {
    return new vscode.Hover(new vscode.MarkdownString(
      `${inlineCode(shown)} isn't assigned in this file: it may come from the caller, a configuration variable or the runtime.\n\n` +
      `${used[0].toUpperCase()}${used.slice(1)}`
    ), variable.range);
  }

  const lines = [...new Set(writes.map((o) => o.line))];
  const shownLines = lines.slice(0, VARIABLE_HOVER_MAX_LINES).map((line) => {
    const text = document.lineAt(line).text.trim();
    return text.length > VARIABLE_HOVER_LINE_LENGTH ? `${text.slice(0, VARIABLE_HOVER_LINE_LENGTH - 1)}…` : text;
  });
  return new vscode.Hover(new vscode.MarkdownString(
    `${describeAssignment(document, shown, variable.name, writes[0])}\n\n` +
    `${codeBlock(shownLines)}\n\n` +
    `Assigned on line${lines.length === 1 ? "" : "s"} ${listLines(lines.map((line) => line + 1))} · ${used}`
  ), variable.range);
}

/**
 * No hover inside a string or comment: the chain stops there.
 *
 * @type {HoverResolver}
 */
function stopInStringOrComment(document, position) {
  return isInStringOrCommentDoc(document, position) ? null : undefined;
}

/**
 * An argument name of an operation or module call -- a name followed by `:`
 * (not `::`) or, for an output, `=>`, where an argument starts: what the
 * argument is, when the call is known. A {@link HoverResolver}.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {HoverContext} context
 * @returns {Promise<vscode.Hover | undefined>}
 */
async function hoverArgument(document, position, { listWorkspaceModules }) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z][\w-]*/);
  if (!range || !/^\s*(?::(?!:)|=>)/.test(document.lineAt(range.end.line).text.slice(range.end.character))) return undefined;
  const context = findOperationArgumentContext(getMaskedTextBefore(document, range.start));
  if (!context || context.typed) return undefined;
  const called = await findCallArguments(document, context, listWorkspaceModules);
  const name = document.getText(range).toLowerCase();
  const param = called?.params.find((p) => p.name.toLowerCase() === name);
  return called && param ? new vscode.Hover(buildArgumentHoverMarkdown(called.callee, param), range) : undefined;
}

/**
 * The module name in a `call`: the module's declaration line and the `#`
 * comment lines right above it -- from this file, or else from the one
 * workspace file that declares it. A module name is never anything else, so
 * the chain stops at one even when it can't be resolved: an unresolved
 * `call Build` or a `module Build` mustn't show the `Build` operation.
 * A {@link HoverResolver}.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {HoverContext} context
 * @returns {Promise<vscode.Hover | null | undefined>}
 */
async function hoverModuleCall(document, position, { listWorkspaceModules }) {
  const moduleAt = getModuleNameAt(document, position);
  if (!moduleAt) return undefined;
  if (moduleAt.isDeclaration) return null;

  const resolved = await resolveModule(document, moduleAt.name, listWorkspaceModules);
  if (!resolved) return null;
  const { document: home, range: declaration } = resolved;

  // The declaration (its parameters spelled out, whatever lines they span),
  // and the comment block right above it.
  const params = getModuleParameters(home, declaration);
  const header = params.length
    ? `module ${moduleAt.name}<${params.map((param) => [
      param.direction === "in" ? "" : `${param.direction} `,
      param.sigil,
      param.name.includes(" ") ? `{${param.name}}` : param.name,
      param.optional && param.direction !== "out" ? " = …" : "",
    ].join("")).join(", ")}>`
    : home.lineAt(declaration.start.line).text.replace(/\{.*$/, "").trim();
  const comment = [];
  for (let line = declaration.start.line - 1; line >= 0; line--) {
    const match = /^\s*#\s?(.*)$/.exec(home.lineAt(line).text);
    if (!match) break;
    comment.unshift(match[1]);
  }

  const md = new vscode.MarkdownString();
  md.appendCodeblock(header, "otterscript");
  // The comment is a workspace file's text, which anyone may have written:
  // appended as plain text (escaped), so a link or image in it isn't
  // rendered. An image would be fetched on hover, and a link could pass for
  // the extension's own. Each line keeps its own line.
  comment.forEach((line, i) => {
    if (i > 0) md.appendMarkdown("  \n");
    md.appendText(line);
  });
  if (comment.length) md.appendMarkdown("\n\n");
  if (home !== document) md.appendMarkdown(`Declared in ${inlineCode(vscode.workspace.asRelativePath(home.uri))}`);
  return new vscode.Hover(md, moduleAt.range);
}

/**
 * A text template's `<%` or `%>` tag.
 *
 * @type {HoverResolver}
 */
function hoverTemplateTag(document, position, { product }) {
  const range = document.getWordRangeAtPosition(position, /<%|%>/);
  if (!range) return undefined;
  const doc = document.getText(range) === "<%" ? syntaxDocs.templateOpen : syntaxDocs.templateClose;
  return new vscode.Hover(buildHoverMarkdown(doc, product), range);
}

/**
 * The opening of a map (`%(`), vector (`@(`) or nested evaluation (`$(`).
 *
 * @type {HoverResolver}
 */
function hoverExpressionDelimiter(document, position, { product }) {
  const range = document.getWordRangeAtPosition(position, /%\(|@\(|\$\(/);
  if (!range) return undefined;
  /** @type {Record<string, import("../language-data").DocEntry>} */
  const docs = { "%(": syntaxDocs.mapExpr, "@(": syntaxDocs.vectorExpr, "$(": syntaxDocs.nestedEval };
  return new vscode.Hover(buildHoverMarkdown(docs[document.getText(range)], product), range);
}

/** The `with` directives by lower-case name. */
const EXECUTION_DIRECTIVES = new Map(Object.values(executionDirectiveDocs).map((d) => [d.name.toLowerCase(), d]));

/**
 * Whether `position` is in `range`, its ends included; ranges here are on
 * one line.
 *
 * @param {vscode.Range} range
 * @param {vscode.Position} position
 * @returns {boolean}
 */
function touches(range, position) {
  return position.line === range.start.line && position.character >= range.start.character && position.character <= range.end.character;
}

/**
 * A `with` block's directive (`retry`, `async`, ...): what it does. Or the
 * token of `await token;`: which `with async=token` blocks it waits for, or
 * that the file has none.
 *
 * @type {HoverResolver}
 */
function hoverExecutionDirective(document, position, { product }) {
  const { directives, asyncBlocks, awaits } = getExecutionDirectives(document);
  const directive = directives.find((d) => touches(d.range, position));
  const doc = directive && EXECUTION_DIRECTIVES.get(directive.name.toLowerCase());
  if (directive && doc) return new vscode.Hover(buildHoverMarkdown(doc, product), directive.range);

  const awaited = awaits.find((a) => touches(a.range, position));
  if (!awaited) return undefined;
  const lines = asyncBlocks.filter((b) => b.token.toLowerCase() === awaited.token.toLowerCase()).map((b) => b.line + 1);
  const block = inlineCode(`with async=${awaited.token}`);
  const markdown = lines.length
    ? `Waits for the ${block} block${lines.length === 1 ? "" : "s"} on line${lines.length === 1 ? "" : "s"} ${listLines(lines)}.`
    : `No ${block} block in this file: waits only for blocks with this token, such as ones a module this file calls starts.`;
  return new vscode.Hover(new vscode.MarkdownString(markdown), awaited.range);
}

/**
 * A keyword (`if`, `foreach`, `with`, `set`, ...), also the two-word
 * `force normal`. A single word may contain dashes, never spaces.
 *
 * @type {HoverResolver}
 */
function hoverKeyword(document, position, { product }) {
  const range = document.getWordRangeAtPosition(position, /\bforce\s+normal\b/)
    ?? document.getWordRangeAtPosition(position, /\b[a-zA-Z]+(?:-[a-zA-Z]+)*\b/);
  const doc = range && lookupOwn(keywordDocs, document.getText(range));
  return range && doc ? new vscode.Hover(buildHoverMarkdown(doc, product), range) : undefined;
}

/**
 * A swim-string delimiter (`>>`, `>==8>`, `>--=>`): OtterScript's string
 * between two identical fish-shaped delimiters.
 *
 * @type {HoverResolver}
 */
function hoverSwimString(document, position, { product }) {
  const range = document.getWordRangeAtPosition(position, />[^>]{0,5}>/);
  return range ? new vscode.Hover(buildHoverMarkdown(syntaxDocs.swimString, product), range) : undefined;
}

/**
 * An operation (`Log-Information`, `Copy-Files`, `PSCall`, ...): a documented
 * name where a statement starts (see {@link OPERATION_POSITION_REGEX}), so
 * not an argument such as `Build` in `Log-Information Build;`. A
 * `Namespace::` before it picks between same-named operations
 * (`DotNet::Build`); without one, the others are listed.
 *
 * @type {HoverResolver}
 */
function hoverOperation(document, position, { product }) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/);
  if (!range) return undefined;
  const lineBefore = getMaskedTextBefore(document, range.start, 0);
  const namespace = namespaceBefore(lineBefore, lineBefore.length);
  const statementBefore = namespace ? lineBefore.slice(0, -(namespace.length + 2)) : lineBefore;
  if (!OPERATION_POSITION_REGEX.test(statementBefore)) return undefined;
  const name = document.getText(range);
  const doc = lookupOperation(name, namespace);
  if (!doc) return undefined;
  const markdown = buildHoverMarkdown(doc, product);
  const others = namespace ? [] : operationForms(name).filter((form) => form !== doc);
  if (others.length) {
    markdown.appendMarkdown(`\n\n---\n\nAlso ${others
      .map((form) => `\`${form.namespace ?? "Core"}::${form.name}\`${form.products ? ` (${form.products.join(", ")})` : ""}`)
      .join(", ")}: write the namespace to pick one.`);
  }
  return new vscode.Hover(markdown, range);
}

/**
 * A documented function or variable after a sigil: `$` a scalar function or
 * runtime variable (functions first), `@` a vector function, `%` a map
 * function. The file's own variables have no docs, so no hover. Last in the
 * chain, as the pattern matches many things.
 *
 * @type {HoverResolver}
 */
function hoverSymbol(document, position, { product }) {
  const range = document.getWordRangeAtPosition(position, /[@$%][A-Za-z][A-Za-z0-9]*/);
  if (!range) return null;
  const text = document.getText(range);
  const name = text.substring(1);
  const doc = text[0] === "$" ? lookupOwn(scalarFunctionDocs, name) ?? lookupOwn(variableDocs, name)
    : text[0] === "@" ? lookupOwn(vectorFunctionDocs, name)
      : lookupOwn(mapFunctionDocs, name);
  return doc ? new vscode.Hover(buildHoverMarkdown(doc, product), range) : null;
}

/**
 * The hover chain, most specific first: the first resolver that doesn't
 * return `undefined` decides.
 *
 * @type {readonly HoverResolver[]}
 */
const HOVER_RESOLVERS = Object.freeze([
  hoverRegion,
  hoverVariable,
  stopInStringOrComment,
  hoverArgument,
  hoverModuleCall,
  hoverExecutionDirective,
  hoverTemplateTag,
  hoverExpressionDelimiter,
  hoverKeyword,
  hoverSwimString,
  hoverOperation,
  hoverSymbol,
]);

/**
 * The hover at a position: what the first resolver of {@link HOVER_RESOLVERS}
 * that recognizes it returns, or null.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {HoverContext} context
 * @returns {Promise<vscode.Hover | null>}
 */
async function resolveHover(document, position, context) {
  for (const resolve of HOVER_RESOLVERS) {
    const hover = await resolve(document, position, context);
    if (hover !== undefined) return hover;
  }
  return null;
}

/**
 * `text` as a markdown code span, which shows any text literally: fenced by
 * more backticks than the longest run in it, so a backtick in a file name
 * can't end the span early.
 *
 * @param {string} text
 * @returns {string}
 */
function inlineCode(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  // A space keeps a backtick at either end apart from the fence (markdown
  // drops one space on each side).
  const pad = /^`|`$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Registers the hover provider: shows documentation when the mouse rests on
 * code, or on Ctrl+K Ctrl+I.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {import("../document-index").ListWorkspaceModules} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerHover(settings, listWorkspaceModules) {
  const hoverProvider = vscode.languages.registerHoverProvider("otterscript", {
    provideHover(document, position) {
      if (!settings.hoverEnabled) return null;
      return resolveHover(document, position, { product: settings.product, listWorkspaceModules });
    },
  });
  return [hoverProvider];
}

module.exports = {
  HOVER_RESOLVERS,
  hoverArgument,
  hoverExecutionDirective,
  hoverExpressionDelimiter,
  hoverKeyword,
  hoverModuleCall,
  hoverOperation,
  hoverRegion,
  hoverSwimString,
  hoverSymbol,
  hoverTemplateTag,
  hoverVariable,
  inlineCode,
  registerHover,
  resolveHover,
  stopInStringOrComment,
};
