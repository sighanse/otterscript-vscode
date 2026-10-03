// @ts-check
/**
 * @fileoverview Expands the compact generated reference
 * (src/inedo-reference-data.js) into docs-table entries for language-data.js.
 *
 * The generated file stores only what can't be derived: each entry's
 * products, description, arguments, and -- when it differs from the one the
 * arguments give -- its signature. Names, snippets, the documentation text and
 * the three copies of a function that works with every sigil are built here.
 * scripts/update-inedo-reference.js uses the same helpers to build the full
 * entries it encodes, so the two can't disagree.
 *
 * @module inedo-reference
 */

/**
 * A docs entry built from Inedo's reference -- a language-data.js DocEntry.
 *
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
 *   params?: ReferenceParam[]
 * }} ReferenceDoc
 */

/** @typedef {{ name: string, required: boolean, format?: string, description?: string }} ReferenceParam */

/**
 * One generated entry, compact: `p` products (letters, see
 * {@link PRODUCT_LETTERS}), `d` description, `r` arguments as
 * `[name, required (1/0), format, description]` (trailing empties left out),
 * `n` an operation's namespace (a variant's is in its `Namespace::Name` key,
 * `Core` for none), `o` other products' forms as
 * `[product, signature]` (a function's without its sigil), `s` the signature
 * when the arguments don't give it (a function's without its sigil).
 *
 * @typedef {{
 *   p: string,
 *   d: string,
 *   r?: (string | number)[][],
 *   n?: string,
 *   o?: [string, string][],
 *   s?: string
 * }} CompactEntry
 */

/**
 * The expanded reference: the four docs tables, keyed like language-data.js's
 * (functions by bare name, operations by name), and `operationVariants`, the
 * same-named operations of other namespaces (`DotNet::Build` beside
 * `DevEnv::Build`), by name.
 *
 * @typedef {Record<"scalarFunctionDocs" | "vectorFunctionDocs" | "mapFunctionDocs" | "operationDocs", Record<string, ReferenceDoc>>
 *   & { operationVariants: Record<string, ReferenceDoc[]> }} ReferenceTables
 */

/** The products a compact entry's `p` letters stand for, in order. */
const PRODUCT_LETTERS = Object.freeze({ O: "Otter", B: "BuildMaster" });

/** The docs table each function sigil goes into. */
const SIGIL_TABLES = Object.freeze({ "$": "scalarFunctionDocs", "@": "vectorFunctionDocs", "%": "mapFunctionDocs" });

/**
 * @param {(string | number)[][]} [compact]
 * @returns {ReferenceParam[]}
 */
function expandParams(compact = []) {
  return compact.map(([name, required, format, description]) => ({
    name: String(name),
    required: required === 1,
    ...(format ? { format: String(format) } : {}),
    ...(description ? { description: String(description) } : {}),
  }));
}

/**
 * The signature a function's arguments give, without its sigil:
 * `Substring(Text, Offset, [Length])`.
 *
 * @param {string} name - Without the sigil
 * @param {ReferenceParam[]} params
 * @returns {string}
 */
function functionSignature(name, params) {
  return `${name}(${params.map((p) => (p.required ? p.name : `[${p.name}]`)).join(", ")})`;
}

/**
 * The signature an operation's arguments give:
 * `Copy-Files([From: <text>], To: <text>);`.
 *
 * @param {string} name
 * @param {ReferenceParam[]} params
 * @returns {string}
 */
function operationSignature(name, params) {
  return `${name}(${params.map((p) => {
    const argument = `${p.name}: <${p.format ?? ""}>`;
    return p.required ? argument : `[${argument}]`;
  }).join(", ")});`;
}

/**
 * The completion snippet for an operation: the arguments its signature
 * requires (written without `[ ]`) as tab stops when it's called with
 * parentheses, else a single argument. The signature, not `params`, says
 * what's required: `params` also holds another product's same-named
 * operation's arguments (`DevEnv::Build` / `DotNet::Build`).
 *
 * @param {string} name
 * @param {string} signature
 * @param {ReferenceParam[]} params
 * @returns {string}
 */
