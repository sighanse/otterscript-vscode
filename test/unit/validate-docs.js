// @ts-check
/**
 * @fileoverview validateDocs: the shape check every docs table in
 * src/language-data.js must pass (see reference.test.js and helpers.test.js).
 * Test-only -- the tables are static, so checking them once in CI is enough.
 */

const { NAMESPACES } = require("../../src/namespaces.js");

/** The Inedo products a docs entry's `products` may list. */
const PRODUCTS = ["ProGet", "Otter", "BuildMaster"];

/**
 * Checks a documentation table's entries for the fields the providers rely
 * on: errors for a missing `name`, `description` or `namespace` (or one not in
 * NAMESPACES), warnings for an optional field of the wrong shape.
 *
 * @param {string} label - Human-readable category label (e.g. "keywordDocs")
 * @param {Record<string, unknown>} docsTable - Documentation table to validate
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateDocs(label, docsTable) {
  const errors = [];
  const warnings = [];

  for (const [key, rawDoc] of Object.entries(docsTable)) {
    /** @type {any} */
    const doc = rawDoc;

    if (!doc || typeof doc !== "object") {
      errors.push(`${label}.${key} is not an object`);
      continue;
    }

    // Required Field: 'name'
    if (!doc.name || typeof doc.name !== "string" || doc.name.trim() === "") {
      errors.push(`${label}.${key} is missing required 'name'`);
    }

    // Required Field: 'description'
    if (!doc.description || typeof doc.description !== "string") {
      errors.push(`${label}.${key} is missing required 'description'`);
    }

    // Required Field: 'namespace' — must be present and either null or one of
    // the known OtterScript namespace tokens (guards against typos / drift).
    if (!("namespace" in doc)) {
      errors.push(`${label}.${key} is missing required 'namespace'`);
    } else if (doc.namespace !== null && !NAMESPACES.has(doc.namespace)) {
      errors.push(
        `${label}.${key} 'namespace' must be null or one of ` +
        `${[...NAMESPACES].join(", ")} (got ${JSON.stringify(doc.namespace)})`
      );
    }

    // Optional Field: 'snippet'
    if (doc.snippet !== undefined && typeof doc.snippet !== "string") {
      warnings.push(`${label}.${key} 'snippet' must be a string`);
    }

    // Optional Field: 'signature'
    if (doc.signature !== undefined && typeof doc.signature !== "string") {
      warnings.push(`${label}.${key} 'signature' must be a string`);
    }

    // Optional Field: 'documentation'
    if (doc.documentation !== undefined && typeof doc.documentation !== "string") {
      warnings.push(`${label}.${key} 'documentation' must be a string`);
    }

    // Optional Field: 'products' -- the Inedo products that have it
    if (doc.products !== undefined && (!Array.isArray(doc.products) ||
        doc.products.some((/** @type {any} */ p) => !PRODUCTS.includes(p)))) {
      warnings.push(`${label}.${key} 'products' must be an array of ${PRODUCTS.join(", ")}`);
    }

    // Optional Field: 'params' -- an operation's named arguments
    if (doc.params !== undefined && (!Array.isArray(doc.params) ||
        doc.params.some((/** @type {any} */ p) => typeof p?.name !== "string" || typeof p?.required !== "boolean"))) {
      warnings.push(`${label}.${key} 'params' must be an array of { name, required }`);
    }

    // Optional Field: 'anySigil' -- works with every sigil
    if (doc.anySigil !== undefined && doc.anySigil !== true) {
      warnings.push(`${label}.${key} 'anySigil' must be true when set`);
    }

    // Optional Field: 'overloads' -- other products' forms of the function
    if (doc.overloads !== undefined && (!Array.isArray(doc.overloads) ||
        doc.overloads.some((/** @type {any} */ o) => typeof o?.product !== "string" || typeof o?.signature !== "string"))) {
      warnings.push(`${label}.${key} 'overloads' must be an array of { product, signature } strings`);
    }
  }

  return { errors, warnings };
}

module.exports = { validateDocs };
