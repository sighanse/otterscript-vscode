#!/usr/bin/env node
/**
 * update-inedo-reference.js
 *
 * Generates src/inedo-reference-data.js -- hover, completion and signature
 * data for every function and operation in Inedo's generated reference -- from
 * a snapshot of that reference, scripts/inedo-reference.json.
 *
 * The reference is published in the inedo-docs repository as one zip of HTML
 * pages per product and kind (Content/{Otter,BuildMaster}/Reference/
 * {functions,operations}.zip), generated from each product's built-in
 * components. ProGet has no such reference; its notifier variables stay
 * hand-written in src/language-data.js, whose entries always win over the
 * generated ones.
 *
 * Usage:
 *   node scripts/update-inedo-reference.js           regenerate from the snapshot
 *   node scripts/update-inedo-reference.js --fetch   download the reference and
 *                                                    rewrite the snapshot first
 *   node scripts/update-inedo-reference.js --check   exit 1 if the generated file
 *                                                    is stale (run by `npm run check`)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const REFERENCE_URL = "https://raw.githubusercontent.com/Inedo/inedo-docs/master/Content";
const PRODUCTS = ["Otter", "BuildMaster"];
const SNAPSHOT_PATH = path.join(__dirname, "inedo-reference.json");
const OUTPUT_PATH = path.join(__dirname, "..", "src", "inedo-reference-data.js");

// -----------------------------------------------------------------------------
// NAMESPACE CORRECTIONS -- hand-maintained
// -----------------------------------------------------------------------------
// The reference is not a reliable source for namespaces: it prints the
// extension's *name* where a construct declares none (`InedoCore::Sleep`),
// and leaves out some that the extension source declares. The extension uses
// the namespace declared by `[ScriptNamespace]` in Inedo's source (see
// NAMESPACES in src/language-data.js), so:
// - a namespace that isn't a declared one (InedoCore, and BuildMaster's DB,
//   Packages and System, which no public source declares) becomes `null`;
// - the operations below, which the reference prints without a namespace but
//   whose github.com/Inedo/inedox-* source declares one, get that namespace.

/** @type {Record<string, string>} */
const NAMESPACE_OVERRIDES = {
  "Collect-DebianPackages": "Linux",
  "Collect-RpmPackages": "Linux",
  "SHCall": "Linux",
  "SHEnsure": "Linux",
  "SHEnsure2": "Linux",
  "SHExec": "Linux",
  "SHVerify2": "Linux",
  "PYCall": "Python",
  "PYEnsure": "Python",
  "PYExec": "Python",
  "PYVerify": "Python",
  "Collect-DscModules": "PowerShell",
  "Collect-PsModules": "PowerShell",
  "PSVerify": "PowerShell",
  "PSVerify1": "PowerShell",
  "Set-FileAttributes": "Files",
  "Transfer-Files": "Files",
  "Sign-Exe": "Windows",
  "Ensure-Release": "GitHub",
};

// -----------------------------------------------------------------------------
// FETCH: zip archives -> snapshot
// -----------------------------------------------------------------------------

/**
 * The files in a zip archive (stored or deflated entries -- all the reference
 * archives use), by path.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (!name.endsWith("/")) files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/**
 * @param {string} s
 * @returns {string} `s` with the HTML entities the reference uses decoded
 */
const decodeEntities = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * @param {string} html
 * @returns {string} The text of `html`, whitespace collapsed
 */
const plainText = (html) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * @typedef {{ name: string, required: boolean, description?: string, format?: string }} RefParam
 * @typedef {{
 *   kind: "function" | "operation",
 *   name: string,
 *   products: string[],
 *   category: string,
 *   usage: string,
 *   description: string,
 *   params: RefParam[]
 * }} RefEntry
 */

/**
 * One reference page as a snapshot entry.
 *
 * @param {"function" | "operation"} kind
 * @param {string} product
 * @param {string} filePath
 * @param {string} html
 * @returns {RefEntry | null}
 */
