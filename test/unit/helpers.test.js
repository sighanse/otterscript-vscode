// @ts-check
/**
 * @fileoverview Unit tests for src/helpers.js: the hover and completion
 * builders, product forms, settings, timers and the small lookups the
 * providers share.
 *
 * Requires the vscode stub before helpers.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position } = require("../vscode-stub");
const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { stubProperty } = require("./fake-workspace");
const { operationDocs } = require("../../src/language-data.js");
const {
  buildCompletionItem,
  resolveCompletionDocumentation,
  buildHoverMarkdown,
  buildArgumentHoverMarkdown,
  buildSigilCompletionItems,
  clearTimerForUri,
  getTypedIdentifier,
  isValidCompletionPosition,
  loadConfig,
  lookupOwn,
  MAX_WORKSPACE_FILE_BYTES,
  mapWithConcurrency,
  readWorkspaceText,
  productSignatures,
  scheduleTimerForUri,
} = require("../../src/helpers.js");

/**
 * A `vscode.Position`-shaped value typed as `any` for calls into helpers whose
 * JSDoc declares a real `vscode.Position` parameter.
 *
 * @param {number} line
 * @param {number} character
 * @returns {any}
 */
const pos = (line, character) => new Position(line, character);

/**
 * A fake `vscode.TextDocument` backed by a plain string (see fake-document.js).
 *
 * @param {string} text
 * @returns {any}
 */
const makeDoc = (text) => makeDocument(text);

// ============================================================
// buildHoverMarkdown
// ============================================================

describe("buildHoverMarkdown (other products' forms)", () => {
  it("lists each overload under its product, after the signature", () => {
    const md = buildHoverMarkdown({
      name: "$PackageHash",
      signature: "$PackageHash([format], [algorithm])",
      overloads: [{ product: "BuildMaster", signature: "$PackageHash(packageName, [sourceName])" }],
    });
    const value = /** @type {any} */ (md).value;
    assert.ok(value.indexOf("**Signature:** `$PackageHash([format], [algorithm])`") < value.indexOf("**In BuildMaster:** `$PackageHash(packageName, [sourceName])`"));
  });
});

