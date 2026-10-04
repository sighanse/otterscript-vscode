// @ts-check
/**
 * @fileoverview Minimal `vscode` module stub for unit tests.
 *
 * `helpers.js`, `diagnostics.js`, and `adaptivecard.js` do `require("vscode")` at
 * load time and construct a handful of VS Code value types (`Position`, `Range`,
 * `Diagnostic`, `FoldingRange`, ...) inside the functions under test. The real `vscode` module only exists inside the
 * extension host, so this file provides just enough of that surface and installs
 * itself into the module loader.
 *
 * Usage — require this **before** requiring anything that pulls in `vscode`:
 *
 *   require("../vscode-stub");
 *   const { checkMissingDollar } = require("../../src/diagnostics.js");
 *
 * Only the members actually exercised by the tests are implemented; enum values
 * mirror the real `vscode` API so assertions on `.severity` / `.kind` are
 * meaningful.
 */

// Module._load is a private Node internal; intercepting it is the least-invasive
// way to alias a bare specifier that has no on-disk file. Cast away the types
// for that one access; everything else in this file stays checked.
const Mod = /** @type {any} */ (require("node:module"));

class Position {
  /**
   * @param {number} line
   * @param {number} character
   */
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }

  /**
   * @param {number} [lineDelta]
   * @param {number} [characterDelta]
   * @returns {Position}
   */
  translate(lineDelta = 0, characterDelta = 0) {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  /**
   * @param {Position} other
   * @returns {number} Negative when this is before `other`, 0 when equal
   */
  compareTo(other) {
    return this.line - other.line || this.character - other.character;
  }

  /**
   * @param {Position} other
   * @returns {boolean}
   */
  isEqual(other) {
    return this.compareTo(other) === 0;
  }
}

class Range {
  /**
   * Accepts either `(start, end)` positions or `(startLine, startChar, endLine, endChar)`,
   * matching the real `vscode.Range` overloads.
   *
   * @param {Position | number} startOrStartLine
   * @param {Position | number} endOrStartChar
   * @param {number} [endLine]
   * @param {number} [endChar]
   */
  constructor(startOrStartLine, endOrStartChar, endLine, endChar) {
    if (typeof startOrStartLine === "number" && typeof endOrStartChar === "number") {
      this.start = new Position(startOrStartLine, endOrStartChar);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    } else {
      this.start = /** @type {Position} */ (startOrStartLine);
      this.end = /** @type {Position} */ (endOrStartChar);
    }
  }

  /**
   * @param {Range} other
   * @returns {boolean}
   */
  isEqual(other) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
}

class Location {
  /**
   * @param {unknown} uri
   * @param {Range | Position} rangeOrPosition
   */
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range =
      rangeOrPosition instanceof Position
        ? new Range(rangeOrPosition, rangeOrPosition)
        : rangeOrPosition;
  }
}

class DiagnosticRelatedInformation {
  /**
   * @param {Location} location
   * @param {string} message
   */
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}

/** Mirrors `vscode.DiagnosticSeverity`. */
const DiagnosticSeverity = Object.freeze({ Error: 0, Warning: 1, Information: 2, Hint: 3 });

class Diagnostic {
  /**
   * @param {Range} range
   * @param {string} message
   * @param {number} [severity]
   */
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
    /** @type {string | number | undefined} */
    this.code = undefined;
    /** @type {string | undefined} */
    this.source = undefined;
    /** @type {DiagnosticRelatedInformation[] | undefined} */
    this.relatedInformation = undefined;
  }
}

/** Mirrors `vscode.FoldingRangeKind`. */
const FoldingRangeKind = Object.freeze({ Comment: 1, Imports: 2, Region: 3 });

