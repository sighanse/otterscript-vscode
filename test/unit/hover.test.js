// @ts-check
/**
 * @fileoverview Unit tests for src/providers/hover.js: each resolver of the
 * hover chain -- what it recognizes and what it leaves to the next one --
 * the chain's order, and the markdown helper. VS Code itself is tested in
 * test/integration/intellisense.test.js.
 *
 * Requires the vscode stub before hover.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { makeDocument } = require("./fake-document");
const {
  hoverArgument,
  hoverExpressionDelimiter,
  hoverKeyword,
  hoverModuleCall,
  hoverOperation,
  hoverRegion,
  hoverSwimString,
  hoverSymbol,
  hoverTemplateTag,
  hoverVariable,
  inlineCode,
  resolveHover,
  stopInStringOrComment,
  registerHover,
} = require("../../src/providers/hover.js");

/** A hover context without settings or other workspace files. */
const context = { product: "any", listWorkspaceModules: async () => [] };

/**
 * Where `marker` starts in `text` (its first occurrence), plus `offset`.
 *
 * @param {string} text
 * @param {string} marker
 * @param {number} [offset]
 * @returns {any} A `vscode.Position`
 */
function at(text, marker, offset = 0) {
  const index = text.indexOf(marker);
  assert.ok(index !== -1, `${marker} in ${text}`);
  const before = text.slice(0, index + offset).split("\n");
  return { line: before.length - 1, character: before[before.length - 1].length };
}

/**
 * Runs a resolver at `marker` in `text`.
 *
 * @param {import("../../src/providers/hover.js").HoverResolver} resolver
 * @param {string} text
 * @param {string} marker
 * @param {number} [offset]
 * @returns {Promise<any>}
 */
async function run(resolver, text, marker, offset = 0) {
  return resolver(makeDocument(text, { languageId: "otterscript" }), at(text, marker, offset), context);
}

/**
 * A hover's markdown, or what the resolver returned instead.
 *
 * @param {any} hover
 * @returns {string | null | undefined}
 */
const markdown = (hover) => (hover ? hover.contents.map((/** @type {{ value: string }} */ c) => c.value).join("\n") : hover);

/**
 * The hover's range as `line:start-end`.
 *
 * @param {any} hover
 * @returns {string}
 */
const span = (hover) => `${hover.range.start.line}:${hover.range.start.character}-${hover.range.end.character}`;

describe("hoverRegion", () => {
  it("documents #region and #endregion at the start of a line", async () => {
    const hover = await run(hoverRegion, "  #region Setup\n#endregion", "#region", 3);
    assert.match(markdown(hover) ?? "", /region/i);
    assert.equal(span(hover), "0:2-9");
    assert.ok(await run(hoverRegion, "  #region Setup\n#endregion", "#endregion"));
  });

  it("leaves a #region elsewhere, or the rest of the line, to the others", async () => {
    assert.equal(await run(hoverRegion, 'Log-Information "#region";', "#region"), undefined);
    assert.equal(await run(hoverRegion, "#region Setup", "Setup"), undefined);
  });
});

describe("stopInStringOrComment", () => {
  it("stops the chain inside a string or comment", async () => {
    assert.equal(await run(stopInStringOrComment, 'Log-Information "if"; # foreach', '"if"', 1), null);
    assert.equal(await run(stopInStringOrComment, 'Log-Information "if"; # foreach', "foreach"), null);
  });

  it("lets code through", async () => {
    assert.equal(await run(stopInStringOrComment, 'Log-Information "if";', "Log"), undefined);
  });
});

