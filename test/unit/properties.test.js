// @ts-check
/**
 * @fileoverview Property-based tests (fast-check): the checks and every
 * provider, run on generated documents -- random text, and text built from
 * OtterScript's tokens -- instead of hand-written examples. They catch the
 * input nobody thought of: a crash, a range outside the document, a quick fix
 * that makes things worse, or a scan that slows down with the square of the
 * input's length.
 *
 * Unlike the other test files, this one isn't about one module: it drives
 * the whole extension through what `activate` registers.
 *
 * A failure prints the seed and the smallest input fast-check found that
 * fails; `fc.assert(..., { seed, path })` replays it. The seed is fixed, so a
 * run is repeatable; set FC_SEED to try others, and FC_RUNS for more runs.
 *
 * Requires the vscode stub before extension.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fc = require("fast-check");

const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { assertLinearTime } = require("./timing");
const { captureRegistrations } = require("./fake-workspace");
const { createCodeScanState, createTemplateScanState, maskComments, maskNonCodeSpans, maskOutsideTemplateTags, maskTemplateTagContents } = require("../../src/scanner.js");
const { updateDiagnostics } = require("../../src/diagnostics.js");
const { registerCodeActions } = require("../../src/providers/code-actions.js");
const { activate } = require("../../src/extension.js");

/** The run settings: a fixed seed by default, so a failure can be replayed. */
const RUN = {
  seed: Number(process.env.FC_SEED ?? 20261010),
  numRuns: Number(process.env.FC_RUNS ?? 200),
};

// ============================================================
// Generated documents
// ============================================================

/**
 * Pieces of OtterScript: keywords, sigils, brackets, string and comment
 * delimiters, template tags. Random characters alone seldom get past a
 * scanner's first branch; strung together, these reach the code behind it.
 */
const TOKENS = [
  "set ", "set local ", "set global ", "global ", "local ", "if ", "else ", "foreach ", "in ", "while ", "for ",
  "module ", "call ", "with ", "try", "catch", "throw", "return", "{", "}", "(", ")", "[", "]", ";", ",", ":",
  " = ", " == ", " != ", " => ", " && ", " || ", "!", "<", ">",
  "$x", "$Name", "@list", "%map", "${a b}", "$", "@", "%", "$(", "@(", "%(", "$ToJson(", "$Eval(", "$ListItem(",
  "\"", "'", "`", "\\", ">>", "<<", "#", "//", "/*", "*/", "<%", "%>", "##AH:",
  "Log-Information ", "PSExec ", "Exec ", "Ensure-File ", "InedoCore::", "Windows::", "Core::", "Name: ", "Text: ",
  "lock = ", "retry = ", "async", "await ", "true", "1", "-", "_", "a", "Z", " ", "\t", "\n", "\n", "\n",
];

/** A token, or a few random characters (no `\r`: the test document splits lines on `\n` only). */
const piece = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...TOKENS) },
  { weight: 1, arbitrary: fc.string({ maxLength: 4, unit: "binary" }).map((s) => s.replace(/\r/g, "")) },
);

/** Text that is mostly not OtterScript: up to 120 pieces strung together. */
const tokenSoup = fc.array(piece, { maxLength: 120, size: "max" }).map((pieces) => pieces.join(""));

/** A variable of each kind, some names spelt in another case or braced. */
const variable = fc.tuple(fc.constantFrom("$", "@", "%"), fc.constantFrom("x", "X", "Name", "items", "{a b}"))
  .map(([sigil, name]) => sigil + name);

/** An expression, sometimes a broken one. */
const expression = fc.oneof(
  variable,
  fc.constantFrom("1", "true", "x", "\"text $x\"", "'literal'", ">>multi\nline<<", "@(1, 2)", "%(a: 1, a: 2)",
    "$ToJson(%(a: 1))", "$Eval(1 + 2)", "$ListItem(@items, 0)", "$Unknown()", "$ToJson()", "$(x)"),
  piece,
);

/** An operation, a function-like one, a misspelt one and a namespaced one. */
const operation = fc.constantFrom("Log-Information", "Log-Error", "Exec", "Ensure-File", "Create-Directory",
  "Get-Http", "Set-Variable", "Windows::Ensure-Service", "Core::Log-Warning", "Log-Informaton", "Nope::Thing");

