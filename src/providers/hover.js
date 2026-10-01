// @ts-check
/**
 * @fileoverview Hover documentation for OtterScript keywords, operations,
 * functions, variables and syntax (template tags, expression delimiters,
 * swim strings).
 */

const vscode = require("vscode");
const { keywordDocs, mapFunctionDocs, operationDocs, scalarFunctionDocs, syntaxDocs, variableDocs, vectorFunctionDocs } = require("../language-data");
const { buildHoverMarkdown, isInStringOrCommentDoc, lookupOwn } = require("../helpers");

/**
 * Registers the hover provider.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {RegExp} operationRegex - Matches a known operation name
 * @returns {vscode.Disposable[]}
 */
function registerHover(settings, operationRegex) {
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
      provideHover(document, position) {
        // -- Check if hover is enabled in settings
        if (!settings.hoverEnabled) {
          return null;
        }

        // -- Match #region / #endregion at the cursor position (checked before
        // the string/comment guard below, since `#` itself starts a comment)
        const regionRange = document.getWordRangeAtPosition(position, /#(?:end)?region\b/);
        if (regionRange) {
          const doc = lookupOwn(keywordDocs, document.getText(regionRange));
          if (doc) {
            return new vscode.Hover(buildHoverMarkdown(doc), regionRange);
          }
        }

        // -- Prevent hover inside strings or comments
        if (isInStringOrCommentDoc(document, position)) {
          return null;
        }

        // -- Template tags (<% and %>)
        // OtterScript uses ASP-style template tags for embedding code

        const templateRange = document.getWordRangeAtPosition(position, /<%|%>/);
        if (templateRange) {
          const text = document.getText(templateRange);
          if (text === '<%') {
            return new vscode.Hover(
              buildHoverMarkdown(syntaxDocs.templateOpen), templateRange);
          }
          if (text === '%>') {
            return new vscode.Hover(
              buildHoverMarkdown(syntaxDocs.templateClose), templateRange);
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
                buildHoverMarkdown(syntaxDocs.mapExpr), exprRange);
            }
            if (text === '@(') {
              return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.vectorExpr), exprRange);
            }
            if (text === '$(') {
              return new vscode.Hover(
                buildHoverMarkdown(syntaxDocs.nestedEval), exprRange);
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
          if (doc) return new vscode.Hover(buildHoverMarkdown(doc), wordRange);
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
            buildHoverMarkdown(syntaxDocs.swimString), swimRange);
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
          return new vscode.Hover(buildHoverMarkdown(doc), operationRange);
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
        return new vscode.Hover(buildHoverMarkdown(doc), symbolRange);
      }
    }
  );

  return [hoverProvider];
}

module.exports = { registerHover };