describe("hoverArgument", () => {
  it("documents an operation's argument name", async () => {
    const hover = await run(hoverArgument, "Copy-Files(From: $a, To: $b);", "To:");
    assert.match(markdown(hover) ?? "", /Argument of `Copy-Files`/);
    assert.equal(span(hover), "0:21-23");
  });

  it("documents a module's parameter in its call", async () => {
    const text = "module Report<in $path, out $result> {\n}\ncall Report(path: $p, result: $r);";
    assert.match(markdown(await run(hoverArgument, text, "result:")) ?? "", /`result` \(optional, out \$result\)/);
  });

  it("leaves a value, an unknown argument or an unknown call to the others", async () => {
    assert.equal(await run(hoverArgument, "Copy-Files(From: $a, To: $b);", "$b"), undefined);
    assert.equal(await run(hoverArgument, "Copy-Files(Nope: $a);", "Nope"), undefined);
    assert.equal(await run(hoverArgument, "Frobnicate(To: $a);", "To"), undefined);
  });
});

describe("hoverModuleCall", () => {
  it("shows a called module's declaration and its comment, as plain text", async () => {
    const text = "# Says *hi*.\n# [Fix](https://example.invalid)\nmodule Hi<$who> {\n}\ncall Hi(who: x);";
    const hover = await run(hoverModuleCall, text, "call Hi", 6);
    assert.equal(markdown(hover), "\n```otterscript\nmodule Hi<$who>\n```\nSays&nbsp;\\*hi\\*.  \n\\[Fix\\]\\(https://example.invalid\\)\n\n");
    assert.equal(span(hover), "4:5-7");
  });

  it("stops the chain at a module name it can't show: a declaration, or an unknown module", async () => {
    assert.equal(await run(hoverModuleCall, "module Build {\n}", "Build"), null);
    assert.equal(await run(hoverModuleCall, "call Build;", "Build"), null);
  });

  it("leaves anything but a module name to the others", async () => {
    assert.equal(await run(hoverModuleCall, "Build x;", "Build"), undefined);
  });
});

describe("hoverTemplateTag", () => {
  it("documents <% and %>", async () => {
    assert.ok(await run(hoverTemplateTag, "Hi <% $x %>", "<%"));
    assert.ok(await run(hoverTemplateTag, "Hi <% $x %>", "%>", 1));
    assert.equal(await run(hoverTemplateTag, "Hi <% $x %>", "$x"), undefined);
  });
});

describe("hoverExpressionDelimiter", () => {
  it("documents %(, @( and $(", async () => {
    const text = "set %m = %(a: 1); set @v = @(1); set $s = $(1);";
    for (const marker of ["%(", "@(", "$("]) {
      assert.equal(span(await run(hoverExpressionDelimiter, text, marker)), `0:${text.indexOf(marker)}-${text.indexOf(marker) + 2}`);
    }
    assert.equal(await run(hoverExpressionDelimiter, text, "set"), undefined);
  });
});

describe("hoverKeyword", () => {
  it("documents a keyword, also the two-word `force normal`", async () => {
    assert.match(markdown(await run(hoverKeyword, "if $x { }", "if")) ?? "", /if/);
    assert.equal(span(await run(hoverKeyword, "force normal;", "normal")), "0:0-12");
  });

  it("leaves other words to the others", async () => {
    assert.equal(await run(hoverKeyword, "Log-Information x;", "Log"), undefined);
  });
});

describe("hoverSwimString", () => {
  it("documents a swim-string delimiter", async () => {
    assert.ok(await run(hoverSwimString, "set $s = >>text>>;", ">>"));
    assert.equal(await run(hoverSwimString, "set $s = 1;", "1"), undefined);
  });
});

describe("hoverOperation", () => {
  it("documents an operation where a statement starts", async () => {
    const hover = await run(hoverOperation, "if $x { Copy-Files(From: a, To: b); }", "Copy");
    assert.match(markdown(hover) ?? "", /Copy-Files/);
    assert.equal(span(hover), "0:8-18");
  });

  it("leaves a word that isn't at a statement's start, or isn't an operation, to the others", async () => {
    assert.equal(await run(hoverOperation, "Log-Information Build;", "Build"), undefined);
    assert.equal(await run(hoverOperation, "Frobnicate-It;", "Frob"), undefined);
  });

  it("picks the namespace's form, or lists the other forms without one", async () => {
    const qualified = markdown(await run(hoverOperation, "DotNet::Build Project;", "Build")) ?? "";
    assert.doesNotMatch(qualified, /Also /);
    const plain = markdown(await run(hoverOperation, "Build Project;", "Build")) ?? "";
    assert.match(plain, /Also .*`DotNet::Build`.*write the namespace to pick one/s);
  });
});

