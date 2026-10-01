// @ts-check
/**
 * @fileoverview A minimal `vscode.TextDocument` stand-in shared by the unit
 * tests: enough for the providers, diagnostics and quick fixes under test.
 *
 * Every document gets its own URI unless one is given. The helpers cache
 * per-document results keyed by URI and version, so two test documents
 * sharing a URI (and version) would see each other's cached results.
 */

const { Position, Range } = require("../vscode-stub");

let nextDocumentId = 0;

/**
 * @param {string} text
 * @param {{ uri?: string, languageId?: string, version?: number }} [options] -
 *   `uri` defaults to a fresh `file:///test-<n>.otter`; `languageId` to
 *   `"otterscript"`; `version` to 1
 * @returns {any} Typed loosely so tests can pass it where a TextDocument is expected
 */
function makeDocument(text, options = {}) {
  const {
    uri = `file:///test-${nextDocumentId++}.otter`,
    languageId = "otterscript",
    version = 1,
  } = options;
  const lines = text.split("\n");

  /** @param {{ line: number, character: number }} position */
  const offsetAt = (position) => {
    let offset = 0;
    for (let i = 0; i < position.line; i++) offset += lines[i].length + 1;
    return offset + position.character;
  };
  /** @param {number} offset */
  const positionAt = (offset) => {
    let remaining = Math.max(0, offset);
    let line = 0;
    while (line < lines.length - 1 && remaining > lines[line].length) {
      remaining -= lines[line].length + 1; // +1 for the '\n'
      line++;
    }
    return new Position(line, remaining);
  };

  return {
    uri: { toString: () => uri, fsPath: uri.replace(/^file:\/\//, ""), scheme: uri.split(":")[0] },
    languageId,
    version,
    lineCount: lines.length,
    offsetAt,
    positionAt,
    /** @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} [range] */
    getText: (range) => (range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text),
    /** @param {number} i */
    lineAt: (i) => ({ text: lines[i], range: new Range(new Position(i, 0), new Position(i, lines[i].length)) }),
  };
}

module.exports = { makeDocument };
