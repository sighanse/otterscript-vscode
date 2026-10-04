// @ts-check
/**
 * @fileoverview Unit tests for the parameter-name inlay hints
 * (src/providers/inlay-hints.js): where each hint goes and which arguments
 * get none; then the provider: the range asked for, the setting, and when
 * its cached hints are found again.
 *
 * Requires the vscode stub before the provider module (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { captureRegistrations } = require("./fake-workspace");
const { findParameterNameHints, registerInlayHints } = require("../../src/providers/inlay-hints.js");

/**
 * `text` with each hint written in at its place, `‹Name:›`.
 *
 * @param {string} text
 * @param {string} [product] - The `otterscript.product` setting
 * @returns {string}
 */
function withHints(text, product) {
  let out = text;
  for (const { offset, label } of findParameterNameHints(text, product).reverse()) {
    out = `${out.slice(0, offset)}‹${label}›${out.slice(offset)}`;
  }
  return out;
}

describe("findParameterNameHints", () => {
  it("names each positional argument, before strings and nested calls too", () => {
    assert.equal(withHints("set $s = $Substring($x, 2, 3);"), "set $s = $Substring(‹Text:›$x, ‹Offset:›2, ‹Length:›3);");
    assert.equal(withHints('set $s = $Substring("a,b", $Len($y), 1);'),
      'set $s = $Substring(‹Text:›"a,b", ‹Offset:›$Len($y), ‹Length:›1);');
  });

  it("names no argument that is already a variable of that name, nor past a ... tail", () => {
    assert.equal(withHints("set $s = $Substring($Text, ${offset});"), "set $s = $Substring($Text, ${offset});");
    assert.equal(withHints('set $p = $PathCombine("a", "b", "c");'), 'set $p = $PathCombine(‹Path1:›"a", ‹Path2:›"b", "c");');
  });

  it("leaves out one-parameter functions, unknown ones, comments and template literal text", () => {
    assert.equal(withHints("set $j = $ToJson($x);\nset $t = $Trim($x, \"-\");\nset $f = $Frob(1, 2);"),
      "set $j = $ToJson($x);\nset $t = $Trim($x, \"-\");\nset $f = $Frob(1, 2);");
    assert.equal(withHints("# $Substring($x, 1)"), "# $Substring($x, 1)");
    assert.equal(withHints('<% set $x = $Substring($y, 1); %>\n{ "a": "b" }'), '<% set $x = $Substring(‹Text:›$y, ‹Offset:›1); %>\n{ "a": "b" }');
  });

  it("puts a hint before the argument, not before a comment in front of it", () => {
    assert.equal(withHints("set $s = $Substring(\n  # the text\n  $x,\n  /* from */ 1);"),
      "set $s = $Substring(\n  # the text\n  ‹Text:›$x,\n  /* from */ ‹Offset:›1);");
    assert.equal(withHints("set $s = $Substring(\n  # just $Text\n  $Text, 1);"),
      "set $s = $Substring(\n  # just $Text\n  $Text, ‹Offset:›1);", "a commented variable of the name still counts as named");
  });

  it("uses the selected product's form of a function, and none when the forms disagree", () => {
    assert.equal(withHints("set $p = $PackageProperty($a, $b, $c);", "BuildMaster"),
      "set $p = $PackageProperty(‹packageName:›$a, ‹packageProperty:›$b, ‹sourceName:›$c);");
    assert.equal(withHints("set $p = $PackageProperty($a, $b);", "ProGet"), "set $p = $PackageProperty(‹name:›$a, ‹default:›$b);");
    assert.equal(withHints("set $p = $PackageProperty($a, $b, $c);"),
      "set $p = $PackageProperty(‹packageName:›$a, ‹packageProperty:›$b, ‹sourceName:›$c);", "any: only BuildMaster's takes three");
    assert.equal(withHints("set $p = $PackageProperty($a, $b);"), "set $p = $PackageProperty($a, $b);", "any: both take two");
  });

  it("stops an unclosed call at its statement", () => {
    assert.equal(withHints('set $s = $Substring($x,\nLog-Information "a, b";'), 'set $s = $Substring(‹Text:›$x,\nLog-Information "a, b";');
  });
});