describe("buildHoverMarkdown (otterscript.product and anySigil)", () => {
  /** @param {any} md */
  const text = (md) => md.value;

  it("notes, under the name, when the entry isn't in the selected product", () => {
    const doc = { name: "$ReleaseName", signature: "$ReleaseName", products: ["BuildMaster"] };
    const value = text(buildHoverMarkdown(doc, "Otter"));
    assert.match(value, /^### \$ReleaseName\n\n⚠️ \*\*Not in Otter:\*\* only in BuildMaster/);
    assert.doesNotMatch(text(buildHoverMarkdown(doc, "BuildMaster")), /Not in/);
    assert.doesNotMatch(text(buildHoverMarkdown(doc)), /Not in/, "'any' by default");
    assert.doesNotMatch(text(buildHoverMarkdown({ ...doc, products: ["Otter", "BuildMaster"] }, "ProGet")), /Not in/, "core engine");
  });

  it("says what to write instead of a superseded name", () => {
    assert.match(text(buildHoverMarkdown(operationDocs.PSCall1)), /^### PSCall1\n\n⚠️ The older operation: write `PSCall` for the current one\.\n\n/);
    assert.doesNotMatch(text(buildHoverMarkdown(operationDocs.PSCall)), /⚠️/);
  });

  it("says when a function works with every sigil", () => {
    assert.match(text(buildHoverMarkdown({ name: "@FromJson", anySigil: true })), /Works with `\$`, `@` and `%`/);
    assert.doesNotMatch(text(buildHoverMarkdown({ name: "$ToJson" })), /Works with/);
  });
});

describe("buildHoverMarkdown / buildArgumentHoverMarkdown (operation arguments)", () => {
  const params = [
    { name: "To", required: true, description: "Target directory", format: "text" },
    { name: "Verbose", required: false, format: "true/false" },
  ];

  it("lists an operation's arguments, unless its documentation has its own list", () => {
    const value = /** @type {any} */ (buildHoverMarkdown({ name: "Copy-Files", params, documentation: "*From Inedo's reference.*" })).value;
    assert.ok(value.includes("**Arguments:**\n- `To` (required, text) - Target directory\n- `Verbose` (optional, true/false)\n"), value);
    assert.ok(value.indexOf("**Arguments:**") < value.indexOf("*From Inedo's"));
    const own = /** @type {any} */ (buildHoverMarkdown({ name: "Copy-Files", params, documentation: "**Arguments:**\n- hand-written" })).value;
    assert.equal(own.split("**Arguments:**").length, 2, "listed once");
  });

  it("documents one argument with its operation", () => {
    const value = /** @type {any} */ (buildArgumentHoverMarkdown("Copy-Files", params[0])).value;
    assert.match(value, /### To\n\nArgument of `Copy-Files`: `To` \(required, text\) - Target directory/);
  });
});

describe("buildHoverMarkdown (namespace provenance)", () => {
  it("adds a **Namespace:** line for an entry that has one", () => {
    const md = buildHoverMarkdown({
      name: "Create-Directory",
      signature: "Create-Directory(Path: <text>)",
      description: "Creates a subdirectory in an asset directory.",
      namespace: "ProGet",
    });
    assert.match(md.value, /\*\*Namespace:\*\* `ProGet`/);
  });

  it("omits the line when namespace is null (language construct)", () => {
    const md = buildHoverMarkdown({ name: "if", description: "Conditional.", namespace: null });
    assert.doesNotMatch(md.value, /Namespace:/);
  });

  it("omits the line when namespace is absent", () => {
    const md = buildHoverMarkdown({ name: "x", description: "y" });
    assert.doesNotMatch(md.value, /Namespace:/);
  });
});

// ============================================================
// productSignatures
// ============================================================

describe("productSignatures", () => {
  it("productSignatures gives the selected product's form, or every form for any", () => {
    const doc = {
      signature: "$PackageProperty(name, [default])",
      overloads: [{ product: "BuildMaster", signature: "$PackageProperty(packageName, packageProperty, [sourceName])" }],
    };
    assert.deepEqual(productSignatures(doc, "BuildMaster"), [doc.overloads[0].signature]);
    assert.deepEqual(productSignatures(doc, "ProGet"), [doc.signature]);
    assert.deepEqual(productSignatures(doc, "any"), [doc.signature, doc.overloads[0].signature]);
    assert.deepEqual(productSignatures({ signature: "$X(a)" }, "Otter"), ["$X(a)"]);
    assert.deepEqual(productSignatures({}, "any"), []);
  });
});

// ============================================================
// mapWithConcurrency
// ============================================================

describe("readWorkspaceText", () => {
  /**
   * Runs `readWorkspaceText` on a file of `size` bytes, with a stubbed
   * `workspace.fs` that records whether the file was read.
   *
   * @param {import("node:test").TestContext} t - The test, which the
   *   stubbed file system lasts for
   * @param {number} size
   * @returns {Promise<{ text: string | undefined, read: boolean }>}
   */
  async function readFileOf(t, size) {
    let read = false;
    stubProperty(t, stub.workspace, "fs", {
      stat: async () => ({ size }),
      readFile: async () => {
        read = true;
        return new TextEncoder().encode("module M {}");
      },
    });
    stubProperty(t, stub.workspace, "asRelativePath", () => "big.otter");
    const text = await readWorkspaceText(/** @type {any} */ ({ toString: () => "file:///big.otter" }));
    return { text, read };
  }

  it("reads a file up to the limit", async (t) => {
    assert.deepEqual(await readFileOf(t, MAX_WORKSPACE_FILE_BYTES), { text: "module M {}", read: true });
  });

  it("doesn't read a larger file at all", async (t) => {
    assert.deepEqual(await readFileOf(t, MAX_WORKSPACE_FILE_BYTES + 1), { text: undefined, read: false });
  });
});

describe("mapWithConcurrency", () => {
  it("visits every item exactly once", async () => {
    /** @type {number[]} */
    const seen = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(peak, 4);
  });

  it("is a no-op for an empty list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 8, async () => { calls++; });
    assert.equal(calls, 0);
  });

  it("clamps a limit below 1 up to 1", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(peak, 1);
  });

  it("caps workers at the item count when limit exceeds it", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 50, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    assert.equal(peak, 2);
  });

  it("rejects when a worker rejects", async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
      /boom/
    );
  });
});

