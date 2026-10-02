// @ts-check
/**
 * @fileoverview Navigation for OtterScript: Go to Definition for variables
 * (their assignments) and modules (in this file, else elsewhere in the
 * workspace), Find References and Rename (F2) for modules -- across workspace
 * files -- and Rename for variables, highlighting a variable's or module's occurrences, the Outline,
 * reference-count CodeLens, and folding.
 */

const vscode = require("vscode");
const {
  findModuleDeclarationRange,
  findModuleReferences,
  getModuleCallReferencesByName,
  getModuleDeclarations,
  getModuleNameAt,
  getVariableAt,
  getVariableOccurrences,
} = require("../document-index");
const { createCodeScanState, findTemplateTagDelimiters, maskNonCodeSpans } = require("../scanner");


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
 * @param {{
 *   listModules: () => Promise<{ name: string, uri: vscode.Uri, range: vscode.Range }[]>,
 *   listFiles: () => Promise<vscode.Uri[]>
 * }} workspace - Every module declared in the workspace, and every
 *   OtterScript file in it (workspace-symbols.js)
 * @returns {vscode.Disposable[]}
 */
function registerNavigation(settings, workspace) {
  /**
   * The open document for `uri`, or -- when its text on disk mentions
   * `name` at all -- the document VS Code loads for it (without showing it).
   *
   * @param {vscode.Uri} uri
   * @param {string} name
   * @returns {Promise<vscode.TextDocument | undefined>}
   */
  async function documentMentioning(uri, name) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open;
    try {
      const text = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
      return text.includes(name) ? await vscode.workspace.openTextDocument(uri) : undefined;
    } catch {
      return undefined; // gone or unreadable
    }
  }

  /**
   * Every place a module is declared or called, as `document` sees it. A
   * `call` means the module its own file declares, or else the one workspace
   * file that declares it (as Go to Definition resolves it). So the module's
   * file is `document` when it declares the name, else that one other file;
   * the calls are that file's plus those in every file that doesn't declare
   * the name itself. When the module's file can't be told -- no file or
   * several other files declare it -- only `document`'s own uses count.
   *
   * @param {vscode.TextDocument} document
   * @param {string} name
   * @returns {Promise<{ locations: vscode.Location[], declaration: vscode.Location | undefined, crossFile: boolean }>}
   *   `locations` include the module's declaration, which `declaration` is
   *   (when known); `crossFile` tells whether other files were searched.
   */
  async function findModuleUses(document, name) {
    const self = document.uri.toString();
    const declaredIn = new Set((await workspace.listModules()).filter((m) => m.name === name).map((m) => m.uri.toString()));
    declaredIn.delete(self);
    const localDeclaration = findModuleDeclarationRange(document, name);

    /** @type {vscode.TextDocument | undefined} */
    let home = document;
    if (!localDeclaration) {
      const [only] = declaredIn;
      home = declaredIn.size === 1 ? await documentMentioning(vscode.Uri.parse(only), name) : undefined;
    } else if (declaredIn.size > 0) {
      home = undefined; // calls elsewhere may mean another file's module
    }
    if (!home) {
      return {
        locations: findModuleReferences(document, name, true),
        declaration: localDeclaration ? new vscode.Location(document.uri, localDeclaration) : undefined,
        crossFile: false,
      };
    }

    const homeDeclaration = findModuleDeclarationRange(home, name);
    const declaration = homeDeclaration ? new vscode.Location(home.uri, homeDeclaration) : undefined;
    const locations = findModuleReferences(home, name, true);
    for (const uri of await workspace.listFiles()) {
      const key = uri.toString();
      if (key === home.uri.toString() || declaredIn.has(key)) continue;
      const other = await documentMentioning(uri, name);
      if (other && !findModuleDeclarationRange(other, name)) locations.push(...findModuleReferences(other, name, false));
    }
    return { locations, declaration, crossFile: true };
  }

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

        const elsewhere = (await workspace.listModules()).filter((m) => m.name === moduleAt.name);
        return elsewhere.length ? elsewhere.map((m) => new vscode.Location(m.uri, m.range)) : null;
      }
    }
  );

  // ============================================================
  // RENAME PROVIDER (Variables & Modules)
  // ============================================================
  // F2 on a variable renames every occurrence in the file -- in code and in
  // the strings OtterScript expands -- keeping or adding the braces a name
  // needs. F2 on a module renames its declaration and every `call` to it,
  // in other workspace files too (see findModuleUses).

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
       * @returns {Promise<vscode.WorkspaceEdit>}
       */
      async provideRenameEdits(document, position, newName) {
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
        const { locations, crossFile } = await findModuleUses(document, moduleAt.name);
        if (crossFile && target !== moduleAt.name) {
          // A call renamed in another file must still mean this module.
          const clash = (await workspace.listModules()).find((m) => m.name === target);
          if (clash) throw new Error(`A module named '${target}' is already declared in ${vscode.workspace.asRelativePath(clash.uri)}.`);
        }
        for (const location of locations) edit.replace(location.uri, location.range, target);
        return edit;
      }
    }
  );

  // ============================================================
  // FIND REFERENCES PROVIDER (Modules)
  // ============================================================
  // Shift+F12 on a module: its declaration and calls, across workspace files
  // (see findModuleUses). The CodeLens counts stay per file.

  const referenceProvider = vscode.languages.registerReferenceProvider(
    "otterscript",
    {
      /**
       * Resolves references for a module symbol from either declaration or call sites.
       *
       * @param {vscode.TextDocument} document
       * @param {vscode.Position} position
       * @param {vscode.ReferenceContext} refContext
       * @returns {Promise<vscode.Location[]>}
       */
      async provideReferences(document, position, refContext) {
        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt) return [];
        const { locations, declaration } = await findModuleUses(document, moduleAt.name);
        if (refContext.includeDeclaration || !declaration) return locations;
        return locations.filter((l) => !(l.uri.toString() === declaration.uri.toString() && l.range.isEqual(declaration.range)));
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

// ============================================================
// FOLDING RANGES
// ============================================================

/**
 * Computes folding ranges for an OtterScript document.
 *
 * Folds `{ }` blocks, multi-line `%( )` / `@( )` literals, multi-line `<% %>`
 * tags, `#region` / `#endregion` pairs, block comments, and swim-strings.
 *
 * Reuses the same `maskNonCodeSpans` pass as diagnostics, so folding respects
 * strings, swim-strings, and block comments identically to every other feature
 * in the extension — braces inside a string or a swim-string body are never
 * treated as fold boundaries.
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

    // -- <% %> template tags (multi-line tags only; brace folding still applies
    //    inside tags). Delimiter detection is shared with diagnostics via
    //    scanner.findTemplateTagDelimiters.
    for (const delim of findTemplateTagDelimiters(maskedLine)) {
      if (delim.open) {
        templateTagStack.push(lineIndex);
      } else {
        const start = templateTagStack.pop();
        if (start !== undefined && lineIndex > start) {
          ranges.push(new vscode.FoldingRange(start, lineIndex, vscode.FoldingRangeKind.Region));
        }
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

module.exports = { computeFoldingRanges, registerNavigation };
