// @ts-check
/**
 * @fileoverview Hover documentation for OtterScript keywords, operations,
 * functions, variables and syntax (template tags, expression delimiters,
 * swim strings).
 */

const vscode = require("vscode");
const { keywordDocs, lookupOperation, mapFunctionDocs, operationForms, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const { buildArgumentHoverMarkdown, buildHoverMarkdown, lookupOwn } = require("../helpers");
const { findCallArguments, getMaskedTextBefore, getModuleNameAt, getModuleParameters, isInStringOrCommentDoc, resolveModule } = require("../document-index");
const { findOperationArgumentContext } = require("../scanner");

/**
 * Hover for an argument name of an operation or module call -- a name
 * followed by `:` (not `::`) or, for an output, `=>`, where an argument
 * starts -- or null.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {() => Promise<{ name: string, uri: vscode.Uri }[]>} listWorkspaceModules
 * @returns {Promise<vscode.Hover | null>}
 */
async function hoverArgument(document, position, listWorkspaceModules) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z][\w-]*/);
  if (!range || !/^\s*(?::(?!:)|=>)/.test(document.lineAt(range.end.line).text.slice(range.end.character))) return null;
  const context = findOperationArgumentContext(getMaskedTextBefore(document, range.start));
  if (!context || context.typed) return null;
  const called = await findCallArguments(document, context, listWorkspaceModules);
  const name = document.getText(range).toLowerCase();
  const param = called?.params.find((p) => p.name.toLowerCase() === name);
  return called && param ? new vscode.Hover(buildArgumentHoverMarkdown(called.callee, param), range) : null;
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
  if (comment.length) md.appendMarkdown(`${comment.join("  \n")}\n\n`);
  if (home !== document) md.appendMarkdown(`Declared in \`${vscode.workspace.asRelativePath(home.uri)}\``);
  return new vscode.Hover(md, moduleAt.range);
}

/**
 * Registers the hover provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {() => Promise<{ name: string, uri: vscode.Uri, range: vscode.Range }[]>} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerHover(settings, listWorkspaceModules) {
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
        const argumentHover = await hoverArgument(document, position, listWorkspaceModules);
        if (argumentHover) return argumentHover;

        // -- A module name in a `call`: the module's declaration. A module name
        // is never anything else, so nothing further is tried: an unresolved
        // `call Build` or a `module Build` mustn't show the `Build` operation.
        if (getModuleNameAt(document, position)) return hoverModuleCall(document, position, listWorkspaceModules);

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

        // -- Operations (Log-Information, Copy-Files, PSCall, ...): a documented
        // name that isn't the name part of a `$`/`@`/`%` token. A
        // `Namespace::` before it picks between same-named operations
        // (`DotNet::Build`); without one, the others are listed.
        const operationRange = document.getWordRangeAtPosition(position, /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/);
        const lineBefore = operationRange && document.lineAt(position.line).text.slice(0, operationRange.start.character);
        if (operationRange && !/[$@%{]$/.test(lineBefore ?? "")) {
          const name = document.getText(operationRange);
          const namespace = /([A-Za-z][A-Za-z0-9]*)::$/.exec(lineBefore ?? "")?.[1];
          const doc = lookupOperation(name, namespace);
          if (doc) {
            const markdown = buildHoverMarkdown(doc, settings.product);
            const others = namespace ? [] : operationForms(name).filter((form) => form !== doc);
            if (others.length) {
              markdown.appendMarkdown(`\n\n---\n\nAlso ${others
                .map((form) => `\`${form.namespace ?? "Core"}::${form.name}\`${form.products ? ` (${form.products.join(", ")})` : ""}`)
                .join(", ")}: write the namespace to pick one.`);
            }
            return new vscode.Hover(markdown, operationRange);
          }
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