describe("hoverSymbol", () => {
  it("documents a function or runtime variable after its sigil", async () => {
    assert.match(markdown(await run(hoverSymbol, "set $j = $ToJson(%m);", "$ToJson")) ?? "", /ToJson/);
    assert.match(markdown(await run(hoverSymbol, "set @v = @Split($s, ,);", "@Split")) ?? "", /Split/);
    assert.match(markdown(await run(hoverSymbol, "set %m = %MapAdd(%m, k, v);", "%MapAdd")) ?? "", /MapAdd/);
  });

  it("ends the chain with no hover for an undocumented name, or no name", async () => {
    assert.equal(await run(hoverSymbol, "set $mine = 1;", "$mine"), null);
    assert.equal(await run(hoverSymbol, "set $mine = 1;", "="), null);
  });
});

describe("hoverVariable", () => {
  it("shows where a variable of the file is assigned, and how often it's used", async () => {
    const text = 'set $version = "1.2.3";\nLog-Information $version;\nset $version = "2";\nLog-Information $version;\nLog-Information "Version: $version";';
    const hover = await run(hoverVariable, text, "$version;");
    assert.equal(markdown(hover),
      "`$version`: variable of this file\n\n" +
      '```otterscript\nset $version = "1.2.3";\nset $version = "2";\n```\n\n' +
      "Assigned on lines 1 and 3 · used 3 times");
    assert.equal(span(hover), "1:16-24");
  });

  it("works on the assignment itself and inside a string", async () => {
    const text = 'set $x = 1;\nLog-Information "x is $x";';
    assert.equal(span(await run(hoverVariable, text, "$x = ")), "0:4-6");
    assert.equal(span(await run(hoverVariable, text, "$x\"")), "1:22-24");
  });

  it("names a module parameter, its direction and whether it's optional", async () => {
    const text = "module Deploy<in $app, out @result, $mode = fast> {\n  Log-Information $app $mode;\n}";
    assert.match(markdown(await run(hoverVariable, text, "$app $mode")) ?? "", /^`\$app`: parameter of module `Deploy`\n/);
    assert.match(markdown(await run(hoverVariable, text, "@result")) ?? "", /^`@result`: parameter of module `Deploy` \(out\)\n/);
    assert.match(markdown(await run(hoverVariable, text, "$mode;")) ?? "", /^`\$mode`: parameter of module `Deploy` \(optional\)\n/);
  });

  it("names a loop variable and an operation's output", async () => {
    const loop = "foreach $item in @items {\n  Log-Information $item;\n}";
    assert.match(markdown(await run(hoverVariable, loop, "$item;")) ?? "", /^`\$item`: loop variable of the `foreach` on line 1\n/);
    const output = 'Get-Http(Url: "u", ResponseBody => $body);\nLog-Information $body;';
    assert.match(markdown(await run(hoverVariable, output, "$body;")) ?? "", /^`\$body`: receives the `ResponseBody` output on line 1\n/);
  });

  it("says when the file never assigns the variable, or never uses it", async () => {
    const unassigned = await run(hoverVariable, "Log-Information $fromCaller;", "$fromCaller");
    assert.equal(markdown(unassigned),
      "`$fromCaller` isn't assigned in this file: it may come from the caller, a configuration variable or the runtime.\n\n" +
      "Used once");
    assert.match(markdown(await run(hoverVariable, "set $unused = 1;", "$unused")) ?? "", /Assigned on line 1 · never used$/);
  });

  it("shows at most 3 assignments, and the line numbers of the rest", async () => {
    const text = Array.from({ length: 5 }, (_, i) => `set $n = ${i};`).join("\n");
    const md = markdown(await run(hoverVariable, text, "$n")) ?? "";
    assert.equal((md.match(/^set \$n/gm) ?? []).length, 3);
    assert.match(md, /Assigned on lines 1, 2, 3, 4 and 5 · never used$/);
  });

  it("shows a name with spaces in braces, and fences a line holding backticks", async () => {
    const text = "set ${my var} = \"```\";\nLog-Information ${my var};";
    const md = markdown(await run(hoverVariable, text, "${my var};")) ?? "";
    assert.match(md, /^`\$\{my var\}`: variable of this file\n\n````otterscript\nset \$\{my var\} = "```";\n````/);
  });

  it("leaves documented names, function calls, comments and non-variables to the others", async () => {
    assert.equal(await run(hoverVariable, "set $x = $PackageName;", "$PackageName"), undefined);
    assert.equal(await run(hoverVariable, "set $x = $ToJson(%m);", "$ToJson"), undefined);
    assert.equal(await run(hoverVariable, "set $x = 1; # $x", "# $x", 2), undefined);
    assert.equal(await run(hoverVariable, "set $x = 1;", "set"), undefined);
  });
});

