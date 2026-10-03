// @ts-check
/**
 * @fileoverview Unit tests for src/providers/signature-help.js: finding the
 * call the cursor is in, the active form and parameter, and the parameter
 * label offsets.
 *
 * Requires the vscode stub before signature-help.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { FUNCTION_SIGNATURE_REGEX, OPERATION_SIGNATURE_REGEX, activeParameterIndex, activeSignatureIndex, findSignatureCall, parameterLabels } = require("../../src/providers/signature-help.js");

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
