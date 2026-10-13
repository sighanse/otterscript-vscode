#!/usr/bin/env node
/**
 * check-vsix.js
 *
 * Checks a packaged extension (.vsix) -- the file the stores get, not the
 * source tree the other checks see: that it holds exactly the files the
 * extension needs (a `.vscodeignore` mistake adds or drops one), that its
 * manifest and package.json carry this version, that the bundles are
 * minified builds without source maps, and that each bundle activates and
 * registers what `src/` registers (a bundle that throws on load, or was
 * built from other code, fails here instead of in users' VS Code). Runs
 * after `npm run package` in Sanity and before publishing in publish.yml.
 *
 * Usage:
 *   node scripts/check-vsix.js                 otterscript-vscode-<version>.vsix
 *   node scripts/check-vsix.js <file.vsix>     that package
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const Module = require("node:module");

/**
 * Every file the package must hold, and nothing else. vsce adds the first
 * two and renames README.md, CHANGELOG.md and LICENSE.
 */
const PACKAGED_FILES = Object.freeze([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/changelog.md",
  "extension/dist/extension.js",
  "extension/dist/web/extension.js",
  "extension/images/logo.png",
  "extension/language-configuration.json",
  "extension/package.json",
  "extension/readme.md",
  "extension/snippets/otterscript.json",
  "extension/syntaxes/otterscript.tmLanguage.json",
]);

/**
 * The most a bundle may weigh. Today's are about 330 KB; one with an inline
 * source map or left unminified is several times that.
 */
const MAX_BUNDLE_BYTES = 600 * 1024;

/**
 * The files of a zip archive, by name. Reads the central directory at the
 * end of the file, as unzip does, and inflates each entry; enough for the
 * archives vsce writes (no ZIP64, no encryption).
 *
 * @param {Buffer} zip
 * @returns {Map<string, Buffer>}
 */
function readZip(zip) {
  // The end-of-central-directory record: 22 bytes plus a comment of at most 64 KB.
  let end = zip.length - 22;
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  while (end >= lowest && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < lowest) throw new Error("not a zip archive (no end of central directory)");

  const count = zip.readUInt16LE(end + 10);
  let entry = zip.readUInt32LE(end + 16);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(entry) !== 0x02014b50) throw new Error(`broken central directory at entry ${i}`);
    const method = zip.readUInt16LE(entry + 10);
    const compressedSize = zip.readUInt32LE(entry + 20);
    const size = zip.readUInt32LE(entry + 24);
    const nameLength = zip.readUInt16LE(entry + 28);
    const extraLength = zip.readUInt16LE(entry + 30);
    const commentLength = zip.readUInt16LE(entry + 32);
    const local = zip.readUInt32LE(entry + 42);
    const name = zip.toString("utf8", entry + 46, entry + 46 + nameLength);

    // The data follows the entry's local header, whose name and extra field
    // lengths may differ from the central directory's.
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const stored = zip.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported compression method ${method}`);
    const data = method === 8 ? zlib.inflateRawSync(stored) : stored;
    if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, but the archive says ${size}`);
    files.set(name, data);
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/**
 * Loads a bundle's code as a CommonJS module (its `vscode` import gets the
 * test stub, which must be loaded first), activates it, and returns what it
 * registered: each provider kind and command id, sorted.
 *
 * @param {string} code
 * @param {string} filename - For stack traces
 * @returns {string[]}
 */
function activationRegistrations(code, filename) {
  const stub = require("../test/vscode-stub");
  stub.registrations.length = 0;
  const bundle = new Module(filename);
  bundle.filename = filename;
  bundle.paths = [];
  /** @type {any} */ (bundle)._compile(code, filename);
  const context = {
    extension: { packageJSON: { displayName: "OtterScript", version: "0.0.0" } },
    subscriptions: /** @type {{ dispose(): void }[]} */ ([]),
  };
  bundle.exports.activate(context);
  const registered = stub.registrations.map((r) => (r.kind === "command" ? `command ${r.id}` : r.kind)).sort();
  bundle.exports.deactivate?.();
  for (const subscription of context.subscriptions) subscription.dispose?.();
  return registered;
}

/**
 * Everything wrong with a package, as messages; empty when it's fine.
 *
 * @param {Map<string, Buffer>} files - From {@link readZip}
 * @param {{ name: string, publisher: string, version: string, main: string, browser: string, engines: { vscode: string } }} pkg - package.json
 * @param {string[]} expectedRegistrations - What src/extension.js registers ({@link activationRegistrations})
 * @returns {string[]}
 */
