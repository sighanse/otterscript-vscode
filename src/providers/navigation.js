// @ts-check
/**
 * @fileoverview Navigation for OtterScript: Go to Definition for variables
 * (their assignments) and modules (in this file, else elsewhere in the
 * workspace), Find References and Rename (F2) for modules -- across workspace
 * files -- and Rename for variables (within the file), highlighting a
 * variable's or module's occurrences, the Outline, reference-count CodeLens,
 * and folding.
 */

const vscode = require("vscode");
const { mapWithConcurrency, readWorkspaceText } = require("../helpers");
const {
  findModuleDeclarationRange,
  findModuleReferences,
  getModuleCallReferencesByName,
  getModuleDeclarations,
  getModuleNameAt,
  getVariableAt,
  getVariableOccurrences,
  moduleKey,
} = require("../document-index");
const { createCodeScanState, findTemplateTagDelimiters, maskNonCodeSpans, NAME_PATTERN } = require("../scanner");

/** How many workspace files a cross-file search reads at once. */
const CROSS_FILE_READ_CONCURRENCY = 20;

/** A plain name, per Inedo's formal grammar (see NAME_PATTERN). */
const PLAIN_NAME_REGEX = new RegExp(`^${NAME_PATTERN}$`);
/**
 * A new variable name that also has spaces -- only valid braced (`${my var}`).
 * Stricter than what the scanner reads as a braced name: like a plain name it
 * must end with a letter or digit, so a rename never produces `${my var }`.
 */
const BRACED_NAME_REGEX = /^[A-Za-z](?:[A-Za-z0-9_ -]*[A-Za-z0-9])?$/;
/** Inedo's limit on a name's length. */
const MAX_NAME_LENGTH = 50;

/**
 * The range of one variable occurrence (sigil and braces included).
 *
 * @param {import("../scanner").VariableOccurrence} occurrence
 * @returns {vscode.Range}
 */
