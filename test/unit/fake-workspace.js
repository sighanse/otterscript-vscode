// @ts-check
/**
 * @fileoverview A fake VS Code workspace for the unit tests of the
 * cross-file features: files "on disk", the open documents, and what the
 * code under test registered (see `registrations` in vscode-stub.js); and
 * {@link stubProperty}, for replacing one member of the stub in a test.
 */

const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");

/** The stub's workspace, typed loosely so a test can replace its members. */
const workspace = /** @type {any} */ (stub.workspace);

/**
 * The version of the next document opened from disk. The caches go by URI
 * and version, and tests reuse URIs (`file:///lib.otter`) for other text, so
 * each opened document is a new version.
 */
let nextVersion = 1000;

/** The members {@link useWorkspace} replaces, as the stub has them. */
const defaults = {
  textDocuments: workspace.textDocuments,
  workspaceFolders: workspace.workspaceFolders,
  getWorkspaceFolder: workspace.getWorkspaceFolder,
  findFiles: workspace.findFiles,
  openTextDocument: workspace.openTextDocument,
  fs: workspace.fs,
};

/**
 * Makes the stub's workspace hold `files` on disk (an OtterScript file each)
 * and `open` as the open documents. Reading a file counts in `reads`;
 * opening one returns the open document for it, or a new one from its text.
 * Call `restore` after the test.
 *
 * @param {{ files?: Record<string, string>, open?: any[] }} [contents] -
 *   `files`: text by URI (`file:///a.otter`)
 * @returns {{ reads: string[], opened: string[], restore(): void }}
 */
function useWorkspace({ files = {}, open = [] } = {}) {
  /** @type {string[]} */
  const reads = [];
  /** @type {string[]} */
  const opened = [];
  /** @param {{ toString(): string }} uri */
  const textOf = (uri) => {
    const text = files[uri.toString()];
    if (text === undefined) throw new Error(`No such file: ${uri}`);
    return text;
  };
  Object.assign(workspace, {
    textDocuments: open,
    findFiles: async () => Object.keys(files).map(stub.Uri.parse),
    /** @param {{ toString(): string }} uri */
    openTextDocument: async (uri) => {
      opened.push(uri.toString());
      return open.find((d) => d.uri.toString() === uri.toString()) ?? makeDocument(textOf(uri), { uri: uri.toString(), version: nextVersion++ });
    },
    fs: {
      /** @param {{ toString(): string }} uri */
      stat: async (uri) => ({ size: textOf(uri).length }),
      /** @param {{ toString(): string }} uri */
      readFile: async (uri) => {
        reads.push(uri.toString());
        return new TextEncoder().encode(textOf(uri));
      },
    },
  });
  return { reads, opened, restore: () => Object.assign(workspace, defaults) };
}

/**
 * The properties {@link stubProperty} has mocked, per test.
 * @type {WeakMap<import("node:test").TestContext, Map<object, Set<string>>>}
 */
const stubbed = new WeakMap();

/**
 * Sets `object[key]` to `value` until the test `t` ends, passed or failed
 * (`t.mock.property`, which restores it). A property is mocked once per
 * test and set through its mock after that: mocking it a second time makes
 * Node's mock loop forever (Node 22 to 25). Typed loosely: the Node types
 * (18, for VS Code's Node) don't know `mock.property`.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} object - Such as `stub.workspace`
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function stubProperty(t, object, key, value) {
  if (!stubbed.has(t)) stubbed.set(t, new Map());
  const keys = /** @type {Map<object, Set<string>>} */ (stubbed.get(t));
  if (!keys.has(object)) keys.set(object, new Set());
  const mocked = /** @type {Set<string>} */ (keys.get(object));
  if (mocked.has(key)) {
    /** @type {any} */ (object)[key] = value;
    return;
  }
  mocked.add(key);
  /** @type {any} */ (t.mock).property(object, key, value);
}

/**
 * Clears the stub's registrations and runs `register`, then returns what
 * it registered: the providers by kind (`RenameProvider`, ...; a list where
 * a kind repeats), the arguments after each (`options`, in the same order)
 * and the commands by id.
 *
 * @param {() => unknown} register
 * @returns {{ providers: Record<string, any[]>, options: Record<string, any[][]>, commands: Record<string, (...args: any[]) => any> }}
 */
function captureRegistrations(register) {
  stub.registrations.length = 0;
  register();
  /** @type {Record<string, any[]>} */
  const providers = {};
  /** @type {Record<string, any[][]>} */
  const options = {};
  /** @type {Record<string, (...args: any[]) => any>} */
  const commands = {};
  for (const registration of stub.registrations) {
    const { kind, id, callback } = registration;
    if (kind === "command" && id && callback) {
      commands[id] = callback;
    } else {
      (providers[kind] ??= []).push(registration.provider);
      (options[kind] ??= []).push(registration.options ?? []);
    }
  }
  return { providers, options, commands };
}

module.exports = { captureRegistrations, stubProperty, useWorkspace };
