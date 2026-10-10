// @ts-check
/**
 * @fileoverview Unit tests for src/providers/signature-help.js: finding the
 * call the cursor is in, the active form and parameter, and the parameter
 * label offsets; then the provider, on functions, operations and module
 * calls (with a fake workspace for modules in other files).
 *
 * Requires the vscode stub before signature-help.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { makeDocument } = require("./fake-document");
const { captureRegistrations, useWorkspace } = require("./fake-workspace");
const { FUNCTION_SIGNATURE_REGEX, OPERATION_SIGNATURE_REGEX, activeParameterIndex, activeSignatureIndex, findSignatureCall, parameterLabels, registerSignatureHelp } = require("../../src/providers/signature-help.js");
const { registerWorkspaceSymbols } = require("../../src/providers/workspace-symbols.js");

// ============================================================
// signature help: the call the cursor is in
// ============================================================

describe("signature help call regexes", () => {
  it("FUNCTION_SIGNATURE_REGEX captures sigil, name and partial args, but not a '%(' literal", () => {
    const m = "set %m = %ListItem(@x, ".match(FUNCTION_SIGNATURE_REGEX);
    assert.deepEqual(m?.slice(1), ["%", "ListItem", "@x, "]);
    assert.deepEqual("set $r = $Substring(text, 1".match(FUNCTION_SIGNATURE_REGEX)?.slice(1), ["$", "Substring", "text, 1"]);
    assert.equal("set %m = %(a: ".match(FUNCTION_SIGNATURE_REGEX), null);
  });

  it("OPERATION_SIGNATURE_REGEX captures a bare and a namespaced operation, not 'set $x = ('", () => {
    assert.equal("Copy-Files(Include: a".match(OPERATION_SIGNATURE_REGEX)?.[2], "Copy-Files");
    assert.deepEqual("ProGet::Create-Directory foo (Path: b".match(OPERATION_SIGNATURE_REGEX)?.slice(1, 3), ["ProGet", "Create-Directory"]);
    assert.equal("set $x = (".match(OPERATION_SIGNATURE_REGEX), null);
    assert.equal("Linux::SHEnsure2(Name: a".match(OPERATION_SIGNATURE_REGEX)?.[2], "SHEnsure2", "digits in the name");
    assert.equal("Log-Information x;Copy-Files(To: a".match(OPERATION_SIGNATURE_REGEX)?.[2], "Copy-Files", "right after ';'");
    assert.equal("if $x {Copy-Files(To: a".match(OPERATION_SIGNATURE_REGEX)?.[2], "Copy-Files", "right after '{'");
  });

  it("parameterLabels gives each parameter's own offsets in the label", () => {
    const label = "$Pad(pad, padding, [p])";
    const labels = parameterLabels(label, ["pad", "padding", "[p]"]);
    assert.deepEqual(labels.map((l) => (typeof l === "string" ? l : label.slice(l[0], l[1]))), ["pad", "padding", "[p]"]);
    assert.deepEqual(labels[0], [5, 8], "not the 'Pad' of the name, nor inside 'padding'");
    assert.deepEqual(parameterLabels("F(a)", ["zz"]), ["zz"], "not found: a string label");
  });

  it("activeParameterIndex follows a typed Name:, else the argument position", () => {
    const params = ["[Include: <@(text)>]", "[From: <text>]", "To: <text>"];
    assert.equal(activeParameterIndex("From: a, To: ", params), 2, "named, out of order");
    assert.equal(activeParameterIndex("a, ", params), 1, "positional");
    assert.equal(activeParameterIndex("result: ", ["name", "[out result]"]), 1, "a module's out parameter");
    assert.equal(activeParameterIndex("output-file: ", ["name", "[output-file]"]), 1, "a dashed name");
    assert.equal(activeParameterIndex("Url: $u, ResponseBody => ", ["[Method]", "Url", "[ResponseBody]"]), 2, "an output capture");
    assert.equal(activeParameterIndex("ResponseBody => ", ["Url: <text>", "[ResponseBody => <text>]"]), 1, "an output's => label");
  });


  it("activeSignatureIndex picks the first form the typed arguments fit", () => {
    const forms = ["$PackageProperty(name, [default])", "$PackageProperty(packageName, packageProperty, [sourceName])"];
    assert.equal(activeSignatureIndex("a", forms), 0);
    assert.equal(activeSignatureIndex("a, b", forms), 0);
    assert.equal(activeSignatureIndex("a, b, ", forms), 1, "a third argument only the second form takes");
    assert.equal(activeSignatureIndex("a, b, c, d", forms), 0, "none fits: the first");
    const ops = ["Ensure-Site(Name: <text>, [Binding: <text>])", "Ensure-Site(Name: <text>, [Bindings: <text>])"];
    assert.equal(activeSignatureIndex("Name: a, Bindings: ", ops), 1, "the form that has the typed name");
  });

  it("findSignatureCall prefers the function the cursor is in, then the operation", () => {
    assert.equal(findSignatureCall("Copy-Files(Include: $Trim(a")?.doc.name, "$Trim");
    assert.equal(findSignatureCall("Copy-Files(Include: a")?.isOperation, true);
    assert.equal(findSignatureCall("$Frobnicate(a"), null);
    // A namespace picks between same-named operations.
    assert.match(findSignatureCall("DotNet::Build(Project: a")?.doc.signature ?? "", /^Build\(Project:/);
    assert.match(findSignatureCall("Build(ProjectFile: a")?.doc.signature ?? "", /^Build\(ProjectFile:/);
  });
});

// ============================================================
// The provider
// ============================================================

describe("signature help provider", () => {
  /** @type {ReturnType<typeof useWorkspace> | undefined} */
  let disk;
  afterEach(() => {
    disk?.restore();
    disk = undefined;
  });

  /**
   * The signature help at the end of `text`, with `files` on disk.
   *
   * @param {string} text
   * @param {{ product?: string, signatureHelpEnabled?: boolean, files?: Record<string, string> }} [options]
   * @returns {Promise<any>}
   */
  async function helpAtEnd(text, { files = {}, ...settings } = {}) {
    const document = makeDocument(text);
    disk = useWorkspace({ files, open: [document] });
    const { providers } = captureRegistrations(() => {
      const index = registerWorkspaceSymbols(/** @type {any} */ ({ workspaceSymbolsEnabled: true }));
      registerSignatureHelp(/** @type {any} */ ({ signatureHelpEnabled: true, product: "any", ...settings }), index.listModules);
    });
    const [provider] = providers.SignatureHelpProvider;
    return provider.provideSignatureHelp(document, document.positionAt(text.length));
  }

  /**
   * Each signature's label, with the active one marked `>` and each one's
   * active parameter in `«»`, for comparing.
   *
   * @param {any} help
   * @returns {string[]}
   */
  const shown = (help) => help.signatures.map((/** @type {any} */ sig, /** @type {number} */ i) => {
    const active = sig.parameters[sig.activeParameter]?.label;
    const label = Array.isArray(active) ? `${sig.label.slice(0, active[0])}«${sig.label.slice(...active)}»${sig.label.slice(active[1])}` : sig.label;
    return `${i === help.activeSignature ? ">" : " "} ${label}`;
  });

  it("shows a function's signature with the parameter the cursor is on", async () => {
    const help = await helpAtEnd("set $r = $Substring($Trim($x), ");
    assert.deepEqual(shown(help), ["> $Substring(Text, «Offset», [Length])"]);
    assert.equal(help.activeParameter, 1);
    assert.ok(help.signatures[0].documentation, "with the function's docs");
  });

  it("finds a call whose arguments span lines, and not one closed already", async () => {
    assert.deepEqual(shown(await helpAtEnd("set $r = $Substring(\n  $x,\n  1,\n  ")), ["> $Substring(Text, Offset, «[Length]»)"]);
    assert.equal(await helpAtEnd("set $r = $Substring($x, 1);\nLog-Information $r"), null);
  });

  it("qualifies an operation's signature with its namespace, and follows a named argument", async () => {
    const help = await helpAtEnd("ProGet::Create-Directory(Path: a, ApiKey: ");
    assert.match(shown(help)[0], /^> ProGet::Create-Directory\(Path: <text>, .*«\[ApiKey: <text>\]»/);
    // A function's namespace isn't written that way.
    assert.deepEqual(shown(await helpAtEnd("set $r = $SHEval(")), ["> $SHEval(«ScriptText»)"]);
  });

  it("shows every form of a function for any product, the one that fits active, and only the product's own otherwise", async () => {
    assert.deepEqual(shown(await helpAtEnd("set $p = $PackageProperty(a, b, ")), [
      "  $PackageProperty(name, «[default]»)", // its last, as far as it goes
      "> $PackageProperty(packageName, packageProperty, «[sourceName]»)",
    ]);
    assert.deepEqual(shown(await helpAtEnd("set $p = $PackageProperty(", { product: "BuildMaster" })), [
      "> $PackageProperty(«packageName», packageProperty, [sourceName])",
    ]);
  });

  it("builds a module call's signature from its declaration, here or in another file", async () => {
    const declaration = "module Greet<$name, out $result, $greeting = hi> {\n}";
    assert.deepEqual(shown(await helpAtEnd(`${declaration}\ncall Greet(name: x, `)), ["> Greet(name, «[out result]», [greeting])"]);
    assert.deepEqual(
      shown(await helpAtEnd("call Greet(greeting: ", { files: { "file:///lib.otter": declaration } })),
      ["> Greet(name, [out result], «[greeting]»)"]
    );
  });

  it("shows nothing for a module it can't find, even when an operation has the name", async () => {
    assert.equal(await helpAtEnd("call Log-Information("), null);
    assert.equal(await helpAtEnd("module Greet<$name> {\n}\ncall OtherRaft::Greet("), null);
  });

  it("shows nothing outside a known call, or when turned off", async () => {
    assert.equal(await helpAtEnd("Log-Information hi;"), null);
    assert.equal(await helpAtEnd("set $r = $NoSuchFunction("), null);
    assert.equal(await helpAtEnd("set $r = $Substring(", { signatureHelpEnabled: false }), null);
  });
});
