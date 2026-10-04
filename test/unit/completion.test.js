// @ts-check
/**
 * @fileoverview Unit tests for src/providers/completion.js: what each
 * provider offers where, and the helpers it's built from. VS Code itself is
 * tested in test/integration/intellisense.test.js.
 *
 * Requires the vscode stub before completion.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { CompletionTriggerKind, Position, Range } = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const {
  argumentItems,
  callPrefix,
  keywordItems,
  moduleItems,
  operationItems,
  parseOperationPrefix,
  provideCardItems,
  provideOperationItems,
  provideSigilItems,
  sigilAt,
} = require("../../src/providers/completion.js");

/** Completion on, every product. */
const settings = { completionEnabled: true, product: "any" };
/** One module declared in another workspace file. */
const listWorkspaceModules = async () => [{ name: "Elsewhere", uri: /** @type {any} */ ({ toString: () => "file:///other.otter" }), range: /** @type {any} */ (null) }];

/**
 * `source` without its `|`, as a document, and the position of the `|`.
 *
 * @param {string} source
 * @returns {{ document: any, position: any }}
 */
function cursor(source) {
  const offset = source.indexOf("|");
  assert.ok(offset !== -1, "a | in the source");
  const before = source.slice(0, offset).split("\n");
  return {
    document: makeDocument(source.slice(0, offset) + source.slice(offset + 1), { languageId: "otterscript" }),
    position: new Position(before.length - 1, before[before.length - 1].length),
  };
}

/**
 * An item's label text.
 *
 * @param {any} item
 * @returns {string}
 */
const labelOf = (item) => (typeof item.label === "string" ? item.label : item.label.label);

/**
 * The labels of the items offered at the `|` without a sigil.
 *
 * @param {string} source
 * @param {number} [triggerKind]
 * @returns {Promise<string[]>}
 */
async function operationLabels(source, triggerKind = CompletionTriggerKind.Invoke) {
  const { document, position } = cursor(source);
  return (await provideOperationItems(document, position, /** @type {any} */ (triggerKind), settings, listWorkspaceModules)).map(labelOf);
}

/** A replace range over nothing, for the helpers that take one. */
const EMPTY = /** @type {any} */ (new Range(0, 0, 0, 0));

describe("sigilAt", () => {
  it("finds the sigil of the name being typed", () => {
    assert.equal(sigilAt("set $x = $To"), "$");
    assert.equal(sigilAt("foreach @"), "@");
    assert.equal(sigilAt("set %m = %Map"), "%");
  });

  it("is undefined when no sigil starts the word", () => {
    assert.equal(sigilAt("Log-Information x"), undefined);
    assert.equal(sigilAt("$x "), undefined);
  });
});

describe("provideSigilItems", () => {
  /**
   * @param {string} source
   * @returns {any[]}
   */
  const itemsAt = (source) => {
    const { document, position } = cursor(source);
    return provideSigilItems(document, position, settings);
  };

  it("offers the file's own variables first, then the documented ones", () => {
    const items = itemsAt("set $version = 1;\nLog-Information $|");
    const own = items.find((item) => labelOf(item) === "$version");
    assert.ok(own, "the file's own variable");
    assert.equal(own.detail, "Assigned on line 1");
    assert.ok(items.some((item) => labelOf(item) === "$ToJson"), "a documented function");
    assert.ok(own.sortText < items.find((item) => labelOf(item) === "$ToJson").sortText);
  });

  it("inserts a name with spaces in braces, and leaves out the one being typed", () => {
    const items = itemsAt("set ${my var} = 1;\nLog-Information $my|");
    assert.equal(items.find((item) => labelOf(item) === "$my var")?.insertText, "{my var}");
    assert.ok(!items.some((item) => labelOf(item) === "$my"), "not the occurrence being typed");
  });

  it("offers the map literal last after %", () => {
    const items = itemsAt("set %m = %|");
    assert.equal(items[items.length - 1].sortText.startsWith("~"), true);
  });

  it("offers nothing in a comment, or with completion off", () => {
    assert.deepEqual(itemsAt("# $|"), []);
    const { document, position } = cursor("$|");
    assert.deepEqual(provideSigilItems(document, position, { ...settings, completionEnabled: false }), []);
  });
});

describe("callPrefix", () => {
  it("finds the module name typed after `call`", () => {
    assert.deepEqual(callPrefix("call Dep"), { raft: false, typedName: "Dep" });
    assert.deepEqual(callPrefix("  call "), { raft: false, typedName: "" });
    assert.deepEqual(callPrefix("call Raft::Dep"), { raft: true, typedName: "Dep" });
  });

  it("is null without a `call`", () => {
    assert.equal(callPrefix("Log-Information Dep"), null);
    assert.equal(callPrefix("recall Dep"), null);
  });
});

describe("parseOperationPrefix", () => {
  it("splits a typed namespace from the name", () => {
    assert.deepEqual(parseOperationPrefix("  ProGet::Cr"), { namespaceTyped: "ProGet", typed: "Cr" });
    assert.deepEqual(parseOperationPrefix("if $x { Copy-F"), { namespaceTyped: "", typed: "Copy-F" });
    assert.deepEqual(parseOperationPrefix("x = "), { namespaceTyped: "", typed: "" });
  });
});