// ============================================================
// The provider
// ============================================================

describe("inlay hints provider", () => {
  /**
   * Registers the provider with `settings`, which a test may change later
   * as the settings listener in extension.js does.
   *
   * @param {{ parameterNameHints?: boolean, product?: string }} [overrides]
   * @returns {{ provider: any, settings: { parameterNameHints: boolean, product: string } }}
   */
  function register(overrides = {}) {
    const settings = { parameterNameHints: true, product: "any", ...overrides };
    const { providers } = captureRegistrations(() => registerInlayHints(/** @type {any} */ (settings)));
    return { provider: providers.InlayHintsProvider[0], settings };
  }

  /**
   * The hints for the lines `[fromLine, toLine]` of `document`, as
   * `"<line>:<character> <label>"`.
   *
   * @param {any} provider
   * @param {any} document
   * @param {number} [fromLine]
   * @param {number} [toLine]
   * @returns {string[]}
   */
  const hintsIn = (provider, document, fromLine = 0, toLine = document.lineCount - 1) =>
    provider.provideInlayHints(document, new stub.Range(fromLine, 0, toLine, document.lineAt(toLine).text.length))
      .map((/** @type {any} */ h) => `${h.position.line}:${h.position.character} ${h.label}`);

  const text = ["set $a = $Substring($x, 2);", "set $b = $Substring($y, 3);"].join("\n");

  it("shows each parameter name as a padded Parameter hint", () => {
    const { provider } = register();
    const document = makeDocument(text);
    assert.deepEqual(hintsIn(provider, document), ["0:20 Text:", "0:24 Offset:", "1:20 Text:", "1:24 Offset:"]);
    const [hint] = provider.provideInlayHints(document, new stub.Range(0, 0, 0, 30));
    assert.equal(hint.kind, stub.InlayHintKind.Parameter);
    assert.equal(hint.paddingRight, true);
  });

  it("shows only the hints in the range asked for", () => {
    const { provider } = register();
    assert.deepEqual(hintsIn(provider, makeDocument(text), 1, 1), ["1:20 Text:", "1:24 Offset:"]);
  });

  it("shows none when turned off", () => {
    const { provider } = register({ parameterNameHints: false });
    assert.deepEqual(hintsIn(provider, makeDocument(text)), []);
  });

  it("finds the hints again for a new product, a new version, or another document of the same name", () => {
    const { provider, settings } = register();
    const call = "set $p = $PackageProperty($a, $b);";
    const document = makeDocument(call, { uri: "untitled:Untitled-1" });
    assert.deepEqual(hintsIn(provider, document), [], "the forms disagree on two arguments");
    settings.product = "ProGet";
    assert.deepEqual(hintsIn(provider, document), ["0:26 name:", "0:30 default:"]);

    const edited = makeDocument(`${call}\n${call}`, { uri: "untitled:Untitled-1", version: 2 });
    assert.equal(hintsIn(provider, edited).length, 4);
    const reopened = makeDocument("Log-Information hi;", { uri: "untitled:Untitled-1", version: 2 });
    assert.deepEqual(hintsIn(provider, reopened), []);
  });

  it("asks VS Code for new hints when the hint or product setting changes, and only then", () => {
    const workspace = /** @type {any} */ (stub.workspace);
    workspace.configurationListeners.length = 0;
    const { provider } = register();
    let fired = 0;
    provider.onDidChangeInlayHints(() => fired++);
    for (const section of ["otterscript.inlayHints", "otterscript.product", "otterscript.hover"]) {
      for (const listener of workspace.configurationListeners) listener({ affectsConfiguration: (/** @type {string} */ s) => s === section });
    }
    assert.equal(fired, 2);
  });
});