/**
 * Text built from statements, nested a few levels: closer to a real script,
 * so it gets past the bracket check to the checks of names, arguments and
 * expressions (and their quick fixes).
 */
const { block } = fc.letrec((/** @type {fc.LetrecTypedTie<{ statement: string, block: string }>} */ tie) => ({
  statement: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.tuple(fc.constantFrom("set ", "set local ", "set global ", "global ", ""), variable, expression).map(([prefix, v, e]) => `${prefix}${v} = ${e};`),
    fc.tuple(operation, expression).map(([op, e]) => `${op} ${e};`),
    fc.tuple(operation, fc.array(fc.tuple(fc.constantFrom("Name", "Text", "Value", "Message", "Bogus"), fc.constantFrom(": ", " => ", " = "), expression), { maxLength: 3 }))
      .map(([op, args]) => `${op}\n(\n${args.map(([name, op2, e]) => `    ${name}${op2}${e}`).join(",\n")}\n);`),
    fc.tuple(expression, fc.constantFrom(" == ", " != ", " = ", " & ", " && ", " < "), expression, tie("block"), fc.option(tie("block")))
      .map(([a, op, b, then, otherwise]) => `if ${a}${op}${b}\n{\n${then}\n}${otherwise === null ? "" : `\nelse\n{\n${otherwise}\n}`}`),
    fc.tuple(variable, variable, tie("block")).map(([v, list, body]) => `foreach ${v} in ${list}\n{\n${body}\n}`),
    fc.tuple(fc.constantFrom("lock = !x", "retry = 3", "async", "unknown = 1", "lock"), tie("block")).map(([d, body]) => `with ${d}\n{\n${body}\n}`),
    fc.tuple(tie("block"), tie("block")).map(([body, handler]) => `try\n{\n${body}\n}\ncatch\n{\n${handler}\n}`),
    fc.tuple(fc.constantFrom("Greet", "greet", "Missing"), fc.array(expression, { maxLength: 2 })).map(([name, args]) => `call ${name}(${args.map((e, i) => `a${i}: ${e}`).join(", ")});`),
    fc.tuple(fc.constantFrom("Greet", "Other"), tie("block")).map(([name, body]) => `module ${name}<$name, $count = 1>\n{\n${body}\n}`),
    fc.constantFrom("# a comment", "// a comment", "/* a\ncomment */", "##AH:UseTextMode", "<% $x %>", "set $x = 1; # set $y = 2;"),
    piece,
  ),
  block: fc.array(tie("statement"), { maxLength: 6 }).map((statements) => statements.join("\n")),
}));

/** A document's text: OtterScript-like statements, or a soup of its tokens. */
const otterText = fc.oneof(block, tokenSoup);

/** A document, and offsets in it to ask the position-based providers about. */
const withOffsets = otterText.chain((text) =>
  fc.tuple(fc.constant(text), fc.array(fc.nat({ max: text.length }), { minLength: 1, maxLength: 4 })));

// ============================================================
// The extension, as VS Code sees it
// ============================================================

const context = /** @type {any} */ ({
  extension: { packageJSON: { displayName: "OtterScript", version: "0.0.0" } },
  subscriptions: [],
});
const { providers } = captureRegistrations(() => activate(context));

/** Quick fixes and Fix All, on a collection these tests fill. */
const fixes = (() => {
  /** @type {Map<string, any[]>} */
  const collection = new Map();
  const diagnostics = {
    set: (/** @type {any} */ uri, /** @type {any[]} */ issues) => collection.set(uri.toString(), issues),
    get: (/** @type {any} */ uri) => collection.get(uri.toString()),
  };
  const run = (/** @type {any} */ document) => updateDiagnostics(document, /** @type {any} */ (diagnostics), /** @type {any} */ ({}));
  const registered = captureRegistrations(() => {
    registerCodeActions(/** @type {any} */ ({ product: "any", adaptiveCardMaxVersion: "1.6" }), /** @type {any} */ (diagnostics), run);
  });
  const [quickFixes, fixAll] = registered.providers.CodeActionsProvider;
  return { quickFixes, fixAll };
})();

/**
 * `document`'s diagnostics, from the real checks.
 *
 * @param {any} document
 * @returns {any[]}
 */
function diagnose(document) {
  /** @type {any[]} */
  let found = [];
  updateDiagnostics(document, /** @type {any} */ ({ set: (/** @type {any} */ _uri, /** @type {any[]} */ issues) => { found = issues; } }), /** @type {any} */ ({}));
  return found;
}

