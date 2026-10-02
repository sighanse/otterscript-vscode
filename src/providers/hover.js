// @ts-check
/**
 * @fileoverview Hover documentation for OtterScript keywords, operations,
 * functions, variables and syntax (template tags, expression delimiters,
 * swim strings).
 */

const vscode = require("vscode");
const { keywordDocs, mapFunctionDocs, operationDocs, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const { buildArgumentHoverMarkdown, buildHoverMarkdown, lookupOwn } = require("../helpers");
const { findModuleDeclarationRange, getMaskedTextBefore, getModuleNameAt, isInStringOrCommentDoc } = require("../document-index");
const { findOperationArgumentContext } = require("../scanner");

/**
 * Hover for an argument name of an operation call -- a name followed by `:`
 * (not `::`) where an argument starts -- or null.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {vscode.Hover | null}
 */
function hoverArgument(document, position) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z]\w*/);
  if (!range || !/^\s*:(?!:)/.test(document.lineAt(range.end.line).text.slice(range.end.character))) return null;
  const context = findOperationArgumentContext(getMaskedTextBefore(document, range.start));
  if (!context || context.typed) return null;
  const operation = lookupOwn(operationDocs, context.operation);
  const name = document.getText(range).toLowerCase();
  const param = operation?.params?.find((p) => p.name.toLowerCase() === name);
  return operation && param ? new vscode.Hover(buildArgumentHoverMarkdown(operation, param), range) : null;
}

/**
 * Hover for the module name in a `call`: the module's declaration line and
 * the `#` comment lines right above it -- from this file, or else from the
 * one workspace file that declares it -- or null.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules
 * @returns {Promise<vscode.Hover | null>}
 */
