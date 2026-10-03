// @ts-check
/**
 * @fileoverview The workspace's module index -- a lazily built index of every
 * `module` declaration in the workspace, kept current by a file watcher and by
 * the open documents -- and Go to Symbol in Workspace (Ctrl+T) on it.
 */

const vscode = require("vscode");
const { clearTimerForUri, log, mapWithConcurrency, scheduleTimerForUri } = require("../helpers");
const { findModuleDeclarations } = require("../scanner");

/** Decodes the files the index reads (one, reused). */
const UTF8 = new TextDecoder("utf-8");

/**
 * Whether a Go to Symbol in Workspace query matches a module name: its
 * characters appear in the name in order, ignoring case (`dpm` matches
 * `Deploy-Module`). VS Code asks providers to match this loosely and then
 * ranks and highlights the results itself.
 *
 * @param {string} name
 * @param {string} query
 * @returns {boolean}
 */
function matchesQuery(name, query) {
  const lowerName = name.toLowerCase();
  let at = 0;
  for (const ch of query.toLowerCase()) {
    if (/\s/.test(ch)) continue;
    at = lowerName.indexOf(ch, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * Registers the workspace symbol provider and its file watcher.
 *
 * @param {import("../helpers").Settings} settings - Live settings, updated in
 *   place by the settings listener in extension.js
 * @returns {{
 *   disposables: vscode.Disposable[],
 *   setModuleIndexEntry: (uri: vscode.Uri, text: string) => void,
 *   indexModuleFile: (uri: vscode.Uri) => Promise<void>,
 *   removeModuleIndexEntry: (uri: vscode.Uri) => void,
 *   listModules: import("../document-index").ListWorkspaceModules,
 *   listFiles: () => Promise<vscode.Uri[]>
 * }} The index operations extension.js calls on document events;
 *   `listModules` for the cross-file module features (completion, hover and
 *   signature help on `call`, Go to Definition, Rename, Find References), and
 *   `listFiles` for module Rename and Find References across files
 */
function registerWorkspaceSymbols(settings) {
  // ============================================================
  // WORKSPACE SYMBOL PROVIDER (module declarations across files)
  // ============================================================
  // Powers "Go to Symbol in Workspace" (Ctrl+T): every `module` declaration in
  // every .otter/.oscript file in the workspace. Backed by an in-memory index
  // and kept fresh by a file-system watcher. The open editor's live/unsaved view
  // is still served by the document symbol provider.
  //
  // The index is built lazily: activation does NO disk I/O for it. The first
  // use -- Ctrl+T, or a cross-file module feature (Go to Definition, Rename,
  // Find References, hover, completion and signature help on `call`) --
  // triggers the one-time scan; the watcher then keeps it current. Workspaces
  // that never use them never pay for it.
  //
  // `otterscript.workspaceSymbols.enable` turns off only the Ctrl+T provider;
  // the cross-file module features keep the index.

  const OTTER_FILE_GLOB = "**/*.{otter,oscript}";
  /**
   * Whether a document belongs in the index: a file on disk, an untitled
   * document while it's open, or a file of a workspace folder whatever its
   * scheme (a virtual workspace's `vscode-vfs:`). Other schemes (a Git
   * diff's old side, a PR review, ...) are extra views of a file and would
   * show up as duplicates.
   *
   * @param {vscode.Uri} uri
   * @returns {boolean}
   */
  function isIndexed(uri) {
    return uri.scheme === "file" || uri.scheme === "untitled" || vscode.workspace.getWorkspaceFolder(uri) !== undefined;
  }
  // Cap on the workspace scan: files matched, and concurrent reads in flight.
  const WORKSPACE_SCAN_FILE_LIMIT = 5000;
  const WORKSPACE_SCAN_CONCURRENCY = 20;

  /**
   * @typedef {{ uri: vscode.Uri, symbols: { name: string, range: vscode.Range }[] }} ModuleIndexEntry
   */
  /** @type {Map<string, ModuleIndexEntry>} keyed by uri.toString() */
  const workspaceModuleIndex = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const workspaceIndexTimers = new Map();

  /**
   * Applies (or clears, when it declares no modules) one file's module-index
   * entry from its text.
   *
   * @param {vscode.Uri} uri
   * @param {string} text
   * @returns {void}
   */
  function setModuleIndexEntry(uri, text) {
    if (!isIndexed(uri)) return;
    const symbols = findModuleDeclarations(text).map(hit => ({
      name: hit.name,
      range: new vscode.Range(
        hit.line, hit.character, hit.line, hit.character + hit.name.length
      ),
    }));

    if (symbols.length > 0) {
      workspaceModuleIndex.set(uri.toString(), { uri, symbols });
    } else {
      workspaceModuleIndex.delete(uri.toString());
    }
  }

  /**
   * Reads one file from disk and refreshes (or removes) its module-index entry.
   *
   * @param {vscode.Uri} uri
   * @returns {Promise<void>}
   */
  async function indexModuleFile(uri) {
    if (!isIndexed(uri)) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      setModuleIndexEntry(uri, UTF8.decode(bytes));
    } catch {
      // Gone or unreadable -- drop it.
      workspaceModuleIndex.delete(uri.toString());
    }
  }

  /**
   * Rescans every OtterScript file in the workspace from scratch.
   *
   * @returns {Promise<void>}
   */
  async function rebuildWorkspaceModuleIndex() {
    workspaceModuleIndex.clear();

    const files = await vscode.workspace.findFiles(
      OTTER_FILE_GLOB, undefined, WORKSPACE_SCAN_FILE_LIMIT
    );
    // Bounded concurrency -- avoid firing thousands of fs.readFile at once.
    await mapWithConcurrency(files, WORKSPACE_SCAN_CONCURRENCY, indexModuleFile);

    // Also cover already-open OtterScript documents. This is what makes the
    // provider work for loose files and for a window with no folder open, where
    // findFiles returns nothing.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === "otterscript") setModuleIndexEntry(doc.uri, doc.getText());
    }

    const moduleCount = [...workspaceModuleIndex.values()].reduce((n, e) => n + e.symbols.length, 0);
    log.info(
      `Workspace module index: ${moduleCount} module(s) in ${workspaceModuleIndex.size} file(s) ` +
      `(${files.length} on disk)`
    );
  }

  // Lazily-built index. `null` until the first query kicks off
  // rebuildWorkspaceModuleIndex. Reset to `null` on failure so the next query
  // retries.
  /** @type {Promise<void> | null} */
  let workspaceIndexReady = null;

  /**
   * Ensures the workspace module index has been built (once), returning the
   * in-flight or settled build promise. Callers await this before reading
   * `workspaceModuleIndex`.
   *
   * @returns {Promise<void>}
   */
  function ensureWorkspaceIndex() {
    if (!workspaceIndexReady) {
      workspaceIndexReady = rebuildWorkspaceModuleIndex().catch(err => {
        log.error("Failed to build workspace module index", err);
        workspaceIndexReady = null; // let the next query retry
      });
    }
    return workspaceIndexReady;
  }

  const workspaceSymbolProvider = vscode.languages.registerWorkspaceSymbolProvider({
    /**
     * @param {string} query
     * @returns {Promise<vscode.SymbolInformation[]>}
     */
    async provideWorkspaceSymbols(query) {
      if (!settings.workspaceSymbolsEnabled) return [];
      await ensureWorkspaceIndex();

      /** @type {vscode.SymbolInformation[]} */
      const results = [];
      for (const { uri, symbols } of workspaceModuleIndex.values()) {
        for (const { name, range } of symbols) {
          if (!matchesQuery(name, query)) continue;
          results.push(new vscode.SymbolInformation(
            name,
            vscode.SymbolKind.Module,
            "",
            new vscode.Location(uri, range)
          ));
        }
      }
      return results;
    }
  });

  // Watcher events only matter once the index has actually been built: before
  // its first use there is nothing to keep fresh, and touching it here would
  // leave a misleading partial index. `!workspaceIndexReady` covers both "never
  // built" and "last build failed"; the next query rebuilds from scratch anyway.
  const otterFileWatcher = vscode.workspace.createFileSystemWatcher(OTTER_FILE_GLOB);
  otterFileWatcher.onDidCreate(uri => {
    if (!workspaceIndexReady) return;
    void indexModuleFile(uri);
  });
  otterFileWatcher.onDidDelete(uri => {
    workspaceModuleIndex.delete(uri.toString());
    clearTimerForUri(workspaceIndexTimers, uri);
  });
  otterFileWatcher.onDidChange(uri => {
    // Gated so no debounce timers accumulate in workspaceIndexTimers before
    // the index has been built.
    if (!workspaceIndexReady) return;
    // Debounced -- a save can arrive alongside editor change events.
    scheduleTimerForUri(workspaceIndexTimers, uri, 400, () => { void indexModuleFile(uri); });
  });

  /**
   * Cancels every pending index debounce timer.
   *
   * @returns {void}
   */
  function clearIndexTimers() {
    for (const timer of workspaceIndexTimers.values()) clearTimeout(timer);
    workspaceIndexTimers.clear();
  }

  /**
   * Every module declared in the workspace, building the index first if
   * nothing has yet.
   *
   * @returns {Promise<import("../document-index").WorkspaceModule[]>}
   */
  async function listModules() {
    await ensureWorkspaceIndex();
    return [...workspaceModuleIndex.values()].flatMap(({ uri, symbols }) => symbols.map(({ name, range }) => ({ name, uri, range })));
  }

  /**
   * Every OtterScript file in the workspace, plus open untitled ones -- the
   * files a module's calls may be in. Read fresh each time (the index keeps
   * only files that declare modules).
   *
   * @returns {Promise<vscode.Uri[]>}
   */
  async function listFiles() {
    /** @type {Map<string, vscode.Uri>} */
    const files = new Map();
    for (const uri of await vscode.workspace.findFiles(OTTER_FILE_GLOB, undefined, WORKSPACE_SCAN_FILE_LIMIT)) {
      files.set(uri.toString(), uri);
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === "otterscript" && isIndexed(doc.uri)) files.set(doc.uri.toString(), doc.uri);
    }
    return [...files.values()];
  }

  return {
    disposables: [
      workspaceSymbolProvider,
      otterFileWatcher,
      // Cancel any pending index debounce timers on deactivation.
      { dispose: clearIndexTimers },
    ],
    setModuleIndexEntry,
    indexModuleFile,
    removeModuleIndexEntry: (uri) => { workspaceModuleIndex.delete(uri.toString()); },
    listModules,
    listFiles,
  };
}

module.exports = { matchesQuery, registerWorkspaceSymbols };
