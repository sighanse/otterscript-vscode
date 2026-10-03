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

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/** The docs repository and branch the reference archives are read from. */
const REFERENCE_REPO = "Inedo/inedo-docs";
const REFERENCE_BRANCH = "master";
/** How long one download may take before --fetch gives up. */
const FETCH_TIMEOUT_MS = 60_000;
/**
 * The fewest pages one archive may yield: each has dozens (Otter's 78
 * functions are the fewest), so fewer means the page format has changed and
 * the parser needs updating -- rather than a snapshot that silently loses
 * entries.
 */
const MIN_PAGES_PER_ARCHIVE = 40;
const PRODUCTS = ["Otter", "BuildMaster"];
const SNAPSHOT_PATH = path.join(__dirname, "inedo-reference.json");
const OUTPUT_PATH = path.join(__dirname, "..", "src", "inedo-reference-data.js");
const {
  PRODUCT_LETTERS,
  functionSignature,
  operationParam,
  operationSignature,
  operationSnippet,
  referenceDocumentation,
} = require("../src/inedo-reference");

/** @typedef {import("../src/inedo-reference").ReferenceDoc} ReferenceDoc */
/** @typedef {import("../src/inedo-reference").ReferenceParam} ReferenceParam */
/** @typedef {import("../src/inedo-reference").CompactEntry} CompactEntry */
/** @typedef {import("../src/inedo-reference").ReferenceTables} ReferenceTables */

// -----------------------------------------------------------------------------
// NAMESPACE CORRECTIONS -- hand-maintained
// -----------------------------------------------------------------------------
// The reference is not a reliable source for namespaces: it prints the
// extension's *name* where a construct declares none (`InedoCore::Sleep`),
// and leaves out some that the extension source declares. The extension uses
// the namespace declared by `[ScriptNamespace]` in Inedo's source (see
// NAMESPACES in src/namespaces.js), so:
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
 * A GET that fails on an error status or after {@link FETCH_TIMEOUT_MS}.
 *
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  return response;
}

/**
 * Downloads the reference archives and writes the snapshot. Pages that are the
 * same in both products become one entry listing both.
 *
 * @returns {Promise<void>}
 */
async function fetchSnapshot() {
  // Read every archive from the branch's current commit, which the snapshot
  // then names: an update is reproducible, and a diff says what it came from.
  const commit = /** @type {{ sha: string }} */ (await (await get(
    `https://api.github.com/repos/${REFERENCE_REPO}/commits/${REFERENCE_BRANCH}`
  )).json()).sha;
  const referenceUrl = `https://raw.githubusercontent.com/${REFERENCE_REPO}/${commit}/Content`;

  /** @type {Map<string, RefEntry>} */
  const entries = new Map();
  for (const product of PRODUCTS) {
    for (const kind of /** @type {const} */ (["function", "operation"])) {
      const url = `${referenceUrl}/${product}/Reference/${kind}s.zip`;
      const response = await get(url);
      let pages = 0;
      for (const [filePath, data] of unzip(Buffer.from(await response.arrayBuffer()))) {
        if (!filePath.endsWith(".html") || /\/(functions|operations)\.html$/.test(filePath)) continue;
        const entry = parsePage(kind, product, filePath, data.toString("utf8"));
        if (!entry) continue;
        pages++;
        const key = JSON.stringify([entry.kind, entry.name, entry.usage, entry.description]);
        const existing = entries.get(key);
        if (existing) existing.products.push(product);
        else entries.set(key, entry);
      }
      if (pages < MIN_PAGES_PER_ARCHIVE) {
        throw new Error(`${url}: only ${pages} pages could be read -- has the page format changed?`);
      }
      console.log(`Read ${pages} pages from ${url}`);
    }
  }
  const sorted = [...entries.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.products[0].localeCompare(b.products[0]));
  const snapshot = { source: `${referenceUrl}/{${PRODUCTS.join(",")}}/Reference/{functions,operations}.zip`, entries: sorted };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 1) + "\n");
}

// -----------------------------------------------------------------------------
// GENERATE: snapshot -> src/inedo-reference-data.js
// -----------------------------------------------------------------------------

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
 * An argument as the docs entries hold it: the description left out when it
 * only repeats the name.
 *
 * @param {RefParam} param
 * @returns {ReferenceParam}
 */
const cleanParam = ({ name, required, description, format }) => ({
  name,
  required,
  ...(format ? { format } : {}),
  ...(description && description !== name ? { description } : {}),
});