function checkPackage(files, pkg, expectedRegistrations) {
  /** @type {string[]} */
  const problems = [];

  for (const name of PACKAGED_FILES) {
    if (!files.has(name)) problems.push(`missing ${name}`);
  }
  for (const name of files.keys()) {
    if (!PACKAGED_FILES.includes(name)) problems.push(`unexpected ${name} (add it to .vscodeignore, or to PACKAGED_FILES in scripts/check-vsix.js if it belongs)`);
  }

  const manifest = files.get("extension.vsixmanifest")?.toString("utf8") ?? "";
  const identity = /<Identity\b[^>]*>/.exec(manifest)?.[0] ?? "";
  /**
   * @param {string} name
   * @returns {string | undefined} The Identity element's attribute
   */
  const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(identity)?.[1];
  for (const [name, expected] of [["Id", pkg.name], ["Version", pkg.version], ["Publisher", pkg.publisher]]) {
    if (attribute(name) !== expected) problems.push(`extension.vsixmanifest: ${name} is ${attribute(name) ?? "missing"}, package.json says ${expected}`);
  }
  const engine = /Id="Microsoft\.VisualStudio\.Code\.Engine" Value="([^"]*)"/.exec(manifest)?.[1];
  if (engine !== pkg.engines.vscode) problems.push(`extension.vsixmanifest: engine is ${engine ?? "missing"}, package.json says ${pkg.engines.vscode}`);

  const packaged = files.get("extension/package.json");
  /** @type {any} */
  const packagedPkg = packaged ? JSON.parse(packaged.toString("utf8")) : {};
  for (const key of /** @type {const} */ (["version", "main", "browser"])) {
    if (packagedPkg[key] !== pkg[key]) problems.push(`extension/package.json: ${key} is ${packagedPkg[key]}, package.json says ${pkg[key]}`);
  }

  for (const [label, entry] of [["main", pkg.main], ["browser", pkg.browser]]) {
    const name = `extension/${path.posix.normalize(entry.replace(/^\.\//, ""))}${entry.endsWith(".js") ? "" : ".js"}`;
    const bundle = files.get(name);
    if (!bundle) {
      problems.push(`${label} (${entry}): ${name} is not in the package`);
      continue;
    }
    if (bundle.length > MAX_BUNDLE_BYTES) problems.push(`${name}: ${Math.round(bundle.length / 1024)} KB, more than ${MAX_BUNDLE_BYTES / 1024} KB (unminified, or with a source map?)`);
    const code = bundle.toString("utf8");
    if (/\/\/# sourceMappingURL=/.test(code)) problems.push(`${name}: has a source map (package with \`npm run package\`, which builds without one)`);
    try {
      const registered = activationRegistrations(code, name);
      if (registered.join("\n") !== expectedRegistrations.join("\n")) {
        const missing = expectedRegistrations.filter((r) => !registered.includes(r));
        const extra = registered.filter((r) => !expectedRegistrations.includes(r));
        problems.push(`${name}: registers other things than src/ does (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}; built from other code?)`);
      }
    } catch (err) {
      problems.push(`${name}: activating it failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return problems;
}

/**
 * What src/extension.js registers when activated (the reference the
 * packaged bundles are compared with).
 *
 * @returns {string[]}
 */
function sourceRegistrations() {
  const file = path.join(__dirname, "..", "src", "extension.js");
  return activationRegistrations(`module.exports = require(${JSON.stringify(file)});`, file);
}

if (require.main === module) {
  const pkg = require("../package.json");
  const file = process.argv[2] ?? `${pkg.name}-${pkg.version}.vsix`;
  /** @type {string[]} */
  let problems;
  try {
    problems = checkPackage(readZip(fs.readFileSync(file)), pkg, sourceRegistrations());
  } catch (err) {
    problems = [err instanceof Error ? err.message : String(err)];
  }
  for (const problem of problems) console.error(`${file}: ${problem}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`${file}: ${PACKAGED_FILES.length} files as expected; both bundles activate`);
}

module.exports = { MAX_BUNDLE_BYTES, PACKAGED_FILES, activationRegistrations, checkPackage, readZip, sourceRegistrations };