/**
 * Asserts `position` is in `document`: an existing line, and a character no
 * further than its end.
 *
 * @param {any} document
 * @param {{ line: number, character: number }} position
 * @param {string} what - Which result, in the failure message
 * @returns {void}
 */
function assertInDocument(document, position, what) {
  assert.ok(position.line >= 0 && position.line < document.lineCount, `${what}: line ${position.line} of ${document.lineCount}`);
  const length = document.lineAt(position.line).text.length;
  assert.ok(position.character >= 0 && position.character <= length, `${what}: character ${position.character} of ${length} on line ${position.line}`);
}

/**
 * Asserts `range` is in `document`, and doesn't end before it starts.
 *
 * @param {any} document
 * @param {{ start: { line: number, character: number }, end: { line: number, character: number } }} range
 * @param {string} what
 * @returns {void}
 */
function assertRangeInDocument(document, range, what) {
  assertInDocument(document, range.start, what);
  assertInDocument(document, range.end, what);
  assert.ok(document.offsetAt(range.start) <= document.offsetAt(range.end), `${what}: ends before it starts`);
}

/**
 * Asserts each edit of a WorkspaceEdit is in `document`.
 *
 * @param {any} document
 * @param {any} edit - A stub WorkspaceEdit
 * @param {string} what
 * @returns {void}
 */
function assertEditsInDocument(document, edit, what) {
  for (const [, edits] of edit.entries()) {
    for (const { range } of edits) assertRangeInDocument(document, range, what);
  }
}

/**
 * `document`'s text after `edit`, its edits applied last-first so each one's
 * offsets still hold.
 *
 * @param {any} document
 * @param {any} edit - A stub WorkspaceEdit
 * @returns {string}
 */
function applyEdit(document, edit) {
  const edits = edit.entries().flatMap((/** @type {any} */ [, list]) => list)
    .map((/** @type {any} */ { range, newText }) => ({ start: document.offsetAt(range.start), end: document.offsetAt(range.end), newText }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.start - a.start);
  let text = document.getText();
  for (const { start, end, newText } of edits) text = text.slice(0, start) + newText + text.slice(end);
  return text;
}

/**
 * Runs a provider call that may refuse with a message for the user (rename
 * does, by throwing an `Error`): such a refusal is fine, any other throw (a
 * `TypeError`, a `RangeError`) is a crash.
 *
 * @template T
 * @param {() => T | Promise<T>} call
 * @returns {Promise<T | undefined>}
 */
async function allowingRefusal(call) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && error.constructor === Error) return undefined;
    throw error;
  }
}

// ============================================================
// Properties
// ============================================================

describe("the scanner, on any text", () => {
  it("masks each line to the same length, carrying its state to the next", () => {
    fc.assert(fc.property(otterText, (text) => {
      const code = createCodeScanState();
      const comments = createCodeScanState();
      const outside = createTemplateScanState();
      const inside = createTemplateScanState();
      for (const line of text.split("\n")) {
        assert.equal(maskNonCodeSpans(line, code).length, line.length, "maskNonCodeSpans");
        assert.equal(maskComments(line, comments).length, line.length, "maskComments");
        assert.equal(maskOutsideTemplateTags(line, outside).length, line.length, "maskOutsideTemplateTags");
        assert.equal(maskTemplateTagContents(line, inside).length, line.length, "maskTemplateTagContents");
      }
    }), RUN);
  });
});