function parsePage(kind, product, filePath, html) {
  const usageHtml = /Script usage:<\/h4>\s*<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1];
  if (!usageHtml) return null;
  const usage = decodeEntities(usageHtml).replace(/\r\n/g, "\n").trim();
  const afterNotice = html.split("</section>")[1] ?? html;
  const description = plainText(/<p>([\s\S]*?)<\/p>/.exec(afterNotice)?.[1] ?? "");
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((r) => [...r[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]))
    .filter((cells) => cells.length > 0);

  /** @type {RefParam[]} */
  let params;
  let name;
  if (kind === "function") {
    name = (/title:\s*"([^"]+)"/.exec(html)?.[1] ?? "").trim();
    params = rows.filter((c) => c.length >= 2).map((c) => ({
      name: plainText(c[0]).replace(/^☆\s*/, ""),
      required: c[0].includes("☆"),
      description: plainText(c[1]),
    }));
  } else {
    name = /^(?:[A-Za-z]\w*::)?([A-Za-z][\w-]*)/.exec(usage)?.[1] ?? "";
    params = rows.filter((c) => c.length >= 4).map((c) => ({
      name: plainText(c[2]),
      required: c[0].includes("☆") || /required/i.test(plainText(c[3])),
      description: plainText(c[0]).replace(/^☆\s*/, "").replace(/\s*\(default\)$/, ""),
      format: plainText(c[1]),
    }));
  }
  if (!name) return null;
  return { kind, name, products: [product], category: path.posix.basename(path.posix.dirname(filePath)), usage, description, params };
}

/**
 * Downloads the reference archives and writes the snapshot. Pages that are the
 * same in both products become one entry listing both.
 *
 * @returns {Promise<void>}
 */
async function fetchSnapshot() {
  /** @type {Map<string, RefEntry>} */
  const entries = new Map();
  for (const product of PRODUCTS) {
    for (const kind of /** @type {const} */ (["function", "operation"])) {
      const url = `${REFERENCE_URL}/${product}/Reference/${kind}s.zip`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
      for (const [filePath, data] of unzip(Buffer.from(await response.arrayBuffer()))) {
        if (!filePath.endsWith(".html") || /\/(functions|operations)\.html$/.test(filePath)) continue;
        const entry = parsePage(kind, product, filePath, data.toString("utf8"));
        if (!entry) continue;
        const key = JSON.stringify([entry.kind, entry.name, entry.usage, entry.description]);
        const existing = entries.get(key);
        if (existing) existing.products.push(product);
        else entries.set(key, entry);
      }
      console.log(`Read ${url}`);
    }
  }
  const sorted = [...entries.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.products[0].localeCompare(b.products[0]));
  const snapshot = { source: `${REFERENCE_URL}/{${PRODUCTS.join(",")}}/Reference/{functions,operations}.zip`, entries: sorted };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 1) + "\n");
}

// -----------------------------------------------------------------------------
// GENERATE: snapshot -> src/inedo-reference-data.js
// -----------------------------------------------------------------------------

/**
 * @typedef {{
 *   namespace: string | null,
 *   name: string,
 *   signature: string,
 *   overloads?: { product: string, signature: string }[],
 *   snippet?: string,
 *   description: string,
 *   documentation: string,
 *   products: string[],
 *   anySigil?: true,
 *   params?: { name: string, required: boolean, description?: string, format?: string }[]
 * }} GeneratedDoc
 */

/**
 * @param {string} usage
 * @returns {string} The usage on one line, `Name(A, B)` style
 */
