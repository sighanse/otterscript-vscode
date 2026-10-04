#!/usr/bin/env node
/**
 * update-adaptivecard-data.js
 *
 * Generates src/adaptivecard-data.js -- the type names, property versions and
 * allowed property values the Adaptive Card checks use -- from Microsoft's
 * official Adaptive Card JSON schema, plus the short hand-maintained list of
 * Teams additions below that the schema doesn't contain.
 *
 * The schema is kept as a snapshot in scripts/adaptive-card-schema.json so
 * the check runs offline and an update shows up as a reviewable diff.
 *
 * Usage:
 *   node scripts/update-adaptivecard-data.js           regenerate from the snapshot
 *   node scripts/update-adaptivecard-data.js --fetch   download the schema first
 *   node scripts/update-adaptivecard-data.js --check   exit 1 if the file is stale
 *                                                      (run by `npm run check`)
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The newest published schema (the adaptivecards.microsoft.com one stops at 1.5). */
const SCHEMA_URL = "https://raw.githubusercontent.com/microsoft/AdaptiveCards/main/schemas/1.6.0/adaptive-card.json";
const SCHEMA_PATH = path.join(__dirname, "adaptive-card-schema.json");
const OUTPUT_PATH = path.join(__dirname, "..", "src", "adaptivecard-data.js");

// -----------------------------------------------------------------------------
// TEAMS ADDITIONS -- hand-maintained
// -----------------------------------------------------------------------------
// The Adaptive Cards documentation hub (https://adaptivecards.microsoft.com/)
// documents elements and values that Teams (and Copilot) render but that no
// published JSON schema contains. Without them, correct Teams cards would be
// flagged. Taken from the hub's element registry, which gives each a minimum
// card version (all 1.5) and the hosts it works in. Re-check the hub when
// Teams announces new card features.

/**
 * Teams-only `"type"` names, each with the card version the hub requires.
 * @type {Record<string, string>}
 */
const HOST_TYPES = {
  "Action.ResetInputs": "1.5",
  Badge: "1.5",
  Carousel: "1.5",
  CarouselPage: "1.5",
  "Chart.Donut": "1.5",
  "Chart.Gauge": "1.5",
  "Chart.HorizontalBar": "1.5",
  "Chart.HorizontalBar.Stacked": "1.5",
  "Chart.Line": "1.5",
  "Chart.Pie": "1.5",
  "Chart.VerticalBar": "1.5",
  "Chart.VerticalBar.Grouped": "1.5",
  CodeBlock: "1.5",
  CompoundButton: "1.5",
  Icon: "1.5",
  "Input.Rating": "1.5",
  "Layout.AreaGrid": "1.5",
  "Layout.Flow": "1.5",
  "Layout.Stack": "1.5",
  ProgressBar: "1.5",
  ProgressRing: "1.5",
  Rating: "1.5",
};

/**
 * Extra values the hub accepts for the schema's own value lists.
 * @type {Record<string, string[] | undefined>}
 */
const HOST_VALUES = {
  ChoiceInputStyle: ["filtered"],
  ImageStyle: ["roundedCorners"],
  Spacing: ["extraSmall"],
  TextBlockStyle: ["columnHeader"],
};

/**
 * Type versions the schema leaves out. `Data.Query` only appears as the value
 * of `Input.ChoiceSet.choices.data`, which the schema dates 1.6.
 * @type {Record<string, string | undefined>}
 */
const TYPE_VERSION_OVERRIDES = {
  "Data.Query": "1.6",
};

// -----------------------------------------------------------------------------
// SCHEMA -> DATA
// -----------------------------------------------------------------------------

/**
 * @typedef {{ $ref?: string, anyOf?: SchemaNode[], enum?: string[], type?: string | string[], version?: string }} SchemaNode
 * @typedef {SchemaNode & { properties?: Record<string, SchemaNode>, allOf?: SchemaNode[] }} SchemaDefinition
 * @typedef {{ definitions: Record<string, SchemaDefinition> }} Schema
 * @typedef {{ version?: string, values?: string }} PropertyInfo
 */

/**
 * The definition name a `$ref` points to (`#/definitions/Spacing` -> `Spacing`).
 *
 * @param {SchemaNode} node
 * @returns {string | undefined}
 */
function refName(node) {
  return node.$ref?.startsWith("#/definitions/") ? node.$ref.slice("#/definitions/".length) : undefined;
}

/**
 * The allowed values of a value-list definition such as `FontSize`: its own
 * `enum`, or the `enum` branch of an `anyOf` (the other branch is a
 * case-insensitive pattern for the same values).
 *
 * @param {SchemaDefinition | undefined} def
 * @returns {string[] | undefined}
 */