// ============================================================
// buildCompletionItem
// ============================================================

describe("buildSigilCompletionItems", () => {
  const table = {
    ToJson: { name: "$ToJson", signature: "$ToJson(data)", snippet: "\\$ToJson(${1:data})" },
    Trim: { name: "$Trim", signature: "$Trim(text)" },
    TargetDirectory: { name: "$TargetDirectory", signature: "$TargetDirectory" },
    Other: { name: "$Other", signature: "$Other()" },
  };
  const items = (/** @type {string} */ typed) =>
    buildSigilCompletionItems(/** @type {any} */ (table), typed, { functionSort: "1_", variableSort: "2_" })
      .map((i) => /** @type {any} */ (i));

  it("filters by the typed prefix, ignoring case", () => {
    assert.deepEqual(items("t").map((i) => i.label.label), ["$ToJson", "$Trim", "$TargetDirectory"]);
  });

  it("inserts without the sigil the user already typed, escaped or not", () => {
    const [toJson, trim, target] = items("t");
    assert.equal(toJson.insertText.value, "ToJson(${1:data})");
    assert.equal(trim.insertText.value, "Trim(${0})");
    assert.equal(target.insertText.value, "TargetDirectory");
  });

  it("makes functions Function items that open signature help, and the rest variables", () => {
    const [toJson, , target] = items("t");
    assert.equal(toJson.kind, "function");
    assert.equal(toJson.sortText, "1_$ToJson");
    assert.ok(toJson.command);
    assert.equal(target.kind, "variable");
    assert.equal(target.sortText, "2_$TargetDirectory");
    assert.equal(target.command, undefined);
  });
});

describe("buildCompletionItem", () => {
  const doc = {
    name: "$ToJson",
    description: "to JSON",
    signature: "$ToJson(data)",
    documentation: "more",
    namespace: null,
  };
  const KIND = /** @type {any} */ ("kind-sentinel");

  it("carries the label object, kind, sortText, insertText", () => {
    const item = buildCompletionItem(doc, KIND, "1_", "snippet-text");
    assert.deepEqual(item.label, { label: "$ToJson", description: "to JSON" });
    assert.equal(item.kind, KIND);
    assert.equal(item.sortText, "1_$ToJson");
    assert.equal(item.insertText, "snippet-text");
  });

  it("strikes a superseded name through and lists it last", () => {
    const item = buildCompletionItem({ ...doc, name: "PSCall2", superseded: { by: "PSCall", note: "n" } }, KIND, "0_", "x");
    assert.deepEqual(item.tags, [stub.CompletionItemTag.Deprecated]);
    assert.equal(item.sortText, "0_~PSCall2");
    assert.equal(buildCompletionItem(doc, KIND, "1_", "x").tags, undefined);
  });

  it("detail is the signature, falling back to description", () => {
    assert.equal(buildCompletionItem(doc, KIND, "1_", "x").detail, "$ToJson(data)");
    assert.equal(
      buildCompletionItem({ name: "K", description: "d", namespace: null }, KIND, "1_", "x").detail,
      "d"
    );
  });

  it("documentation is a hover MarkdownString, built when the item is resolved", () => {
    const item = buildCompletionItem(doc, KIND, "1_", "x");
    assert.equal(item.documentation, undefined);
    assert.equal(resolveCompletionDocumentation(item), item);
    const md = /** @type {any} */ (item.documentation);
    assert.match(md.value, /### \$ToJson/);
  });

  it("resolving leaves other items as they are", () => {
    const other = buildCompletionItem(doc, KIND, "1_", "x");
    resolveCompletionDocumentation(other);
    other.documentation = "own";
    assert.equal(resolveCompletionDocumentation(other).documentation, "own");
  });

  it("sets the signature-help trigger command only when asked", () => {
    assert.equal(buildCompletionItem(doc, KIND, "1_", "x", false).command, undefined);
    assert.deepEqual(buildCompletionItem(doc, KIND, "1_", "x", true).command, {
      command: "editor.action.triggerParameterHints",
      title: "",
    });
  });
});

// ============================================================
// lookupOwn
// ============================================================

describe("lookupOwn", () => {
  it("returns a table's own entries only, never inherited Object members", () => {
    const table = { ToJson: { name: "$ToJson" } };
    assert.equal(lookupOwn(table, "ToJson"), table.ToJson);
    for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      assert.equal(lookupOwn(table, inherited), undefined, inherited);
    }
  });
});