/**
 * An operation's arguments, for argument completion and hover: the first
 * product's, then any that another product adds. An argument is required
 * only when every product's page requires it (Otter's `ProGet::Promote`
 * doesn't need the `ToFeed` BuildMaster's does).
 *
 * @param {RefEntry[]} pages - The operation's pages in one namespace, one
 *   per product
 * @returns {ReferenceParam[]}
 */
function operationParams(pages) {
  /** @type {Map<string, ReferenceParam>} */
  const params = new Map();
  for (const param of pages.flatMap((v) => v.params)) {
    const key = param.name.toLowerCase();
    if (params.has(key)) continue;
    const required = pages.every((v) => v.params.some((p) => p.name.toLowerCase() === key && p.required));
    params.set(key, cleanParam({ ...param, required }));
  }
  return [...params.values()];
}

/**
 * An argument list in the compact form (see CompactEntry in
 * src/inedo-reference.js), or nothing when empty.
 *
 * @param {ReferenceParam[]} params
 * @returns {{ r?: (string | number)[][] }}
 */
function compactParams(params) {
  if (!params.length) return {};
  return {
    r: params.map((p) => {
      const tuple = [p.name, p.required ? 1 : 0, p.format ?? "", p.description ?? ""];
      while (tuple.length > 2 && tuple[tuple.length - 1] === "") tuple.pop();
      return tuple;
    }),
  };
}

/**
 * Builds the reference from the snapshot, twice over: `tables`, the four
 * docs tables as language-data.js uses them (keyed like the hand-written
 * ones: functions by bare name, operations by name), and `compact`, what
 * src/inedo-reference-data.js stores -- which `expandReference` turns back
 * into exactly `tables` (a unit test checks it). A function the reference
 * lists without a sigil (`MapAdd`, `Eval`, `FromJson`) can be called with any
 * sigil -- the sigil picks the return type -- so it goes into all three
 * function tables, marked `anySigil`, and is stored once.
 *
 * @param {{ source: string, entries: RefEntry[] }} snapshot
 * @param {ReadonlySet<string>} declared - NAMESPACES, lower-cased
 * @returns {{
 *   tables: ReferenceTables,
 *   compact: { functions: Record<string, CompactEntry>, operations: Record<string, CompactEntry> }
 * }}
 */