describe("resolveHover (the chain's order)", () => {
  it("shows a variable inside a string, where nothing else has a hover", async () => {
    const text = 'set $x = 1;\nLog-Information "if $x";';
    assert.equal(await resolveHover(makeDocument(text), at(text, "if"), context), null);
    assert.match(markdown(await resolveHover(makeDocument(text), at(text, "$x\""), context)) ?? "", /^`\$x`: variable of this file/);
  });

  it("shows #region although the line is a comment to OtterScript", async () => {
    const text = "#region Setup";
    assert.ok(await resolveHover(makeDocument(text), at(text, "region"), context));
  });

  it("shows nothing inside a string, even for a keyword there", async () => {
    const text = 'Log-Information "if";';
    assert.equal(await resolveHover(makeDocument(text), at(text, "if"), context), null);
  });

  it("shows an argument as the argument, not as the operation of the same name", async () => {
    const text = "module M<$Build> {\n}\ncall M(Build: 1);";
    assert.match(markdown(await resolveHover(makeDocument(text), at(text, "Build:"), context)) ?? "", /Argument of `module M`/);
  });

  it("shows nothing for an unknown module, not the operation it's named like", async () => {
    const text = "call Build;";
    assert.equal(await resolveHover(makeDocument(text), at(text, "Build"), context), null);
  });
});

describe("inlineCode", () => {
  it("fences a name in one backtick", () => {
    assert.equal(inlineCode("scripts/main.otter"), "`scripts/main.otter`");
  });

  it("fences a name with backticks in more of them than its longest run", () => {
    assert.equal(inlineCode("a`b``c.otter"), "```a`b``c.otter```");
  });

  it("pads a name that starts or ends with a backtick", () => {
    assert.equal(inlineCode("`x.otter"), "`` `x.otter ``");
    assert.equal(inlineCode("x`"), "`` x` ``");
  });
});

// ============================================================
// registerHover
// ============================================================

describe("registerHover", () => {
  const { captureRegistrations } = require("./fake-workspace");

  /**
   * The hover provider, registered with `settings`.
   *
   * @param {{ hoverEnabled: boolean }} settings
   * @returns {any}
   */
  const provider = (settings) =>
    captureRegistrations(() => registerHover(/** @type {any} */ ({ product: "any", ...settings }), async () => [])).providers.HoverProvider[0];

  it("hovers with the chain when on, and not at all when off", async () => {
    const document = makeDocument("Log-Information hi;");
    const position = document.positionAt(3);
    assert.match(String(markdown(await provider({ hoverEnabled: true }).provideHover(document, position))), /Log-Information/);
    assert.equal(provider({ hoverEnabled: false }).provideHover(document, position), null);
  });
});
