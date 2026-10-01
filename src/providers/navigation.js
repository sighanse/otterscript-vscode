// @ts-check
/**
 * @fileoverview In-file navigation for OtterScript: Go to Definition and Find
 * References for modules, highlighting a variable's or module's occurrences,
 * the Outline, reference-count CodeLens, and folding.
 */

const vscode = require("vscode");
const {
  computeFoldingRanges,
  findModuleDeclarationRange,
  findModuleReferences,
  getModuleCallReferencesByName,
  getModuleDeclarations,
  getModuleNameAt,
  getVariableOccurrences,
} = require("../helpers");

/**
 * Registers the navigation providers.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @returns {vscode.Disposable[]}
 */
function registerNavigation(settings) {
  // ============================================================
  // GO TO DEFINITION PROVIDER (Modules)
  // ============================================================
  // Enables Go-to-Definition (F12 / Ctrl+Click) for calls like:
  // call MyHelper(...) by navigating to the corresponding module MyHelper

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    "otterscript", {
      provideDefinition(document, position) {
        // -- Only from a `call` statement; the declaration is the definition.
        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt || moduleAt.isDeclaration) return null;

        const declarationRange = findModuleDeclarationRange(document, moduleAt.name);
        return declarationRange ? new vscode.Location(document.uri, declarationRange) : null;
      }
    }
  );

  // ============================================================
  // FIND REFERENCES PROVIDER (Modules)
  // ============================================================
  // Enables Shift+F12 and powers CodeLens reference counts for module calls.

  const referenceProvider = vscode.languages.registerReferenceProvider(
    "otterscript",
    {
      /**
       * Resolves references for a module symbol from either declaration or call sites.
       *
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @param {vscode.ReferenceContext} refContext
       * @returns {vscode.Location[]}
       */
      provideReferences(document, position, refContext) {
        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt) return [];
        return findModuleReferences(document, moduleAt.name, refContext.includeDeclaration);
      }
    }
  );

  // ============================================================
  // DOCUMENT HIGHLIGHT PROVIDER (Variables & Modules)
  // ============================================================
  // Clicking a variable or module name highlights every use of it in the
  // file; declarations and assignment targets are marked as writes.

  /** A `$name` / `@name` / `%name` token, or its braced `${name}` form, under the cursor. */
  const VARIABLE_AT_CURSOR_REGEX = /[$@%](?:\{[A-Za-z_][A-Za-z0-9_ ]*\}|[A-Za-z_][A-Za-z0-9_]*)/;

  const documentHighlightProvider = vscode.languages.registerDocumentHighlightProvider(
    "otterscript",
    {
      /**
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @returns {vscode.DocumentHighlight[] | undefined}
       */
      provideDocumentHighlights(document, position) {
        const variableRange = document.getWordRangeAtPosition(position, VARIABLE_AT_CURSOR_REGEX);
        if (variableRange) {
          const token = document.getText(variableRange);
          const name = token[1] === "{" ? token.slice(2, -1) : token.slice(1);
          const occurrences = getVariableOccurrences(document, token[0], name);
          // The token under the cursor must itself be a reference -- not in a
          // comment or single-quoted string, and not a function call.
          const isReference = occurrences.some(
            (o) => o.line === variableRange.start.line && o.character === variableRange.start.character
          );
          if (!isReference) return undefined;
          return occurrences.map((o) => new vscode.DocumentHighlight(
            new vscode.Range(o.line, o.character, o.line, o.character + o.length),
            o.write ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read
          ));
        }

        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt) return undefined;

        const moduleName = moduleAt.name;
        const declarationRange = findModuleDeclarationRange(document, moduleName);
        return findModuleReferences(document, moduleName, true).map((location) => new vscode.DocumentHighlight(
          location.range,
          declarationRange && location.range.isEqual(declarationRange)
            ? vscode.DocumentHighlightKind.Write
            : vscode.DocumentHighlightKind.Read
        ));
      }
    }
  );

  // ============================================================
  // DOCUMENT SYMBOL PROVIDER (Outline / Go to Symbol)
  // ============================================================
  // Populates the Outline panel and breadcrumbs with module declarations.
  // Enables Ctrl+Shift+O (Go to Symbol) to jump to any module in the file.

  const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
    "otterscript",
    {
      /**
       * Scans the document for module declarations and returns them as symbols.
       *
       * @param {vscode.TextDocument} document
       * @returns {vscode.DocumentSymbol[]}
       */
      provideDocumentSymbols(document) {
        return getModuleDeclarations(document).map(entry =>
          new vscode.DocumentSymbol(
            entry.name,
            "",
            vscode.SymbolKind.Module,
            entry.lineRange,
            entry.range
          )
        );
      }
    }
  );

  // ============================================================
  // CODE LENS PROVIDER (Module References)
  // ============================================================
  // Shows reference counts above module declarations and links to
  // VS Code's reference peek UI.

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    "otterscript",
    {
      /**
       * Builds code lenses for module declarations.
       *
       * @param {vscode.TextDocument} document
       * @returns {vscode.CodeLens[]}
       */
      provideCodeLenses(document) {
        if (!settings.codeLensEnabled) return [];
        /** @type {vscode.CodeLens[]} */
        const lenses = [];
        const declarations = getModuleDeclarations(document);
        const declarationNames = new Set(declarations.map(declaration => declaration.name));
        const refsByName = getModuleCallReferencesByName(document, declarationNames);

        for (const declaration of declarations) {
          const range = declaration.range;
          const usageRefs = refsByName.get(declaration.name) ?? [];

          lenses.push(
            new vscode.CodeLens(range, {
              title: `${usageRefs.length} reference${usageRefs.length === 1 ? "" : "s"}`,
              command: "editor.action.showReferences",
              arguments: [document.uri, range.start, usageRefs]
            })
          );
        }

        return lenses;
      }
    }
  );

  // ============================================================
  // FOLDING RANGE PROVIDER
  // ============================================================
  // Lets users collapse { } blocks, %(...), @(... ), <% %> template tags,
  // /* */ block comments, and #region/#endregion.
  // Reuses the same CodeScanState masking pass as diagnostics, so folding
  // never disagrees with what diagnostics/hover treat as real code.

  const foldingRangeProvider = vscode.languages.registerFoldingRangeProvider(
    "otterscript",
    {
      /**
       * @param {vscode.TextDocument} document
       * @returns {vscode.FoldingRange[]}
       */
      provideFoldingRanges(document) {
        return computeFoldingRanges(document);
      }
    }
  );

  return [definitionProvider, referenceProvider, documentHighlightProvider, documentSymbolProvider, codeLensProvider, foldingRangeProvider];
}

module.exports = { registerNavigation };