function enumValues(def) {
  if (!def) return undefined;
  if (Array.isArray(def.enum)) return def.enum;
  return def.anyOf?.find((branch) => Array.isArray(branch.enum))?.enum;
}

/**
 * The value-list definition a property is limited to, or undefined when it
 * also accepts other values. A property qualifies only when every branch
 * except `null` refers to the same value list: `Image.height`, for example,
 * accepts any string as well as `BlockElementHeight`, so it isn't checked.
 *
 * @param {Schema} schema
 * @param {SchemaNode} spec
 * @returns {string | undefined}
 */
function propertyValueList(schema, spec) {
  const branches = (spec.anyOf ?? [spec]).filter((b) => b.type !== "null");
  const names = new Set(branches.map(refName));
  if (names.size !== 1) return undefined;
  const [name] = names;
  return name && enumValues(schema.definitions[name]) ? name : undefined;
}

/**
 * The part of a definition that describes its JSON object. Usually the
 * definition itself; `TextRun`, which may also be written as a plain string,
 * keeps its object form in an `anyOf` branch.
 *
 * @param {SchemaDefinition} def
 * @returns {SchemaDefinition}
 */
function objectForm(def) {
  if (def.properties) return def;
  return /** @type {SchemaDefinition | undefined} */ (def.anyOf?.find((b) => "properties" in b)) ?? def;
}

/**
 * Corrects property names the schema gets wrong, or returns undefined for
 * one that isn't a real key. Container's and TableCell's right-to-left
 * property is spelled `"rtl?"`; `"choices.data"` stands for the `data` key of
 * `Input.ChoiceSet.choices`, which is a free-form payload the checks skip.
 *
 * @param {string} prop
 * @returns {string | undefined}
 */
function propertyKey(prop) {
  if (prop.includes(".")) return undefined;
  return prop.replace(/\?$/, "");
}

/**
 * A definition's properties including inherited ones. The schema lists an
 * inherited property as `{}` and defines it on an `Extendable.*` base reached
 * through `allOf`, so the own non-empty definition wins over the base one.
 *
 * @param {Schema} schema
 * @param {string} name
 * @returns {Record<string, SchemaNode>}
 */
function resolvedProperties(schema, name) {
  const def = objectForm(schema.definitions[name]);
  /** @type {Record<string, SchemaNode>} */
  const result = {};
  for (const base of def.allOf ?? []) {
    const baseName = refName(base);
    if (baseName) Object.assign(result, resolvedProperties(schema, baseName));
  }
  for (const [rawProp, spec] of Object.entries(def.properties ?? {})) {
    const prop = propertyKey(rawProp);
    if (prop && (Object.keys(spec).length > 0 || !(prop in result))) result[prop] = spec;
  }
  return result;
}

/**
 * Whether a definition is a typed object: it has a `type` property whose only
 * allowed value is its own name. Value lists (`Colors`) and schema helpers
 * (`ImplementationsOf.*`, `Extendable.*`) are never a `"type"` value.
 *
 * @param {string} name
 * @param {SchemaDefinition} def
 * @returns {boolean}
 */
function isTypedDefinition(name, def) {
  const typeSpec = objectForm(def).properties?.type;
  return Array.isArray(typeSpec?.enum) && typeSpec.enum.length === 1 && typeSpec.enum[0] === name;
}

/**
 * Derives the three tables from the schema plus the Teams additions.
 *
 * @param {Schema} schema
 * @returns {{
 *   types: [string, string][],
 *   properties: [string, Map<string, PropertyInfo>][],
 *   valueLists: [string, string[]][]
 * }} Each sorted by name, so the output is stable.
 */
function buildData(schema) {
  /** @type {Map<string, string>} */
  const types = new Map();
  /** @type {Map<string, Map<string, PropertyInfo>>} */
  const properties = new Map();
  /** @type {Map<string, string[]>} */
  const valueLists = new Map();

  for (const [name, def] of Object.entries(schema.definitions)) {
    if (!isTypedDefinition(name, def)) continue;
    types.set(name, TYPE_VERSION_OVERRIDES[name] ?? def.version ?? "1.0");

    /** @type {Map<string, PropertyInfo>} */
    const props = new Map();
    for (const [prop, spec] of Object.entries(resolvedProperties(schema, name))) {
      if (prop === "type") continue;
      /** @type {PropertyInfo} */
      const info = {};
      if (spec.version && spec.version !== "1.0") info.version = spec.version;
      const list = propertyValueList(schema, spec);
      if (list) {
        info.values = list;
        const values = new Set([...(enumValues(schema.definitions[list]) ?? []), ...(HOST_VALUES[list] ?? [])]);
        valueLists.set(list, [...values]);
      }
      // Properties with neither a version nor a value list have nothing to check.
      if (info.version || info.values) props.set(prop, info);
    }
    if (props.size > 0) properties.set(name, new Map([...props].sort(([a], [b]) => a.localeCompare(b))));
  }
  for (const [name, version] of Object.entries(HOST_TYPES)) {
    if (!types.has(name)) types.set(name, version);
  }

  const byName = (/** @type {[string, unknown]} */ [a], /** @type {[string, unknown]} */ [b]) => a.localeCompare(b);
  return {
    types: [...types].sort(byName),
    properties: [...properties].sort(byName),
    valueLists: [...valueLists].sort(byName),
  };
}

