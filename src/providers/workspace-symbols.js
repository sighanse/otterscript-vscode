// @ts-check
/**
 * @fileoverview Go to Symbol in Workspace (Ctrl+T) for OtterScript modules: a
 * lazily built index of every `module` declaration in the workspace, kept
 * current by a file watcher and by the open documents.
 */

const vscode = require("vscode");
const { clearTimerForUri, log, mapWithConcurrency, scheduleTimerForUri } = require("../helpers");
const { findModuleDeclarations } = require("../scanner");

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
 *   resetWorkspaceIndex: () => void,
 *   listModules: () => Promise<{ name: string, uri: vscode.Uri, range: vscode.Range }[]>
 * }} The index operations extension.js calls on document events and
 *   settings changes, and `listModules` for module-name completion and
 *   Go to Definition across files
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
  // Ctrl+T (provideWorkspaceSymbols) triggers the one-time scan; the watcher
  // then keeps it current. Workspaces that never use Ctrl+T never pay for it.
  //
  // All index work is also gated on `otterscript.workspaceSymbols.enable`: when
  // it is off, no scanning, disk reads, or index mutations happen.

  const OTTER_FILE_GLOB = "**/*.{otter,oscript}";
  // Documents that belong in the index: files on disk, plus untitled ones
  // while they're open. Other schemes (a Git diff's old side, a PR review,
  // ...) are extra views of a file and would show up as duplicates.
  const INDEXED_SCHEMES = new Set(["file", "untitled"]);
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
    if (!settings.workspaceSymbolsEnabled || !INDEXED_SCHEMES.has(uri.scheme)) return;
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
    if (!settings.workspaceSymbolsEnabled) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      setModuleIndexEntry(uri, new TextDecoder("utf-8").decode(bytes));
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
    if (!settings.workspaceSymbolsEnabled) return;

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

  // Lazily-built index. `null` until the first workspace-symbol query (or a
  // watcher event once a build has happened) kicks off rebuildWorkspaceModuleIndex.
  // Reset to `null` on failure so the next query retries, and when the enable
  // setting is toggled (resetWorkspaceIndex, called by the settings listener
  // in extension.js).
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

      const needle = query.toLowerCase();
      /** @type {vscode.SymbolInformation[]} */
      const results = [];
      for (const { uri, symbols } of workspaceModuleIndex.values()) {
        for (const { name, range } of symbols) {
          if (needle && !name.toLowerCase().includes(needle)) continue;
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
  // the first Ctrl+T there is nothing to keep fresh, and touching it here would
  // leave a misleading partial index. `!workspaceIndexReady` covers both "never
  // built" and "last build failed"; the next query rebuilds from scratch anyway.
  const otterFileWatcher = vscode.workspace.createFileSystemWatcher(OTTER_FILE_GLOB);
  otterFileWatcher.onDidCreate(uri => {
    if (!settings.workspaceSymbolsEnabled || !workspaceIndexReady) return;
    void indexModuleFile(uri);
  });
  otterFileWatcher.onDidDelete(uri => {
    workspaceModuleIndex.delete(uri.toString());
    clearTimerForUri(workspaceIndexTimers, uri);
  });
  otterFileWatcher.onDidChange(uri => {
    // Gated so no debounce timers accumulate in workspaceIndexTimers when the
    // feature is off or the index has not been built yet.
    if (!settings.workspaceSymbolsEnabled || !workspaceIndexReady) return;
    // Debounced -- a save can arrive alongside editor change events.
    scheduleTimerForUri(workspaceIndexTimers, uri, 400, () => { void indexModuleFile(uri); });
  });

  /**
   * Resets the lazy workspace index when `otterscript.workspaceSymbols.enable`
   * flips. Either way: enabling does NOT eagerly scan (the next Ctrl+T builds
   * it, like a fresh activation); disabling drops the index and any pending
   * debounce timers.
   *
   * @returns {void}
   */
  function resetWorkspaceIndex() {
    workspaceModuleIndex.clear();
    clearIndexTimers();
    workspaceIndexReady = null;
  }

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
   * Every module declared in the workspace, building the index first if no
   * Ctrl+T has yet. Empty when `otterscript.workspaceSymbols.enable` is off.
   *
   * @returns {Promise<{ name: string, uri: vscode.Uri, range: vscode.Range }[]>}
   */
  async function listModules() {
    if (!settings.workspaceSymbolsEnabled) return [];
    await ensureWorkspaceIndex();
    return [...workspaceModuleIndex.values()].flatMap(({ uri, symbols }) => symbols.map(({ name, range }) => ({ name, uri, range })));
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
    resetWorkspaceIndex,
    listModules,
  };
}

module.exports = { registerWorkspaceSymbols };
