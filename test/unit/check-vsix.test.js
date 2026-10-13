// @ts-check
/**
 * @fileoverview Unit tests for scripts/check-vsix.js: reading a zip, and
 * each check of a package, on small archives built here.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  MAX_BUNDLE_BYTES,
  PACKAGED_FILES,
  activationRegistrations,
  checkPackage,
  readZip,
  sourceRegistrations,
} = require("../../scripts/check-vsix.js");
const pkg = require("../../package.json");

/**
 * A zip archive of `files`, the first stored and the rest deflated, as the
 * reader must handle both.
 *
 * @param {Record<string, string | Buffer>} files
 * @returns {Buffer}
 */
function zip(files) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const entries = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], i) => {
    const data = Buffer.from(content);
    const method = i === 0 ? 0 : 8;
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, stored);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    entries.push(entry, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  });
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A bundle that is src/extension.js itself, so it registers what src/ does. */
const SOURCE_BUNDLE = `module.exports = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "extension.js"))});`;

/** What src/ registers, computed once. */
const expected = sourceRegistrations();

/**
 * A package that passes every check, as files by name, with `changes`
 * applied (a null value removes the file).
 *
 * @param {Record<string, string | Buffer | null>} [changes]
 * @returns {Map<string, Buffer>}
 */
function packageFiles(changes = {}) {
  /** @type {Record<string, string | Buffer>} */
  const files = Object.fromEntries(PACKAGED_FILES.map((name) => [name, "x"]));
  files["extension.vsixmanifest"] =
    `<Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />` +
    `<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />`;
  files["extension/package.json"] = JSON.stringify({ version: pkg.version, main: pkg.main, browser: pkg.browser });
  files["extension/dist/extension.js"] = SOURCE_BUNDLE;
  files["extension/dist/web/extension.js"] = SOURCE_BUNDLE;
  for (const [name, content] of Object.entries(changes)) {
    if (content === null) delete files[name];
    else files[name] = content;
  }
  return readZip(zip(files));
}

describe("readZip", () => {
  it("reads stored and deflated entries", () => {
    const files = readZip(zip({ "a.txt": "stored", "dir/b.txt": "deflated ".repeat(100) }));
    assert.deepEqual([...files.keys()], ["a.txt", "dir/b.txt"]);
    assert.equal(files.get("a.txt")?.toString(), "stored");
    assert.equal(files.get("dir/b.txt")?.toString(), "deflated ".repeat(100));
  });

  it("rejects a file that isn't a zip", () => {
    assert.throws(() => readZip(Buffer.from("not a zip at all, just some text")), /not a zip archive/);
  });
});

describe("checkPackage", () => {
  it("accepts a package with the expected files, versions and bundles", () => {
    assert.ok(expected.includes("HoverProvider") && expected.includes("command otterscript.fixAll"), expected.join(", "));
    assert.deepEqual(checkPackage(packageFiles(), pkg, expected), []);
  });

  it("reports a missing file and one that doesn't belong", () => {
    assert.deepEqual(checkPackage(packageFiles({ "extension/images/logo.png": null, "extension/src/extension.js": "x" }), pkg, expected), [
      "missing extension/images/logo.png",
      "unexpected extension/src/extension.js (add it to .vscodeignore, or to PACKAGED_FILES in scripts/check-vsix.js if it belongs)",
    ]);
  });

  it("reports a manifest or packaged package.json of another version", () => {
    const manifest = `<Identity Id="${pkg.name}" Version="0.0.1" Publisher="${pkg.publisher}" /><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.99.0" />`;
    const packaged = JSON.stringify({ version: "0.0.1", main: pkg.main, browser: pkg.browser });
    assert.deepEqual(checkPackage(packageFiles({ "extension.vsixmanifest": manifest, "extension/package.json": packaged }), pkg, expected), [
      `extension.vsixmanifest: Version is 0.0.1, package.json says ${pkg.version}`,
      `extension.vsixmanifest: engine is ^1.99.0, package.json says ${pkg.engines.vscode}`,
      `extension/package.json: version is 0.0.1, package.json says ${pkg.version}`,
    ]);
  });

  it("reports a bundle with a source map, or too big", () => {
    const withMap = `${SOURCE_BUNDLE}\n//# sourceMappingURL=data:application/json;base64,e30=`;
    const big = `${SOURCE_BUNDLE}\n//${" ".repeat(MAX_BUNDLE_BYTES)}`;
    assert.deepEqual(checkPackage(packageFiles({ "extension/dist/extension.js": withMap, "extension/dist/web/extension.js": big }), pkg, expected), [
      "extension/dist/extension.js: has a source map (package with `npm run package`, which builds without one)",
      `extension/dist/web/extension.js: ${Math.round(Buffer.byteLength(big) / 1024)} KB, more than ${MAX_BUNDLE_BYTES / 1024} KB (unminified, or with a source map?)`,
    ]);
  });

  it("reports a bundle that throws on activation, or registers other things than src/", () => {
    const problems = checkPackage(packageFiles({
      "extension/dist/extension.js": "exports.activate = () => { throw new Error('boom'); };",
      "extension/dist/web/extension.js": "exports.activate = () => require('vscode').commands.registerCommand('otterscript.other', () => {});",
    }), pkg, expected);
    assert.equal(problems.length, 2);
    assert.equal(problems[0], "extension/dist/extension.js: activating it failed: boom");
    assert.match(problems[1], /^extension\/dist\/web\/extension\.js: registers other things than src\/ does \(missing: CodeActionsProvider, .*; extra: command otterscript\.other; built from other code\?\)$/);
  });

  it("reports a main entry that isn't in the package", () => {
    const problems = checkPackage(packageFiles({ "extension/dist/web/extension.js": null }), pkg, expected);
    assert.deepEqual(problems, [
      "missing extension/dist/web/extension.js",
      `browser (${pkg.browser}): extension/dist/web/extension.js is not in the package`,
    ]);
  });
});

describe("activationRegistrations", () => {
  it("lists each provider kind and command a bundle registers, sorted", () => {
    const code = "const vscode = require('vscode');\nexports.activate = () => {\n" +
      "  vscode.commands.registerCommand('b.cmd', () => {});\n" +
      "  vscode.languages.registerHoverProvider('otterscript', {});\n};";
    assert.deepEqual(activationRegistrations(code, "bundle.js"), ["HoverProvider", "command b.cmd"]);
  });
});