function occurrenceRange(occurrence) {
  const { line, character, length } = occurrence;
  return new vscode.Range(line, character, line, character + length);
}

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
 *   listModules: import("../document-index").ListWorkspaceModules,
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
      // A file too large to read is left out, as from the module index.
      const text = await readWorkspaceText(uri);
      return text?.toLowerCase().includes(moduleKey(name)) ? await vscode.workspace.openTextDocument(uri) : undefined;
    } catch {
      return undefined; // gone or unreadable
    }
  }

  /**
   * Refuses to rename a module the file declares more than once (flagged by
   * `duplicate-module`): which declaration its calls mean is ambiguous, and
   * a rename from the second would edit the first.
   *
   * @param {vscode.TextDocument} document
   * @param {string} name
   * @returns {void}
   */
  function assertSingleDeclaration(document, name) {
    const count = getModuleDeclarations(document).filter((d) => moduleKey(d.name) === moduleKey(name)).length;
    if (count > 1) throw new Error(`This file declares '${name}' ${count} times; remove the duplicates before renaming.`);
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
   * @returns {Promise<{ locations: vscode.Location[], declaration: vscode.Location | undefined, crossFile: boolean, home: vscode.TextDocument }>}
   *   `locations` include the module's declaration, which `declaration` is
   *   (when known); `crossFile` tells whether other files were searched;
   *   `home` is the file whose declaration the uses belong to (`document`
   *   itself unless another file declares the module).
   */
  async function findModuleUses(document, name) {
    const self = document.uri.toString();
    const declaredIn = new Set((await workspace.listModules()).filter((m) => moduleKey(m.name) === moduleKey(name)).map((m) => m.uri.toString()));
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
        home: document,
      };
    }

    const homeDeclaration = findModuleDeclarationRange(home, name);
    const declaration = homeDeclaration ? new vscode.Location(home.uri, homeDeclaration) : undefined;
    const locations = findModuleReferences(home, name, true);
    // The other files' calls, read a bounded number at a time (a workspace
    // may have thousands, maybe remote), in the files' order.
    const others = (await workspace.listFiles())
      .filter((uri) => uri.toString() !== home?.uri.toString() && !declaredIn.has(uri.toString()));
    /** @type {vscode.Location[][]} */
    const found = new Array(others.length);
    await mapWithConcurrency(others.map((uri, i) => ({ uri, i })), CROSS_FILE_READ_CONCURRENCY, async ({ uri, i }) => {
      const other = await documentMentioning(uri, name);
      found[i] = other && !findModuleDeclarationRange(other, name) ? findModuleReferences(other, name, false) : [];
    });
    locations.push(...found.flat());
    return { locations, declaration, crossFile: true, home };
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
            ? writes.map((o) => new vscode.Location(document.uri, occurrenceRange(o)))
            : null;
        }

        // -- A module: only from a `call` statement; the declaration is the definition.
        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt || moduleAt.isDeclaration) return null;

        const declarationRange = findModuleDeclarationRange(document, moduleAt.name);
        if (declarationRange) return new vscode.Location(document.uri, declarationRange);

        const elsewhere = (await workspace.listModules()).filter((m) => moduleKey(m.name) === moduleKey(moduleAt.name));
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
        if (moduleAt) {
          assertSingleDeclaration(document, moduleAt.name);
          return { range: moduleAt.range, placeholder: moduleAt.name };
        }
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
            const range = occurrenceRange(o);
            const braced = document.getText(range)[1] === "{";
            edit.replace(document.uri, range, braced || needsBraces ? `${sigil}{${target}}` : `${sigil}${target}`);
          }
          return edit;
        }

        const moduleAt = getModuleNameAt(document, position);
        if (!moduleAt) throw new Error("Only a variable or a module can be renamed.");
        assertSingleDeclaration(document, moduleAt.name);
        const target = newName.trim();
        if (target.length > MAX_NAME_LENGTH || !PLAIN_NAME_REGEX.test(target)) {
          throw new Error(`'${target}' isn't a valid module name: letters, digits, '-' and '_', starting with a letter and ending with a letter or digit.`);
        }
        // A new casing of the same name is the same module, so no clash.
        const sameName = moduleKey(target) === moduleKey(moduleAt.name);
        if (!sameName && findModuleDeclarationRange(document, target)) {
          throw new Error(`A module named '${target}' is already declared in this file.`);
        }
        const { locations, crossFile, home, declaration } = await findModuleUses(document, moduleAt.name);
        // A call no single declaration answers (none, or several other files)
        // has no module to rename -- only itself, which would just break it.
        if (!declaration) {
          throw new Error(`Can't rename '${moduleAt.name}': no one module declaration was found for it (none, or in several files).`);
        }
        // Started from a call: the declaring file mustn't declare it twice either.
        if (home !== document) assertSingleDeclaration(home, moduleAt.name);
        if (crossFile && !sameName) {
          // A call renamed in another file must still mean this module.
          const clash = (await workspace.listModules()).find((m) => moduleKey(m.name) === moduleKey(target));
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
            occurrenceRange(o),
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
  // VS Code's reference peek UI. Counts the calls in this file only; Find
  // References (Shift+F12) searches the workspace.

  // Switching the setting re-requests the lenses, so they appear or go at
  // once rather than at the next edit (VS Code asks again later, after
  // extension.js has reloaded the settings).
  const codeLensesChanged = new vscode.EventEmitter();
  const codeLensSettingListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("otterscript.codeLens")) codeLensesChanged.fire(undefined);
  });

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    "otterscript",
    {
      onDidChangeCodeLenses: codeLensesChanged.event,
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
        const refsByName = getModuleCallReferencesByName(document);

        for (const declaration of declarations) {
          const range = declaration.range;
          const usageRefs = refsByName.get(moduleKey(declaration.name)) ?? [];

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
  // Lets users collapse { } blocks, %(...), @(...), <% %> template tags,
  // /* */ block comments, swim strings, and #region/#endregion.
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

  return [
    definitionProvider, renameProvider, referenceProvider, documentHighlightProvider, documentSymbolProvider,
    codeLensProvider, codeLensSettingListener, codeLensesChanged, foldingRangeProvider,
  ];
}

// ============================================================
// FOLDING RANGES
// ============================================================

/**
 * Computes folding ranges for an OtterScript document.
 *
 * Folds `{ }` blocks, multi-line `%( )` / `@( )` literals, multi-line `<% %>`
 * tags, `#region` / `#endregion` pairs, block comments, and swim-strings.
 * Only `#region` pairs get `FoldingRangeKind.Region` and block comments
 * `Comment`: VS Code's Fold All Regions / Fold All Block Comments commands
 * act on those kinds, so an ordinary block has none.
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
        ranges.push(new vscode.FoldingRange(swimStart, lineIndex));
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
          ranges.push(new vscode.FoldingRange(start, lineIndex));
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
          ranges.push(new vscode.FoldingRange(start, lineIndex));
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
            ranges.push(new vscode.FoldingRange(popped.line, lineIndex));
          }
        }
      }
    }
  }

  return ranges;
}

module.exports = { computeFoldingRanges, registerNavigation };