function operationSnippet(name, signature, params) {
  if (!/^\S+\s*\(/.test(signature)) return `${name} \${1};$0`;
  const required = params.filter((p) => /^[A-Za-z]\w*$/.test(p.name) && new RegExp(`[(,]\\s*${p.name}:`).test(signature));
  if (!required.length) return `${name}($1);$0`;
  return `${name}(\n\t${required.map((p, i) => `${p.name}: \${${i + 1}}`).join(",\n\t")}\n);$0`;
}

/**
 * Hover documentation: a function's parameters (an operation's are in its
 * `params`, which hover lists), then where the entry comes from.
 *
 * @param {ReferenceParam[] | null} functionParams - Null for an operation
 * @param {string[]} products
 * @returns {string}
 */
function referenceDocumentation(functionParams, products) {
  const lines = [];
  if (functionParams?.length) {
    lines.push("**Parameters:**");
    for (const p of functionParams) {
      const flags = [p.required ? "required" : "optional", p.format].filter(Boolean).join(", ");
      lines.push(`- \`${p.name}\` (${flags})${p.description ? ` - ${p.description}` : ""}`);
    }
    lines.push("");
  }
  lines.push(`*From Inedo's ${products.join(" and ")} reference.*`);
  return lines.join("\n");
}

/**
 * @param {string} letters
 * @returns {string[]}
 */
function expandProducts(letters) {
  return Object.entries(PRODUCT_LETTERS).filter(([letter]) => letters.includes(letter)).map(([, product]) => product);
}

/**
 * The docs tables from the compact generated reference.
 *
 * @param {{ functions: Record<string, CompactEntry>, operations: Record<string, CompactEntry> }} compact
 * @returns {ReferenceTables}
 */
function expandReference({ functions, operations }) {
  /** @type {ReferenceTables} */
  const tables = { scalarFunctionDocs: {}, vectorFunctionDocs: {}, mapFunctionDocs: {}, operationDocs: {}, operationVariants: {} };

  for (const [key, entry] of Object.entries(functions)) {
    // A key without a sigil is a function that works with every sigil.
    const sigil = /^[$@%]/.exec(key)?.[0];
    const bare = sigil ? key.slice(1) : key;
    const params = expandParams(entry.r);
    const products = expandProducts(entry.p);
    const base = entry.s ?? functionSignature(bare, params);
    for (const s of /** @type {("$" | "@" | "%")[]} */ (sigil ? [sigil] : ["$", "@", "%"])) {
      const signature = `${s}${base}`;
      tables[SIGIL_TABLES[s]][bare] = {
        namespace: null,
        name: `${s}${bare}`,
        signature,
        ...(entry.o ? { overloads: entry.o.map(([product, form]) => ({ product, signature: `${s}${form}` })) } : {}),
        ...(signature.includes("(") ? {} : { snippet: `\\${s}${bare}` }),
        description: entry.d,
        documentation: referenceDocumentation(params, products),
        products,
        ...(sigil ? {} : { anySigil: /** @type {const} */ (true) }),
      };
    }
  }

  for (const [key, entry] of Object.entries(operations)) {
    // `Namespace::Name` is a variant: a same-named operation of another namespace.
    const [variantNamespace, name] = key.includes("::") ? key.split("::") : [undefined, key];
    const params = expandParams(entry.r);
    const products = expandProducts(entry.p);
    const signature = entry.s ?? operationSignature(name, params);
    /** @type {ReferenceDoc} */
    const doc = {
      namespace: variantNamespace === undefined ? entry.n ?? null : variantNamespace === "Core" ? null : variantNamespace,
      name,
      signature,
      ...(entry.o ? { overloads: entry.o.map(([product, form]) => ({ product, signature: form })) } : {}),
      snippet: operationSnippet(name, signature, params),
      description: entry.d,
      documentation: referenceDocumentation(null, products),
      products,
      params,
    };
    if (variantNamespace === undefined) tables.operationDocs[name] = doc;
    else (tables.operationVariants[name] ??= []).push(doc);
  }
  return tables;
}

module.exports = {
  PRODUCT_LETTERS,
  expandReference,
  functionSignature,
  operationSignature,
  operationSnippet,
  referenceDocumentation,
};