/**
 * Renders src/adaptivecard-data.js.
 *
 * @param {Schema} schema
 * @returns {string}
 */
function render(schema) {
  const { types, properties, valueLists } = buildData(schema);
  const q = (/** @type {string} */ s) => JSON.stringify(s);
  const info = (/** @type {PropertyInfo} */ i) =>
    "{ " + Object.entries(i).map(([k, v]) => `${k}: ${q(v)}`).join(", ") + " }";

  return `// @ts-check
// GENERATED by scripts/update-adaptivecard-data.js -- do not edit by hand.
/**
 * @fileoverview Static data for the (content-triggered, best-effort) Adaptive
 * Card checks in src/adaptivecard.js, generated from Microsoft's Adaptive Card
 * JSON schema (${SCHEMA_URL})
 * plus the Teams-only types and values that the documentation hub
 * (https://adaptivecards.microsoft.com/) lists but no schema contains.
 *
 * To update: \`node scripts/update-adaptivecard-data.js --fetch\`. The Teams
 * additions are maintained by hand in that script.
 */

/**
 * Every Adaptive Card \`"type"\` value, mapped to the first card version that
 * supports it.
 * @type {ReadonlyMap<string, string>}
 */
const ADAPTIVE_CARD_TYPES = new Map([
${types.map(([name, version]) => `  [${q(name)}, ${q(version)}],`).join("\n")}
]);

/**
 * Allowed values for each value list a property refers to, in the schema's
 * spelling. Hosts compare them case-insensitively.
 * @type {ReadonlyMap<string, readonly string[]>}
 */
const ADAPTIVE_CARD_VALUE_LISTS = new Map([
${valueLists.map(([name, values]) => `  [${q(name)}, [${values.map(q).join(", ")}]],`).join("\n")}
]);

/**
 * What a property of an Adaptive Card type needs: the card version that
 * introduced it, the value list it is limited to, or both.
 * @typedef {{ version?: string, values?: string }} PropertyInfo
 */

/**
 * Per type, the properties that need a card version above 1.0 (\`version\`)
 * or accept only the values of one list in {@link ADAPTIVE_CARD_VALUE_LISTS}
 * (\`values\`). Inherited properties (\`spacing\`, \`isVisible\`, ...) are
 * included; properties with nothing to check are left out. Each inner map's
 * entries are cast to \`PropertyInfo\`: TypeScript infers a map's value type
 * from its entries alone, and an entry with only \`version\` doesn't fit the
 * type it infers from one with only \`values\`.
 * @type {ReadonlyMap<string, ReadonlyMap<string, PropertyInfo>>}
 */
const ADAPTIVE_CARD_PROPERTIES = new Map([
${properties.map(([type, props]) => `  [${q(type)}, new Map(/** @type {[string, PropertyInfo][]} */ ([\n${[...props].map(([p, i]) => `    [${q(p)}, ${info(i)}],`).join("\n")}\n  ]))],`).join("\n")}
]);

module.exports = {
  ADAPTIVE_CARD_PROPERTIES,
  ADAPTIVE_CARD_TYPES,
  ADAPTIVE_CARD_VALUE_LISTS,
};
`;
}

/**
 * Downloads the schema to {@link SCHEMA_PATH}.
 *
 * @returns {Promise<void>}
 */
async function fetchSchema() {
  const response = await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${SCHEMA_URL}: ${response.status} ${response.statusText}`);
  const text = await response.text();
  JSON.parse(text); // fail before overwriting the snapshot with something broken
  fs.writeFileSync(SCHEMA_PATH, text.replace(/\r\n/g, "\n").replace(/\n?$/, "\n"));
  console.log(`Downloaded ${SCHEMA_URL}`);
}

/**
 * Runs the command-line options described at the top of this file.
 *
 * @returns {Promise<number>} The process exit code.
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--fetch")) await fetchSchema();

  const schema = /** @type {Schema} */ (JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")));
  const output = render(schema);

  if (args.has("--check")) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== output) {
      console.error(
        "src/adaptivecard-data.js is out of date with scripts/adaptive-card-schema.json or the\n" +
        "Teams additions in scripts/update-adaptivecard-data.js.\n" +
        "Run: node scripts/update-adaptivecard-data.js"
      );
      return 1;
    }
    console.log("src/adaptivecard-data.js is up to date.");
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
