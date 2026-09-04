// @ts-check
/**
 * @fileoverview Minimal `vscode` module stub for unit tests.
 *
 * `helpers.js` does `require("vscode")` at load time and constructs a handful of
 * VS Code value types (`Position`, `Range`, `Diagnostic`, `FoldingRange`) inside
 * the functions under test. The real `vscode` module only exists inside the
 * extension host, so this file provides just enough of that surface and installs
 * itself into the module loader.
 *
 * Usage — require this **before** requiring anything that pulls in `vscode`:
 *
 *   require("../vscode-stub");
 *   const { checkMissingDollar } = require("../../src/helpers.js");
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
 * Mirrors the subset of `vscode.MarkdownString` that `buildHoverMarkdown` uses:
 * a growable `value` string plus `appendMarkdown`, and the `isTrusted` flag.
 */
class MarkdownString {
  constructor() {
    this.value = "";
    /** @type {boolean} */
    this.isTrusted = false;
  }

  /**
   * @param {string} text
   * @returns {this}
   */
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}

/** Mirrors `vscode.CodeActionKind` (only the members helpers.js references). */
const CodeActionKind = Object.freeze({ QuickFix: "quickfix" });

class CodeAction {
  /**
   * @param {string} title
   * @param {string} [kind]
   */
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    /** @type {Diagnostic[]} */
    this.diagnostics = [];
    this.isPreferred = false;
    /** @type {WorkspaceEdit | undefined} */
    this.edit = undefined;
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
}

// Only `appendLine` is exercised (helpers.js `appendOutputLine`); extend if a
// future test drives more of the logger.
const outputChannel = {
  appendLine() {},
  name: "OtterScript (stub)",
};

const vscode = {
  Position,
  Range,
  Diagnostic,
  DiagnosticSeverity,
  FoldingRange,
  FoldingRangeKind,
  MarkdownString,
  CodeAction,
  CodeActionKind,
  WorkspaceEdit,
  window: {
    createOutputChannel: () => outputChannel,
  },
  workspace: {
    getConfiguration: () => ({
      /**
       * @param {string} _key
       * @param {unknown} [fallback]
       */
      get: (_key, fallback) => fallback,
    }),
  },
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