function buildReference(snapshot, declared) {
  /** @type {Map<string, RefEntry[]>} */
  const byName = new Map();
  for (const entry of snapshot.entries) {
    const key = `${entry.kind}:${entry.name}`;
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }

  /** @type {ReferenceTables} */
  const tables = { scalarFunctionDocs: {}, vectorFunctionDocs: {}, mapFunctionDocs: {}, operationDocs: {}, operationVariants: {} };
  /** @type {{ functions: Record<string, CompactEntry>, operations: Record<string, CompactEntry> }} */
  const compact = { functions: {}, operations: {} };
  const letters = Object.entries(PRODUCT_LETTERS);

  for (const [, variants] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    // Otter first (it has most of them); other products' differing forms become overloads.
    variants.sort((a, b) => PRODUCTS.indexOf(a.products[0]) - PRODUCTS.indexOf(b.products[0]));
    const [primary, ...others] = variants;
    // A function's forms without their sigil; an operation's without its namespace.
    const form = (/** @type {RefEntry} */ v) =>
      v.kind === "operation" ? oneLine(v.usage.replace(/^\w+::/, "")) : oneLine(v.usage).replace(/^[$@%]/, "");

    if (primary.kind === "operation") {
      // Same-named operations in different namespaces are different ones
      // (`DevEnv::Build` / `DotNet::Build`): the first namespace's is the
      // entry, the others' are its variants, stored as `Namespace::Name`.
      /** @type {Map<string | null, RefEntry[]>} */
      const byNamespace = new Map();
      for (const v of variants) {
        const namespace = operationNamespace(v.name, v.usage, declared);
        byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), v]);
      }
      [...byNamespace].forEach(([namespace, pages], i) => {
        const [first, ...rest] = pages;
        const pageProducts = PRODUCTS.filter((product) => pages.some((v) => v.products.includes(product)));
        const params = operationParams(pages);
        const signature = form(first);
        /** @type {[string, string][]} */
        const pageOverloads = rest
          .map((v) => /** @type {[string, string]} */ ([v.products.join(" and "), form(v)]))
          .filter(([, f]) => f !== signature);
        /** @type {ReferenceDoc} */
        const doc = {
          namespace,
          name: first.name,
          signature,
          ...(pageOverloads.length ? { overloads: pageOverloads.map(([product, s]) => ({ product, signature: s })) } : {}),
          snippet: operationSnippet(first.name, signature, params),
          description: first.description,
          documentation: referenceDocumentation(null, pageProducts),
          products: pageProducts,
          params: params.map(operationParam),
        };
        /** @type {CompactEntry} */
        const entry = {
          ...(namespace && i === 0 ? { n: namespace } : {}),
          p: letters.filter(([, product]) => pageProducts.includes(product)).map(([letter]) => letter).join(""),
          d: first.description,
          ...compactParams(params),
          ...(signature !== operationSignature(first.name, params) ? { s: signature } : {}),
          ...(pageOverloads.length ? { o: pageOverloads } : {}),
        };
        if (i === 0) {
          tables.operationDocs[first.name] = doc;
          compact.operations[first.name] = entry;
        } else {
          (tables.operationVariants[first.name] ??= []).push(doc);
          compact.operations[`${namespace ?? "Core"}::${first.name}`] = entry;
        }
      });
      continue;
    }

    // A function: one entry for every product, other products' differing forms as overloads.
    const products = PRODUCTS.filter((product) => variants.some((v) => v.products.includes(product)));
    const p = letters.filter(([, product]) => products.includes(product)).map(([letter]) => letter).join("");
    /** @type {[string, string][]} */
    const overloads = others
      .map((v) => /** @type {[string, string]} */ ([v.products.join(" and "), form(v)]))
      .filter(([, f]) => f !== form(primary));
    const sigil = /^[$@%]/.exec(primary.name)?.[0];
    const bare = primary.name.replace(/^[$@%]/, "");
    const params = primary.params.map(cleanParam);
    const base = form(primary);
    for (const s of sigil ? [sigil] : ["$", "@", "%"]) {
      const signature = `${s}${base}`;
      tables[s === "$" ? "scalarFunctionDocs" : s === "@" ? "vectorFunctionDocs" : "mapFunctionDocs"][bare] = {
        namespace: null,
        name: `${s}${bare}`,
        signature,
        ...(overloads.length ? { overloads: overloads.map(([product, f]) => ({ product, signature: `${s}${f}` })) } : {}),
        ...(signature.includes("(") ? {} : { snippet: `\\${s}${bare}` }),
        description: primary.description,
        documentation: referenceDocumentation(params, products),
        products,
        ...(sigil ? {} : { anySigil: /** @type {const} */ (true) }),
      };
    }
    compact.functions[sigil ? primary.name : bare] = {
      p,
      d: primary.description,
      ...compactParams(params),
      ...(base !== functionSignature(bare, params) ? { s: base } : {}),
      ...(overloads.length ? { o: overloads } : {}),
    };
  }
  return { tables, compact };
}

/**
 * Renders src/inedo-reference-data.js: the compact reference, one entry per
 * line.
 *
 * @param {{ source: string, entries: RefEntry[] }} snapshot
 * @returns {string}
 */
function render(snapshot) {
  const { NAMESPACES } = require(path.join(__dirname, "..", "src", "namespaces.js"));
  const declared = new Set([...NAMESPACES].map((n) => n.toLowerCase()));
  const { compact } = buildReference(snapshot, declared);
  /**
   * @param {Record<string, CompactEntry>} table
   * @returns {string} The table as an object literal, one entry per line
   */
  const renderTable = (table) =>
    "{\n" + Object.entries(table).map(([key, entry]) => `  ${JSON.stringify(key)}: ${JSON.stringify(entry)},`).join("\n") + "\n}";

  return `// @ts-check
// GENERATED by scripts/update-inedo-reference.js -- do not edit by hand.
/**
 * @fileoverview Every function and operation in Inedo's generated Otter and
 * BuildMaster reference (${snapshot.source}),
 * in compact form: src/inedo-reference.js expands it into docs entries, which
 * language-data.js merges under its hand-written tables (whose entries win).
 *
 * To update: \`npm run update:reference\` (fetches the reference, then
 * regenerates this file and the grammar's name lists).
 */

/** @typedef {import("./inedo-reference").CompactEntry} CompactEntry */

/**
 * Functions, keyed with their sigil -- or without, when any sigil works.
 * @type {Record<string, CompactEntry>}
 */
const functions = ${renderTable(compact.functions)};

/**
 * Operations, keyed by name.
 * @type {Record<string, CompactEntry>}
 */
const operations = ${renderTable(compact.operations)};

module.exports = { functions, operations };
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

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  );
}

module.exports = { buildReference };
