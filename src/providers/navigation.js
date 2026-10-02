// @ts-check
/**
 * @fileoverview Navigation for OtterScript: Go to Definition for variables
 * (their assignments) and modules (in this file, else elsewhere in the
 * workspace), Find References for modules, Rename (F2) for variables and
 * modules, highlighting a variable's or module's occurrences, the Outline,
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
  getVariableOccurrences,
} = require("../helpers");

/** A plain name, per Inedo's formal grammar: letters, digits, `-` and `_`; a letter first; not ending in `-` or `_`. */
const PLAIN_NAME_REGEX = /^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
/** A variable name that also has spaces -- only valid braced (`${my var}`). */
const BRACED_NAME_REGEX = /^[A-Za-z](?:[A-Za-z0-9_ -]*[A-Za-z0-9])?$/;
/** Inedo's limit on a name's length. */
const MAX_NAME_LENGTH = 50;

/**
 * The range of just the name in a variable token, without its sigil and
 * braces: `count` in `$count` or `my var` in `${my var}`.
 *
 * @param {vscode.Range} tokenRange
 * @param {boolean} braced
 * @returns {vscode.Range}
 */
function variableNameRange(tokenRange, braced) {
  return new vscode.Range(
    tokenRange.start.translate(0, braced ? 2 : 1),
    tokenRange.end.translate(0, braced ? -1 : 0)
  );
}

/**
 * Registers the navigation providers.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @param {() => Promise<{ name: string, uri: vscode.Uri, range: vscode.Range }[]>} listWorkspaceModules -
 *   Every module declared in the workspace (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerNavigation(settings, listWorkspaceModules) {
  // ============================================================
  // GO TO DEFINITION PROVIDER (Variables & Modules)
  // ============================================================
  // F12 / Ctrl+Click on a variable goes to where the file assigns it (`set`,
  // `foreach`, a module parameter, ...); with several assignments VS Code
  // lists them. On `call MyHelper(...)` it goes to `module MyHelper` -- in
  // this file, or else in any other workspace file that declares it.

  const definitionProvider = vscode.languages.registerDefinitionProvider(
    "otterscript", {
      async provideDefinition(document, position) {
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
        if (declarationRange) return new vscode.Location(document.uri, declarationRange);

        const elsewhere = (await listWorkspaceModules()).filter((m) => m.name === moduleAt.name);
        return elsewhere.length ? elsewhere.map((m) => new vscode.Location(m.uri, m.range)) : null;
      }
    }
  );

  // ============================================================
  // RENAME PROVIDER (Variables & Modules)
  // ============================================================
  // F2 on a variable renames every occurrence in the file -- in code and in
  // the strings OtterScript expands -- keeping or adding the braces a name
  // needs. F2 on a module renames its declaration and every `call` in this
  // file (calls in other files are left as they are).

  const renameProvider = vscode.languages.registerRenameProvider(
    "otterscript",
    {
      /**
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @returns {{ range: vscode.Range, placeholder: string }}
       */
      prepareRename(document, position) {
        const variableAt = getVariableAt(document, position);
        if (variableAt?.isReference) {
          return { range: variableNameRange(variableAt.range, document.getText(variableAt.range)[1] === "{"), placeholder: variableAt.name };
        }
        const moduleAt = getModuleNameAt(document, position);
        if (moduleAt) return { range: moduleAt.range, placeholder: moduleAt.name };
        throw new Error("Only a variable or a module can be renamed.");
      },

      /**
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @param {string} newName
       * @returns {vscode.WorkspaceEdit}
       */
      provideRenameEdits(document, position, newName) {
        const edit = new vscode.WorkspaceEdit();
        const variableAt = getVariableAt(document, position);
        if (variableAt?.isReference) {
          const { sigil, name } = variableAt;
          // Accept the sigil if it was typed along with the name.
          const target = (newName.startsWith(sigil) ? newName.slice(1) : newName).replace(/^\{(.*)\}$/, "$1").trim();
          if (target.length > MAX_NAME_LENGTH || !BRACED_NAME_REGEX.test(target)) {
            throw new Error(`'${target}' isn't a valid variable name: letters, digits, '-', '_' and (braced) spaces, starting with a letter and ending with a letter or digit.`);
          }
          if (target.toLowerCase() !== name.toLowerCase() && getVariableOccurrences(document, sigil, target).length) {
            throw new Error(`'${sigil}${target}' is already used in this file.`);
          }
          const needsBraces = !PLAIN_NAME_REGEX.test(target);
          for (const o of variableAt.occurrences) {
            const range = new vscode.Range(o.line, o.character, o.line, o.character + o.length);
            const braced = document.getText(range)[1] === "{";
            edit.replace(document.uri, range, braced || needsBraces ? `${sigil}{${target}}` : `${sigil}${target}`);
          }
          return edit;
        }

        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt) throw new Error("Only a variable or a module can be renamed.");
        const target = newName.trim();
        if (target.length > MAX_NAME_LENGTH || !PLAIN_NAME_REGEX.test(target)) {
          throw new Error(`'${target}' isn't a valid module name: letters, digits, '-' and '_', starting with a letter and ending with a letter or digit.`);
        }
        if (target !== moduleAt.name && findModuleDeclarationRange(document, target)) {
          throw new Error(`A module named '${target}' is already declared in this file.`);
        }
        for (const location of findModuleReferences(document, moduleAt.name, true)) {
          edit.replace(document.uri, location.range, target);
        }
        return edit;
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

  return [definitionProvider, renameProvider, referenceProvider, documentHighlightProvider, documentSymbolProvider, codeLensProvider, foldingRangeProvider];
}

module.exports = { registerNavigation };