// ============================================================
// getTypedIdentifier
// ============================================================

describe("getTypedIdentifier", () => {
  it("extracts the fragment after a '$' / '@' / '%' trigger", () => {
    assert.equal(getTypedIdentifier(makeDoc("x = $To"), pos(0, 7), "$"), "To");
    assert.equal(getTypedIdentifier(makeDoc("@Sp"), pos(0, 3), "@"), "Sp");
    assert.equal(getTypedIdentifier(makeDoc("set %m = %From"), pos(0, 14), "%"), "From");
  });

  it("takes digits, '_' and '-' in a name, as variable names have", () => {
    assert.equal(getTypedIdentifier(makeDoc("Log-Information $item2"), pos(0, 22), "$"), "item2");
    assert.equal(getTypedIdentifier(makeDoc("set @my-li"), pos(0, 10), "@"), "my-li");
  });

  it("returns '' right after the bare sigil", () => {
    assert.equal(getTypedIdentifier(makeDoc("$"), pos(0, 1), "$"), "");
  });

  it("returns null when the sigil is not immediately before the cursor", () => {
    assert.equal(getTypedIdentifier(makeDoc("xyz"), pos(0, 3), "$"), null);
  });
});

// ============================================================
// isValidCompletionPosition
// ============================================================

describe("isValidCompletionPosition", () => {
  it("is false when completion is disabled", () => {
    assert.equal(isValidCompletionPosition(makeDoc("code"), pos(0, 2), false), false);
  });

  it("is false inside a string, true in code", () => {
    assert.equal(isValidCompletionPosition(makeDoc('"str'), pos(0, 3), true), false);
    assert.equal(isValidCompletionPosition(makeDoc("code"), pos(0, 2), true), true);
  });
});

// ============================================================
// loadConfig
// ============================================================

describe("loadConfig", () => {
  it("defaults every feature to enabled, with no diagnostic rules and Teams' card version", () => {
    assert.deepEqual(loadConfig(), {
      completionEnabled: true,
      hoverEnabled: true,
      signatureHelpEnabled: true,
      codeLensEnabled: true,
      workspaceSymbolsEnabled: true,
      parameterNameHints: true,
      diagnosticRules: {},
      adaptiveCardMaxVersion: "1.6",
      product: "any",
    });
  });

  it("reflects an overridden setting", (t) => {
    stubProperty(t, stub.workspace, "getConfiguration", () => ({
      get: (/** @type {string} */ key, /** @type {unknown} */ fallback) =>
        key === "hover.enable" ? false : fallback,
    }));
    const cfg = loadConfig();
    assert.equal(cfg.hoverEnabled, false);
    assert.equal(cfg.completionEnabled, true);
  });
});

// ============================================================
// scheduleTimerForUri / clearTimerForUri
// ============================================================

describe("timer helpers", () => {
  const uri = /** @type {any} */ ({ toString: () => "file:///timer.otter" });

  it("fires the callback after the delay and clears its own map entry", async () => {
    /** @type {Map<string, any>} */
    const map = new Map();
    let fired = false;
    scheduleTimerForUri(map, uri, 5, () => { fired = true; });
    assert.equal(map.size, 1);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fired, true);
    assert.equal(map.size, 0);
  });

  it("clearTimerForUri cancels a pending callback", async () => {
    /** @type {Map<string, any>} */
    const map = new Map();
    let fired = false;
    scheduleTimerForUri(map, uri, 20, () => { fired = true; });
    clearTimerForUri(map, uri);
    assert.equal(map.size, 0);
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(fired, false);
  });

  it("rescheduling replaces the previous timer", async () => {
    /** @type {Map<string, any>} */
    const map = new Map();
    /** @type {string[]} */
    const calls = [];
    scheduleTimerForUri(map, uri, 20, () => calls.push("first"));
    scheduleTimerForUri(map, uri, 20, () => calls.push("second"));
    await new Promise((r) => setTimeout(r, 55));
    assert.deepEqual(calls, ["second"]);
  });
});