const oneLine = (usage) => usage.replace(/\s*\n\s*/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

/**
 * The namespace an operation is shown under (see NAMESPACE CORRECTIONS).
 *
 * @param {string} name
 * @param {string} usage
 * @param {ReadonlySet<string>} declared - NAMESPACES, lower-cased
 * @returns {string | null}
 */
function operationNamespace(name, usage, declared) {
  if (NAMESPACE_OVERRIDES[name]) return NAMESPACE_OVERRIDES[name];
  const printed = /^([A-Za-z]\w*)::/.exec(usage)?.[1];
  return printed && declared.has(printed.toLowerCase()) ? printed : null;
}

/**
 * Hover documentation: a function's parameters (an operation's are in its
 * `params`, which hover lists), then where the entry comes from.
 *
 * @param {RefEntry} entry
 * @param {string[]} products - Every product that has the function/operation
 * @returns {string}
 */
function documentationFor(entry, products) {
  const lines = [];
  // An operation's arguments are in its `params`, which hover lists.
  if (entry.kind === "function" && entry.params.length) {
    lines.push("**Parameters:**");
    for (const p of entry.params) {
      const flags = [p.required ? "required" : "optional", p.format].filter(Boolean).join(", ");
      lines.push(`- \`${p.name}\` (${flags})${p.description && p.description !== p.name ? ` - ${p.description}` : ""}`);
    }
    lines.push("");
  }
  lines.push(`*From Inedo's ${products.join(" and ")} reference.*`);
  return lines.join("\n");
}

/**
 * A completion snippet for an operation: its required named arguments, or a
 * single placeholder for the positional form (`Sleep <integer>;`).
 *
 * @param {RefEntry} entry
 * @returns {string}
 */
function operationSnippet(entry) {
  const required = entry.params.filter((p) => p.required && /^[A-Za-z]\w*$/.test(p.name));
  if (/^\S+\s*\(/.test(entry.usage.replace(/^\w+::/, ""))) {
    if (!required.length) return `${entry.name}($1);$0`;
    return `${entry.name}(\n\t${required.map((p, i) => `${p.name}: \${${i + 1}}`).join(",\n\t")}\n);$0`;
  }
  return `${entry.name} \${1};$0`;
}

/**
 * An operation's arguments, for argument completion and hover: the first
 * product's, then any another product adds. A description that only repeats
 * the name is left out.
 *
 * @param {RefEntry[]} variants - The operation's pages, one per product
 * @returns {{ name: string, required: boolean, description?: string, format?: string }[]}
 */
function operationParams(variants) {
  /** @type {Map<string, { name: string, required: boolean, description?: string, format?: string }>} */
  const params = new Map();
  for (const { name, required, description, format } of variants.flatMap((v) => v.params)) {
    if (params.has(name.toLowerCase())) continue;
    params.set(name.toLowerCase(), {
      name,
      required,
      ...(description && description !== name ? { description } : {}),
      ...(format ? { format } : {}),
    });
  }
  return [...params.values()];
}

/**
 * Builds the four tables, keyed like the hand-written ones in
 * language-data.js (functions by bare name, operations by name). A function
 * the reference lists without a sigil (`MapAdd`, `Eval`, `FromJson`) can be
 * called with any sigil -- the sigil picks the return type -- so it goes into
 * all three function tables, marked `anySigil`.
 *
 * @param {{ source: string, entries: RefEntry[] }} snapshot
 * @param {ReadonlySet<string>} declared - NAMESPACES, lower-cased
 * @returns {Record<"scalar" | "vector" | "map" | "operation", Map<string, GeneratedDoc>>}
 */
function buildTables(snapshot, declared) {
  /** @type {Map<string, RefEntry[]>} */
  const byName = new Map();
  for (const entry of snapshot.entries) {
    const key = `${entry.kind}:${entry.name}`;
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }

  const tables = { scalar: new Map(), vector: new Map(), map: new Map(), operation: new Map() };
  for (const [, variants] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    // Otter first (it has most of them); other products' differing forms become overloads.
    variants.sort((a, b) => PRODUCTS.indexOf(a.products[0]) - PRODUCTS.indexOf(b.products[0]));
    const [primary, ...others] = variants;
    const products = PRODUCTS.filter((product) => variants.some((v) => v.products.includes(product)));
    const signature = (/** @type {RefEntry} */ v, /** @type {string} */ sigil) =>
      v.kind === "operation" ? oneLine(v.usage.replace(/^\w+::/, "")) : `${sigil}${oneLine(v.usage).replace(/^[$@%]/, "")}`;
    const overloads = (/** @type {string} */ sigil) => {
      const list = others
        .map((v) => ({ product: v.products.join(" and "), signature: signature(v, sigil) }))
        .filter((o) => o.signature !== signature(primary, sigil));
      return list.length ? { overloads: list } : {};
    };

    if (primary.kind === "operation") {
      tables.operation.set(primary.name, {
        namespace: operationNamespace(primary.name, primary.usage, declared),
        name: primary.name,
        signature: signature(primary, ""),
        ...overloads(""),
        snippet: operationSnippet(primary),
        description: primary.description,
        documentation: documentationFor(primary, products),
        products,
        params: operationParams(variants),
      });
      continue;
    }
    const sigil = /^[$@%]/.exec(primary.name)?.[0];
    const bare = primary.name.replace(/^[$@%]/, "");
    /** @type {[string, "scalar" | "vector" | "map"][]} */
    const targets = sigil
      ? [[sigil, sigil === "$" ? "scalar" : sigil === "@" ? "vector" : "map"]]
      : [["$", "scalar"], ["@", "vector"], ["%", "map"]];
    for (const [s, table] of targets) {
      const isCall = signature(primary, s).includes("(");
      tables[table].set(bare, {
        namespace: null,
        name: `${s}${bare}`,
        signature: signature(primary, s),
        ...overloads(s),
        ...(isCall ? {} : { snippet: `\\${s}${bare}` }),
        description: primary.description,
        documentation: documentationFor(primary, products),
        products,
        ...(sigil ? {} : { anySigil: /** @type {const} */ (true) }),
      });
    }
  }
  return tables;
}

/**
 * Renders src/inedo-reference-data.js.
 *
 * @param {{ source: string, entries: RefEntry[] }} snapshot
 * @returns {string}
 */
function render(snapshot) {
  const { NAMESPACES } = require(path.join(__dirname, "..", "src", "namespaces.js"));
  const declared = new Set([...NAMESPACES].map((n) => n.toLowerCase()));
  const tables = buildTables(snapshot, declared);
  /**
   * @param {Map<string, GeneratedDoc>} table
   * @returns {string} The table as an object literal, one entry per line
   */
  const renderTable = (table) =>
    "{\n" + [...table].map(([key, doc]) => `  ${JSON.stringify(key)}: ${JSON.stringify(doc)},`).join("\n") + "\n}";

  return `// @ts-check
// GENERATED by scripts/update-inedo-reference.js -- do not edit by hand.
/**
 * @fileoverview Hover, completion and signature data for every function and
 * operation in Inedo's generated Otter and BuildMaster reference
 * (${snapshot.source}).
 * language-data.js merges these under its hand-written tables, whose entries
 * win; ProGet's notifier variables are only there.
 *
 * To update: \`node scripts/update-inedo-reference.js --fetch\`.
 */

/**
 * The shape of a language-data.js DocEntry, spelled out here because
 * language-data.js loads this file (importing its type would be circular).
 * @typedef {{
 *   namespace: string | null,
 *   name: string,
 *   signature: string,
 *   overloads?: { product: string, signature: string }[],
 *   snippet?: string,
 *   description: string,
 *   documentation: string,
 *   products: string[],
 *   anySigil?: true,
 *   params?: { name: string, required: boolean, description?: string, format?: string }[]
 * }} ReferenceDoc
 */

/** @type {Record<string, ReferenceDoc>} */
const scalarFunctionDocs = ${renderTable(tables.scalar)};

/** @type {Record<string, ReferenceDoc>} */
const vectorFunctionDocs = ${renderTable(tables.vector)};

/** @type {Record<string, ReferenceDoc>} */
const mapFunctionDocs = ${renderTable(tables.map)};

/** @type {Record<string, ReferenceDoc>} */
const operationDocs = ${renderTable(tables.operation)};

module.exports = {
  mapFunctionDocs,
  operationDocs,
  scalarFunctionDocs,
  vectorFunctionDocs,
};
`;
}

/**
 * Runs the command-line options described at the top of this file.
 *
 * @returns {Promise<number>} The process exit code.
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--fetch")) await fetchSnapshot();

  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  const output = render(snapshot);

  if (args.has("--check")) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== output) {
      console.error(
        "src/inedo-reference-data.js is out of date with scripts/inedo-reference.json or the\n" +
        "namespace corrections in scripts/update-inedo-reference.js.\n" +
        "Run: node scripts/update-inedo-reference.js"
      );
      return 1;
    }
    console.log("src/inedo-reference-data.js is up to date.");
    return 0;
  }

  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
);