describe("the document-wide providers, on any text", () => {
  it("report diagnostics, and their quick fixes, inside the document", () => {
    fc.assert(fc.property(otterText, (text) => {
      const document = makeDocument(text);
      const diagnostics = diagnose(document);
      for (const d of diagnostics) assertRangeInDocument(document, d.range, `diagnostic ${d.code?.value}`);
      for (const action of fixes.quickFixes.provideCodeActions(document, undefined, { diagnostics })) {
        if (action.edit) assertEditsInDocument(document, action.edit, `quick fix "${action.title}"`);
      }
    }), RUN);
  });

  it("Fix All adds no errors", () => {
    fc.assert(fc.property(otterText, (text) => {
      const document = makeDocument(text);
      const errors = (/** @type {any} */ doc) => diagnose(doc).filter((d) => d.severity === stub.DiagnosticSeverity.Error).length;
      const before = errors(document);
      const [action] = fixes.fixAll.provideCodeActions(document, undefined, { diagnostics: [], only: stub.CodeActionKind.SourceFixAll });
      if (!action) return;
      assertEditsInDocument(document, action.edit, "Fix All");
      const fixed = applyEdit(document, action.edit);
      assert.ok(errors(makeDocument(fixed)) <= before, `more errors after Fix All:\n${fixed}`);
    }), RUN);
  });

  it("fold, list symbols and lenses, and place inlay hints inside the document", () => {
    fc.assert(fc.property(otterText, (text) => {
      const document = makeDocument(text);
      for (const fold of providers.FoldingRangeProvider[0].provideFoldingRanges(document)) {
        assert.ok(fold.start >= 0 && fold.start < fold.end && fold.end < document.lineCount, `fold ${fold.start}-${fold.end} of ${document.lineCount} lines`);
      }
      /** @param {any[]} symbols */
      const checkSymbols = (symbols) => {
        for (const symbol of symbols) {
          assertRangeInDocument(document, symbol.range, `symbol ${symbol.name}`);
          assertRangeInDocument(document, symbol.selectionRange, `symbol ${symbol.name}`);
          checkSymbols(symbol.children ?? []);
        }
      };
      checkSymbols(providers.DocumentSymbolProvider[0].provideDocumentSymbols(document));
      for (const lens of providers.CodeLensProvider[0].provideCodeLenses(document)) assertRangeInDocument(document, lens.range, "code lens");
      const whole = new stub.Range(new stub.Position(0, 0), document.positionAt(text.length));
      for (const hint of providers.InlayHintsProvider[0].provideInlayHints(document, whole)) assertInDocument(document, hint.position, "inlay hint");
    }), RUN);
  });
});

describe("the position-based providers, anywhere in any text", () => {
  it("complete, hover, help with signatures and navigate without crashing, inside the document", async () => {
    await fc.assert(fc.asyncProperty(withOffsets, async ([text, offsets]) => {
      const document = makeDocument(text);
      for (const offset of offsets) {
        const position = document.positionAt(offset);
        for (const provider of providers.CompletionItemProvider) {
          const result = await provider.provideCompletionItems(document, position, undefined, { triggerKind: stub.CompletionTriggerKind.Invoke });
          for (const item of (Array.isArray(result) ? result : result?.items ?? [])) {
            if (item.range && "start" in item.range) assertRangeInDocument(document, item.range, `completion ${item.label}`);
          }
        }
        const hover = await providers.HoverProvider[0].provideHover(document, position);
        if (hover?.range) assertRangeInDocument(document, hover.range, "hover");
        await providers.SignatureHelpProvider[0].provideSignatureHelp(document, position, undefined, {});
        for (const highlight of providers.DocumentHighlightProvider[0].provideDocumentHighlights(document, position) ?? []) {
          assertRangeInDocument(document, highlight.range, "highlight");
        }
        await providers.DefinitionProvider[0].provideDefinition(document, position);
        await providers.ReferenceProvider[0].provideReferences(document, position, { includeDeclaration: true });
        const rename = providers.RenameProvider[0];
        if (await allowingRefusal(() => rename.prepareRename(document, position))) {
          const edit = await allowingRefusal(() => rename.provideRenameEdits(document, position, "Renamed"));
          if (edit) assertEditsInDocument(document, edit, "rename");
        }
      }
    }), RUN);
  });
});

describe("the document-wide providers, on long text", () => {
  it("take time linear in its length", () => {
    // A generated snippet repeated to about 100 KB: a scan that looks back
    // or ahead from each position without a bound shows up as seconds here.
    fc.assert(fc.property(fc.array(piece, { minLength: 1, maxLength: 20 }), (pieces) => {
      const unit = pieces.join("") || ";";
      const document = makeDocument(unit.repeat(Math.ceil(100_000 / unit.length)));
      assertLinearTime(() => {
        diagnose(document);
        providers.FoldingRangeProvider[0].provideFoldingRanges(document);
        providers.DocumentSymbolProvider[0].provideDocumentSymbols(document);
      }, JSON.stringify(unit));
    }), { ...RUN, numRuns: Math.ceil(RUN.numRuns / 10) });
  });
});