async function hoverModuleCall(document, position, listWorkspaceModules) {
  const moduleAt = getModuleNameAt(document, position);
  if (!moduleAt || moduleAt.isDeclaration) return null;

  let home = document;
  let declaration = findModuleDeclarationRange(document, moduleAt.name);
  if (!declaration) {
    const elsewhere = (await listWorkspaceModules()).filter((m) => m.name === moduleAt.name);
    if (elsewhere.length !== 1) return null;
    home = await vscode.workspace.openTextDocument(elsewhere[0].uri);
    declaration = findModuleDeclarationRange(home, moduleAt.name);
    if (!declaration) return null;
  }

  // The declaration up to its `{`, and the comment block right above it.
  const header = home.lineAt(declaration.start.line).text.replace(/\{.*$/, "").trim();
  const comment = [];
  for (let line = declaration.start.line - 1; line >= 0; line--) {
    const match = /^\s*#\s?(.*)$/.exec(home.lineAt(line).text);
    if (!match) break;
    comment.unshift(match[1]);
  }

  const md = new vscode.MarkdownString();
  md.appendCodeblock(header, "otterscript");
  if (comment.length) md.appendMarkdown(`${comment.join("  \n")}\n\n`);
  if (home !== document) md.appendMarkdown(`Declared in \`${vscode.workspace.asRelativePath(home.uri)}\``);
  return new vscode.Hover(md, moduleAt.range);
}

/**
 * Registers the hover provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {RegExp} operationRegex - Matches a known operation name
 * @param {() => Promise<{ name: string, uri: vscode.Uri, range: vscode.Range }[]>} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerHover(settings, operationRegex, listWorkspaceModules) {
  // ============================================================
  // HOVER PROVIDER
  // ============================================================
  // Shows documentation when user hovers over code elements.
  // Triggered by mouse hover or Ctrl+K Ctrl+I (keyboard).
  //
  // Hover resolution order matters (MOST specific FIRST)

  const hoverProvider = vscode.languages.registerHoverProvider(
    "otterscript",
    {
      async provideHover(document, position) {
        // -- Check if hover is enabled in settings
        if (!settings.hoverEnabled) {
          return null;
        }

        // -- `#region` / `#endregion`: an editor folding marker, not OtterScript
        // syntax (to OtterScript it's a `#` comment). Only at the start of a
        // line, the same rule folding uses -- not inside a string such as
        // `Log "#region";` or a trailing comment. Checked before the
        // string/comment guard below, which would treat the line as a comment.
        const regionMatch = /^(\s*)(#(?:end)?region)\b/i.exec(document.lineAt(position.line).text);
        if (regionMatch) {
          const start = regionMatch[1].length;
          const end = start + regionMatch[2].length;
          if (position.character >= start && position.character <= end) {
            const doc = regionMatch[2].toLowerCase() === "#region" ? syntaxDocs.regionStart : syntaxDocs.regionEnd;
            return new vscode.Hover(buildHoverMarkdown(doc, settings.product), new vscode.Range(position.line, start, position.line, end));
          }
        }

        // -- Prevent hover inside strings or comments
        if (isInStringOrCommentDoc(document, position)) {
          return null;
        }

        // -- An argument name in an operation call (`To` in `Copy-Files(To: $x)`)
        const argumentHover = hoverArgument(document, position);
        if (argumentHover) return argumentHover;

        // -- A module name in a `call`: the module's declaration
        const moduleHover = await hoverModuleCall(document, position, listWorkspaceModules);
        if (moduleHover) return moduleHover;

        // -- Template tags (<% and %>)
        // OtterScript uses ASP-style template tags for embedding code

        const templateRange = document.getWordRangeAtPosition(position, /<%|%>/);
        if (templateRange) {
          const text = document.getText(templateRange);
          if (text === '<%') {
            return new vscode.Hover(
              buildHoverMarkdown(syntaxDocs.templateOpen, settings.product), templateRange);
          }
          if (text === '%>') {
            return new vscode.Hover(
              buildHoverMarkdown(syntaxDocs.templateClose, settings.product), templateRange);
          }
        }

        // -- Expression Delimiters (%(), @(), $())
        // These delimiters start special expression types:
        //   %( ) - Map expression (key-value pairs)
        //   @( ) - Vector expression (arrays/lists)
        //   $( ) - Nested evaluation (evaluate inner expression first)

        const exprRange = document.getWordRangeAtPosition(position, /%\(|@\(|\$\(/);
        if (exprRange) {
            const text = document.getText(exprRange);
            if (text === '%(') {
              return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.mapExpr, settings.product), exprRange);
            }
            if (text === '@(') {
              return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.vectorExpr, settings.product), exprRange);
            }
            if (text === '$(') {
              return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.nestedEval, settings.product), exprRange);
            }
        }
        // -- Keywords (if, foreach, with, set, etc.)
        // Control flow and language keywords.

        // -- Special-case multi-word keyword: "force normal"
        const forceRange = document.getWordRangeAtPosition(
          position,
          /\bforce\s+normal\b/
        );

        const wordRange = forceRange
          ?? document.getWordRangeAtPosition(
              position,
              /\b[a-zA-Z]+(?:-[a-zA-Z]+)*\b/ // Single token, hyphens allowed; NEVER spaces
            );

        if (wordRange) {
          const word = document.getText(wordRange);

          // -- Check if it's a known keyword
          const doc = lookupOwn(keywordDocs, word);
          if (doc) return new vscode.Hover(buildHoverMarkdown(doc, settings.product), wordRange);
        }

        // -- Swim-string delimiters (Fish Sentinels)
        // OtterScript's unique string syntax: >>, >==8>, >--=>
        // Any characters between two identical fish-shaped delimiters

        const swimRange = document.getWordRangeAtPosition(
          position,
          />[^>]{0,5}>/
        );

        if (swimRange) {
          return new vscode.Hover(
            buildHoverMarkdown(syntaxDocs.swimString, settings.product), swimRange);
        }

        // -- Operations (Log-Information, Log-Warning, Log-Error, etc.)
        // Built-in operations. Distinguished by hyphenated names.
        const operationRange = document.getWordRangeAtPosition(
          position,
          operationRegex
        );

        if (operationRange) {
          const opName = document.getText(operationRange);
          const doc = lookupOwn(operationDocs, opName);

          // -- No documentation found
          if (!doc) return null;

          // -- Make hover
          return new vscode.Hover(buildHoverMarkdown(doc, settings.product), operationRange);
        }

        // -- Symbols ($function, @vector, %map function, $variable)
        // Most general case - matches any $, @, or % prefixed identifier
        // Checks scalar/vector/map functions and variables
        // Must be LAST because it matches many things
        const symbolRange = document.getWordRangeAtPosition(
          position,
          /[@$%][A-Za-z][A-Za-z0-9]*/  // $Name, @Name, or %Name (no spaces)
        );
        if (!symbolRange) return null;

        const text = document.getText(symbolRange);
        const prefix = text[0];         // '$', '@', or '%'
        const name = text.substring(1); // The identifier without prefix

        // -- Look up documentation based on prefix type
        let doc;
        if (prefix === "$") {
          // -- $ can be either a scalar function OR a variable
          // Check functions first (more specific), then variables
          doc = lookupOwn(scalarFunctionDocs, name) ?? lookupOwn(variableDocs, name);
        } else if (prefix === "@") {
          // -- @ is a vector function
          doc = lookupOwn(vectorFunctionDocs, name);
        } else if (prefix === "%") {
          // -- % is a map function (a plain %map variable has no doc -> no hover)
          doc = lookupOwn(mapFunctionDocs, name);
        }

        // -- No documentation found
        if (!doc) return null;

        // -- Make hover
        return new vscode.Hover(buildHoverMarkdown(doc, settings.product), symbolRange);
      }
    }
  );

  return [hoverProvider];
}

module.exports = { registerHover };
