// @ts-check
/**
 * @fileoverview In-file navigation for OtterScript: Go to Definition for
 * variables (their assignments) and modules, Find References for modules,
 * highlighting a variable's or module's occurrences, the Outline,
 * reference-count CodeLens, and folding.
 */

const vscode = require("vscode");
const {
  computeFoldingRanges,
  findModuleDeclarationRange,
  findModuleReferences,
  getModuleCallReferencesByName,
  getModuleDeclarations,
  getModuleNameAt,
  getVariableAt,
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
  // GO TO DEFINITION PROVIDER (Variables & Modules)
  // ============================================================
  // F12 / Ctrl+Click on a variable goes to where the file assigns it (`set`,
  // `foreach`, a module parameter, ...); with several assignments VS Code
  // lists them. On `call MyHelper(...)` it goes to `module MyHelper`.

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    "otterscript", {
      provideDefinition(document, position) {
        // -- A variable: its assignments. One that is only ever read (a
        // runtime variable such as $PackageName) has nothing to go to.
        const variableAt = getVariableAt(document, position);
        if (variableAt) {
          if (!variableAt.isReference) return null;
          const writes = variableAt.occurrences.filter((o) => o.write);
          return writes.length
            ? writes.map((o) => new vscode.Location(document.uri, new vscode.Range(o.line, o.character, o.line, o.character + o.length)))
            : null;
        }

        // -- A module: only from a `call` statement; the declaration is the definition.
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


  const documentHighlightProvider = vscode.languages.registerDocumentHighlightProvider(
    "otterscript",
    {
      /**
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @returns {vscode.DocumentHighlight[] | undefined}
       */
      provideDocumentHighlights(document, position) {
        // A variable token that isn't a real reference (in a comment, a
        // function call's name, ...) highlights nothing.
        const variableAt = getVariableAt(document, position);
        if (variableAt) {
          if (!variableAt.isReference) return undefined;
          return variableAt.occurrences.map((o) => new vscode.DocumentHighlight(
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