describe("operationItems", () => {
  it("offers the operations starting with what's typed", () => {
    const labels = operationItems("Copy-F", "", "any", EMPTY).map(labelOf);
    assert.ok(labels.includes("Copy-Files"), labels.join(" "));
    assert.ok(labels.every((label) => label.toLowerCase().startsWith("copy-f")));
  });

  it("offers a same-named operation of another namespace with its namespace", () => {
    const labels = operationItems("Build", "", "any", EMPTY).map(labelOf);
    assert.ok(labels.includes("Build") && labels.includes("DotNet::Build"), labels.join(" "));
  });

  it("behind a typed namespace, offers only its operations, without repeating it", () => {
    const items = operationItems("Bu", "DotNet", "any", EMPTY);
    assert.deepEqual(items.map(labelOf), ["Build"]);
    assert.doesNotMatch(/** @type {any} */ (items[0].insertText).value, /^DotNet::/);
  });

  it("leaves out the operations the product doesn't have", () => {
    assert.ok(operationItems("Archive-ProjectB", "", "any", EMPTY).length > 0);
    assert.deepEqual(operationItems("Archive-ProjectB", "", "Otter", EMPTY), [], "only in BuildMaster");
  });
});

describe("keywordItems", () => {
  it("offers the keywords starting with what's typed, over the range", () => {
    const items = keywordItems("fore", EMPTY);
    assert.deepEqual(items.map(labelOf), ["foreach"]);
    assert.equal(items[0].range, EMPTY);
  });
});

describe("argumentItems", () => {
  const called = {
    callee: "Get-Http",
    params: [
      { name: "Url", required: true },
      { name: "Method", required: false, format: "text", description: "The method" },
      { name: "ResponseBody", required: false, output: /** @type {true} */ (true) },
    ],
  };

  it("offers the arguments not given yet, required ones first", () => {
    /** @type {any[]} */
    const items = argumentItems(called, /** @type {any} */ ({ used: ["method"], typed: "" }), /** @type {any} */ (new Position(0, 9)));
    assert.deepEqual(items.map(labelOf), ["Url", "ResponseBody"]);
    assert.ok(items[0].sortText < items[1].sortText);
    assert.equal(items[0].insertText, "Url: ");
    assert.equal(items[0].detail, "Required argument of Get-Http");
  });

  it("inserts an output as `Name => `, over what's typed", () => {
    /** @type {any[]} */
    const [item] = argumentItems(called, /** @type {any} */ ({ used: ["url", "method"], typed: "Resp" }), /** @type {any} */ (new Position(0, 20)));
    assert.equal(item.insertText, "ResponseBody => ");
    assert.equal(item.range.start.character, 16);
  });
});

describe("moduleItems", () => {
  it("offers the file's modules first, then other files', each name once", async () => {
    const document = makeDocument("module Deploy {\n}\nmodule Elsewhere {\n}", { languageId: "otterscript" });
    /** @type {any[]} */
    const items = await moduleItems(document, EMPTY, async () => [
      ...(await listWorkspaceModules()),
      { name: "Remote", uri: /** @type {any} */ ({ toString: () => "file:///lib/remote.otter" }), range: /** @type {any} */ (null) },
    ]);
    assert.deepEqual(items.map((item) => [labelOf(item), item.label.description]), [
      ["Deploy", "this file"],
      ["Elsewhere", "this file"],
      ["Remote", "lib/remote.otter"],
    ]);
  });
});

describe("provideOperationItems", () => {
  it("offers argument names inside a call, and nothing else there", async () => {
    const labels = await operationLabels("Copy-Files(From: $a, |", CompletionTriggerKind.TriggerCharacter);
    assert.ok(labels.includes("To") && !labels.includes("From"), labels.join(" "));
    assert.deepEqual(await operationLabels("Frobnicate(|", CompletionTriggerKind.TriggerCharacter), [], "unknown call");
  });

  it("offers only argument names on `(` or `,`", async () => {
    assert.deepEqual(await operationLabels("Log|", CompletionTriggerKind.TriggerCharacter), []);
  });

  it("offers module names after `call`, but not behind a raft", async () => {
    assert.deepEqual(await operationLabels("module Deploy {\n}\ncall De|"), ["Deploy", "Elsewhere"]);
    assert.deepEqual(await operationLabels("call Raft::De|"), []);
  });

  it("typed automatically, waits for 2 characters unless a namespace is typed", async () => {
    assert.deepEqual(await operationLabels("L|", CompletionTriggerKind.TriggerForIncompleteCompletions), []);
    assert.ok((await operationLabels("Lo|", CompletionTriggerKind.TriggerForIncompleteCompletions)).includes("Log-Information"));
    assert.ok((await operationLabels("DotNet::|", CompletionTriggerKind.TriggerForIncompleteCompletions)).includes("Build"));
  });

  it("on Ctrl+Space offers operations and keywords, but only operations behind a namespace", async () => {
    const all = await operationLabels("|");
    assert.ok(all.includes("Log-Information") && all.includes("foreach"));
    assert.ok(!(await operationLabels("ProGet::|")).includes("foreach"));
  });
});

describe("provideCardItems", () => {
  const CARD = '{ "type": "AdaptiveCard", "version": "1.2", "body": [ { "type": "|Text" } ] }';

  it("offers a card value, replacing the value up to its closing quote", () => {
    const { document, position } = cursor(CARD);
    /** @type {any[]} */
    const items = provideCardItems(document, position, settings);
    assert.ok(items.map(labelOf).includes("TextBlock"));
    assert.deepEqual([items[0].range.inserting.end.character, items[0].range.replacing.end.character],
      [position.character, position.character + "Text".length]);
  });

  it("offers nothing outside a card value, or with completion off", () => {
    const { document, position } = cursor(CARD);
    assert.deepEqual(provideCardItems(document, position, { ...settings, completionEnabled: false }), []);
    const plain = cursor("Log-Information |;");
    assert.deepEqual(provideCardItems(plain.document, plain.position, settings), []);
  });
});