class FoldingRange {
  /**
   * @param {number} start
   * @param {number} end
   * @param {number} [kind]
   */
  constructor(start, end, kind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

/**
 * Mirrors `vscode.MarkdownString`: a growable `value`, with `appendText` and
 * `appendCodeblock` writing exactly what VS Code's do, so a test sees the
 * markdown VS Code would get.
 */
class MarkdownString {
  /** @param {string} [value] - Markdown to start with */
  constructor(value = "") {
    this.value = value;
  }

  /**
   * @param {string} text
   * @returns {this}
   */
  appendMarkdown(text) {
    this.value += text;
    return this;
  }

  /**
   * Text shown as is: markdown syntax escaped, spaces kept, a line break a
   * new paragraph (VS Code's `appendText`).
   *
   * @param {string} text
   * @returns {this}
   */
  appendText(text) {
    this.value += text
      .replace(/[\\`*_{}[\]()#+\-!~]/g, "\\$&")
      .replace(/([ \t]+)/g, (_match, run) => "&nbsp;".repeat(run.length))
      .replace(/>/gm, "\\>")
      .replace(/\n/g, "\n\n");
    return this;
  }

  /**
   * @param {string} code
   * @param {string} [language]
   * @returns {this}
   */
  appendCodeblock(code, language = "") {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

/** Mirrors `vscode.Hover`: what to show, and the range it's for. */
class Hover {
  /**
   * @param {MarkdownString} contents
   * @param {Range} [range]
   */
  constructor(contents, range) {
    this.contents = [contents];
    this.range = range;
  }
}

/**
 * Mirrors the subset of `vscode.CompletionItem` that `buildCompletionItem`
 * touches: a `label` (string or `{ label, description }`) + `kind`, then the
 * fields it assigns afterwards.
 */
class CompletionItem {
  /**
   * @param {string | { label: string, description?: string }} label
   * @param {unknown} [kind]
   */
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
    /** @type {unknown} */
    this.insertText = undefined;
    /** @type {string | undefined} */
    this.detail = undefined;
    /** @type {unknown} */
    this.documentation = undefined;
    /** @type {string | undefined} */
    this.sortText = undefined;
    /** @type {{ command: string, title: string } | undefined} */
    this.command = undefined;
  }
}

/**
 * Mirrors `vscode.CodeActionKind`: a dotted name (`source.fixAll.otterscript`)
 * that can be extended and compared hierarchically.
 */
class CodeActionKind {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
  }

  /**
   * @param {string} part
   * @returns {CodeActionKind}
   */
  append(part) {
    return new CodeActionKind(`${this.value}.${part}`);
  }

  /**
   * Whether `other` is this kind or one under it.
   *
   * @param {CodeActionKind} other
   * @returns {boolean}
   */
  contains(other) {
    return other.value === this.value || other.value.startsWith(`${this.value}.`);
  }

  /**
   * Whether either kind contains the other.
   *
   * @param {CodeActionKind} other
   * @returns {boolean}
   */
  intersects(other) {
    return this.contains(other) || other.contains(this);
  }
}
CodeActionKind.QuickFix = new CodeActionKind("quickfix");
CodeActionKind.SourceFixAll = new CodeActionKind("source.fixAll");

class CodeAction {
  /**
   * @param {string} title
   * @param {CodeActionKind} [kind]
   */
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    /** @type {Diagnostic[]} */
    this.diagnostics = [];
    this.isPreferred = false;
    /** @type {WorkspaceEdit | undefined} */
    this.edit = undefined;
    /** @type {{ command: string, title: string, arguments?: unknown[] } | undefined} */
    this.command = undefined;
  }
}

/**
 * Mirrors the subset of `vscode.WorkspaceEdit` the fix factories use. Records
 * edits as `[op, ...args]` tuples on `.edits` for assertions.
 */
class WorkspaceEdit {
  constructor() {
    /** @type {Array<[string, unknown, unknown, unknown]>} */
    this.edits = [];
  }

  /**
   * @param {unknown} uri
   * @param {Range} range
   * @param {string} newText
   */
  replace(uri, range, newText) {
    this.edits.push(["replace", uri, range, newText]);
  }

  /**
   * @param {unknown} uri
   * @param {Position} position
   * @param {string} newText
   */
  insert(uri, position, newText) {
    this.edits.push(["insert", uri, position, newText]);
  }

  /**
   * The edits per file, as VS Code's `entries()` gives them: an insert is a
   * text edit with an empty range.
   *
   * @returns {[{ toString(): string }, { range: Range, newText: string }[]][]}
   */
  entries() {
    /** @type {Map<string, [{ toString(): string }, { range: Range, newText: string }[]]>} */
    const byUri = new Map();
    for (const [op, uri, where, newText] of this.edits) {
      const key = String(uri);
      if (!byUri.has(key)) byUri.set(key, [/** @type {{ toString(): string }} */ (uri), []]);
      const range = op === "insert"
        ? new Range(/** @type {Position} */ (where), /** @type {Position} */ (where))
        : /** @type {Range} */ (where);
      byUri.get(key)?.[1].push({ range, newText: /** @type {string} */ (newText) });
    }
    return [...byUri.values()];
  }
}

/** Mirrors `vscode.DocumentHighlightKind`. */
const DocumentHighlightKind = Object.freeze({ Text: 0, Read: 1, Write: 2 });

/** Mirrors `vscode.DocumentHighlight`. */
class DocumentHighlight {
  /**
   * @param {Range} range
   * @param {number} [kind]
   */
  constructor(range, kind = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

/** Mirrors `vscode.SymbolKind` (only the members the providers use). */
const SymbolKind = Object.freeze({ Module: 1 });

/** Mirrors `vscode.DocumentSymbol`. */
class DocumentSymbol {
  /**
   * @param {string} name
   * @param {string} detail
   * @param {number} kind
   * @param {Range} range - The whole declaration
   * @param {Range} selectionRange - Its name
   */
  constructor(name, detail, kind, range, selectionRange) {
    Object.assign(this, { name, detail, kind, range, selectionRange });
  }
}

/** Mirrors `vscode.SymbolInformation` (the overload with a Location). */
class SymbolInformation {
  /**
   * @param {string} name
   * @param {number} kind
   * @param {string} containerName
   * @param {Location} location
   */
  constructor(name, kind, containerName, location) {
    Object.assign(this, { name, kind, containerName, location });
  }
}

/** Mirrors `vscode.CodeLens`. */
class CodeLens {
  /**
   * @param {Range} range
   * @param {{ title: string, command: string, arguments?: unknown[] }} [command]
   */
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

/**
 * Mirrors `vscode.EventEmitter`: `event` subscribes a listener, `fire` calls
 * every listener.
 *
 * @template T
 */
class EventEmitter {
  constructor() {
    /** @type {((value: T) => void)[]} */
    this.listeners = [];
    /**
     * @param {(value: T) => void} listener
     * @returns {{ dispose(): void }}
     */
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
  }

  /** @param {T} value */
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }

  dispose() {
    this.listeners = [];
  }
}

/**
 * Everything the code under test registered with VS Code, in order: each
 * provider (`kind` is the `register...` name without `register`, such as
 * `RenameProvider`) and each command. A test clears it, calls a
 * `register...` function, and calls what it registered as VS Code would.
 *
 * @type {{ kind: string, provider?: any, metadata?: any, id?: string, callback?: (...args: any[]) => any }[]}
 */
const registrations = [];

/**
 * A `languages.register...Provider` that records the provider.
 *
 * @param {string} kind
 * @returns {(...args: any[]) => { dispose(): void }}
 */
function recordProvider(kind) {
  return (...args) => {
    // registerWorkspaceSymbolProvider is the one without a selector.
    const [provider, metadata] = kind === "WorkspaceSymbolProvider" ? args : args.slice(1);
    registrations.push({ kind, provider, metadata });
    return { dispose() {} };
  };
}

/** @type {any[]} Every file system watcher created, newest last. */
const watchers = [];

/**
 * A file system watcher that records its listeners; its `fire` plays an
 * event to them.
 *
 * @returns {any}
 */
function createFileSystemWatcher() {
  /** @type {Record<string, ((uri: any) => void)[]>} */
  const listeners = { create: [], change: [], delete: [] };
  const watcher = {
    /** @param {(uri: any) => void} l */
    onDidCreate: (l) => { listeners.create.push(l); },
    /** @param {(uri: any) => void} l */
    onDidChange: (l) => { listeners.change.push(l); },
    /** @param {(uri: any) => void} l */
    onDidDelete: (l) => { listeners.delete.push(l); },
    /**
     * @param {"create" | "change" | "delete"} event
     * @param {any} uri
     */
    fire: (event, uri) => { for (const l of listeners[event]) l(uri); },
    dispose() {},
  };
  watchers.push(watcher);
  return watcher;
}

/**
 * Mirrors `vscode.Uri.parse` for the members the code reads.
 *
 * @param {string} value
 * @returns {{ toString(): string, scheme: string, fsPath: string }}
 */
function parseUri(value) {
  return { toString: () => value, scheme: value.split(":")[0], fsPath: value.replace(/^file:\/\//, "") };
}

// A log output channel (helpers.js `log`) that drops every line; extend if a
// future test drives more of the logger.
const outputChannel = {
  appendLine() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  name: "OtterScript (stub)",
};
/** Mirrors `vscode.CompletionItemKind` (only the members the providers use). */
const CompletionItemKind = Object.freeze({
  Function: "function",
  Variable: "variable",
  Keyword: "keyword",
  Snippet: "snippet",
  Property: "property",
  Module: "module",
  Class: "class",
  EnumMember: "enumMember",
  Reference: "reference",
});

/** Mirrors `vscode.CompletionTriggerKind`: how completion was asked for. */
const CompletionTriggerKind = Object.freeze({ Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 });

/** Mirrors `vscode.SnippetString`: the snippet text is on `.value`. */
class SnippetString {
  /** @param {string} [value] */
  constructor(value = "") {
    this.value = value;
  }
}

const vscode = {
  Position,
  Range,
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  FoldingRange,
  FoldingRangeKind,
  Location,
  MarkdownString,
  Hover,
  CompletionItem,
  CompletionItemKind,
  CompletionTriggerKind,
  CompletionItemTag: Object.freeze({ Deprecated: 1 }),
  SnippetString,
  CodeAction,
  CodeActionKind,
  WorkspaceEdit,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentSymbol,
  SymbolKind,
  SymbolInformation,
  CodeLens,
  EventEmitter,
  ConfigurationTarget: Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 }),
  EndOfLine: Object.freeze({ LF: 1, CRLF: 2 }),
  Uri: Object.freeze({ parse: parseUri }),
  languages: {
    registerDefinitionProvider: recordProvider("DefinitionProvider"),
    registerRenameProvider: recordProvider("RenameProvider"),
    registerReferenceProvider: recordProvider("ReferenceProvider"),
    registerDocumentHighlightProvider: recordProvider("DocumentHighlightProvider"),
    registerDocumentSymbolProvider: recordProvider("DocumentSymbolProvider"),
    registerCodeLensProvider: recordProvider("CodeLensProvider"),
    registerFoldingRangeProvider: recordProvider("FoldingRangeProvider"),
    registerWorkspaceSymbolProvider: recordProvider("WorkspaceSymbolProvider"),
    registerCodeActionsProvider: recordProvider("CodeActionsProvider"),
  },
  commands: {
    /**
     * @param {string} id
     * @param {(...args: any[]) => any} callback
     * @returns {{ dispose(): void }}
     */
    registerCommand: (id, callback) => {
      registrations.push({ kind: "command", id, callback });
      return { dispose() {} };
    },
  },
  window: {
    createOutputChannel: () => outputChannel,
    /** @type {any} The editor a command acts on; tests set it. */
    activeTextEditor: undefined,
    /** @type {(message: string) => unknown} Tests replace it to see the message. */
    showInformationMessage: () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      /**
       * @param {string} _key
       * @param {unknown} [fallback]
       */
      get: (_key, fallback) => fallback,
    }),
    /**
     * A file's path as VS Code shows it: here, the URI after `file:///`.
     *
     * @param {{ toString(): string }} uri
     * @returns {string}
     */
    asRelativePath: (uri) => uri.toString().replace(/^file:\/\/\//, ""),
    // An empty workspace until a test fills it (see fake-workspace.js).
    /** @type {any[]} */
    textDocuments: [],
    /** @type {any[] | undefined} */
    workspaceFolders: undefined,
    /** @type {(uri: any) => unknown} */
    getWorkspaceFolder: () => undefined,
    /** @type {(...args: any[]) => Promise<any[]>} */
    findFiles: async () => [],
    /** @type {(uri: any) => Promise<any>} */
    openTextDocument: async (uri) => { throw new Error(`No such document: ${uri}`); },
    /** @type {(edit: any) => Promise<boolean>} */
    applyEdit: async () => true,
    /** @type {{ stat(uri: any): Promise<{ size: number }>, readFile(uri: any): Promise<Uint8Array> }} */
    fs: {
      stat: async (uri) => { throw new Error(`No such file: ${uri}`); },
      readFile: async (uri) => { throw new Error(`No such file: ${uri}`); },
    },
    /** @type {((e: { affectsConfiguration(section: string): boolean }) => void)[]} */
    configurationListeners: [],
    /**
     * @param {(e: { affectsConfiguration(section: string): boolean }) => void} listener
     * @returns {{ dispose(): void }}
     */
    onDidChangeConfiguration(listener) {
      this.configurationListeners.push(listener);
      return { dispose() {} };
    },
    createFileSystemWatcher,
  },
  registrations,
  watchers,
};

const originalLoad = Mod._load;
/**
 * @param {string} request
 * @param {unknown[]} rest
 */
Mod._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return originalLoad.call(this, request, ...rest);
};

module.exports = vscode;
