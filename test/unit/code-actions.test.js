// @ts-check
/**
 * @fileoverview Unit tests for the quick fixes of src/providers/code-actions.js:
 * each fix factory's edit, the closest-name suggestions and the
 * missing-argument fix; then, on the real checks' diagnostics, the
 * lightbulb provider, Fix All (the command and the source.fixAll action),
 * and the commands that turn a code off and re-check a file.
 *
 * Requires the vscode stub before code-actions.js (which pulls in vscode) loads.
 */

require("../vscode-stub");

const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { Position } = require("../vscode-stub");
const stub = require("../vscode-stub");
const { makeDocument } = require("./fake-document");
const { captureRegistrations, useWorkspace } = require("./fake-workspace");
const { updateDiagnostics } = require("../../src/diagnostics.js");
const {
  createAssignmentInConditionFix,
  createForToForeachFix,
  createInvalidOperatorFix,
  createMissingArgumentFix,
  createMissingDollarFix,
  createTemplateEndFix,
  createUnknownArgumentFix,
  createUnknownFunctionFix,
  createUnknownNamespaceFix,
  createUnknownOperationFix,
  nearestNamespace,
  registerCodeActions,
} = require("../../src/providers/code-actions.js");

/**
 * A fake `vscode.TextDocument` backed by a plain string (see fake-document.js).
 *
 * @param {string} text
 * @returns {any}
 */
const makeDoc = (text) => makeDocument(text);

// ============================================================
// nearestNamespace
// ============================================================

describe("nearestNamespace", () => {
  it("returns the canonical casing for a case-only mismatch", () => {
    assert.equal(nearestNamespace("proget"), "ProGet");
    assert.equal(nearestNamespace("WINDOWS"), "Windows");
  });

  it("corrects a small typo (insertion, substitution, transposition)", () => {
    assert.equal(nearestNamespace("PowerShel"), "PowerShell");
    assert.equal(nearestNamespace("Windoze"), "Windows");
    assert.equal(nearestNamespace("Dokcer"), "Docker");
    assert.equal(nearestNamespace("filez"), "Files");
  });

  it("returns null for a token that is not a plausible typo of any namespace", () => {
    assert.equal(nearestNamespace("Frobnicate"), null);
    assert.equal(nearestNamespace("Xyzzy"), null);
  });
});

// ============================================================
// createUnknownNamespaceFix
// ============================================================

describe("createUnknownNamespaceFix", () => {
  /**
   * @param {string} line
   * @param {number} start
   * @param {number} end
   */
  const fixFor = (line, start, end) => {
    const doc = makeDoc(line);
    const diagnostic = /** @type {any} */ ({
      range: { start: new Position(0, start), end: new Position(0, end) },
      code: "unknown-namespace",
      source: "OtterScript",
    });
    return createUnknownNamespaceFix(doc, diagnostic);
  };

  it("replaces the token with the nearest known namespace", () => {
    const fix = /** @type {any} */ (fixFor("Windoze::Sign-Exe (SubjectName: x);", 0, 7));
    assert.ok(fix);
    assert.equal(fix.title, "Change namespace to 'Windows'");
    assert.equal(fix.isPreferred, false, "a guess: left to the lightbulb, not Fix All");
    const [op, , range, newText] = fix.edit.edits[0];
    assert.equal(op, "replace");
    assert.equal(newText, "Windows");
    assert.equal(range.start.character, 0);
    assert.equal(range.end.character, 7);
  });

  it("fixes a case-only mismatch to canonical casing", () => {
    const fix = fixFor("proget::Install-Package (Name: x);", 0, 6);
    assert.ok(fix);
    assert.equal(fix.title, "Change namespace to 'ProGet'");
    assert.equal(fix.isPreferred, true, "only the casing: Fix All applies it");
  });

  it("returns null when nothing is close enough to suggest", () => {
    assert.equal(fixFor("Frobnicate::Do-Thing x;", 0, 10), null);
  });
});

// ============================================================
// Name suggestions and missing arguments
// ============================================================

describe("name-suggestion and missing-argument fixes", () => {
  /**
   * The fix `factory` offers for a diagnostic over `[start, end)` of `text`'s
   * line `line`.
   *
   * @param {(doc: any, diagnostic: any) => any} factory
   * @param {string} text
   * @param {number} start
   * @param {number} end
   * @param {number} [line]
   * @returns {any}
   */
  const fixFor = (factory, text, start, end, line = 0) =>
    factory(makeDoc(text), { range: new stub.Range(new Position(line, start), new Position(line, end)), source: "OtterScript" });
  /**
   * `text` with the fix's edits applied.
   *
   * @param {any} fix
   * @param {string} text
   * @returns {string}
   */
  const applied = (fix, text) => {
    const doc = makeDoc(text);
    const edits = fix.edit.edits.map((/** @type {any} */ [op, , where, newText]) => {
      const start = doc.offsetAt(op === "insert" ? where : where.start);
      return { start, end: op === "insert" ? start : doc.offsetAt(where.end), newText };
    });
    return edits.sort((/** @type {any} */ a, /** @type {any} */ b) => b.start - a.start)
      .reduce((/** @type {string} */ out, /** @type {any} */ e) => out.slice(0, e.start) + e.newText + out.slice(e.end), text);
  };
  /**
   * @param {any} doc
   * @param {any} diagnostic
   */
  const anyProduct = (doc, diagnostic) => createUnknownFunctionFix(doc, diagnostic, "any");

  it("changes an unknown function to the closest of its sigil, preferred only for a casing difference", () => {
    const fix = fixFor(anyProduct, "set $s = $Substrng($x, 1);", 10, 18);
    assert.equal(fix.title, "Change to '$Substring'");
    assert.equal(fix.isPreferred, false);
    assert.equal(applied(fix, "set $s = $Substrng($x, 1);"), "set $s = $Substring($x, 1);");
    assert.equal(fixFor(anyProduct, "set $s = $substring($x, 1);", 10, 19).isPreferred, true);
    assert.equal(fixFor(anyProduct, "set @l = @Splitt($x);", 10, 16).title, "Change to '@Split'");
    assert.equal(fixFor(anyProduct, "set $s = $Frobnicate();", 10, 20), null);
  });

  it("changes an unknown operation to the closest one, in the namespace written", () => {
    /**
     * @param {any} doc
     * @param {any} diagnostic
     */
    const factory = (doc, diagnostic) => createUnknownOperationFix(doc, diagnostic, "any");
    assert.equal(fixFor(factory, "Copy-Fils(To: $x);", 0, 9).title, "Change to 'Copy-Files'");
    assert.equal(fixFor(factory, "ProGet::Create-Directori(Path: x);", 8, 24).title, "Change to 'Create-Directory'");
    assert.equal(fixFor(factory, "Frobnicate-Everything;", 0, 21), null);
  });

  it("changes a misspelt argument name to the documented one", () => {
    const text = 'Copy-Files(Fomr: "a", To: "b");';
    const fix = fixFor(createUnknownArgumentFix, text, 11, 15);
    assert.equal(fix.title, "Change to 'From'");
    assert.equal(applied(fix, text), 'Copy-Files(From: "a", To: "b");');
  });

  it("adds the missing required arguments after the last one, on lines of their own in a multi-line call", () => {
    /**
     * @param {string} text
     * @param {number} start - Of the operation name, on line 0
     * @param {number} end
     */
    const add = (text, start, end) => {
      const fix = fixFor(createMissingArgumentFix, text, start, end);
      assert.equal(fix.isPreferred, false, "the values are the user's to write");
      return applied(fix, text);
    };
    assert.equal(add('Copy-Files(From: "a, b");', 0, 10), 'Copy-Files(From: "a, b", To: );');
    assert.equal(add("Copy-Files();", 0, 10), "Copy-Files(To: );");
    assert.equal(add('Copy-Files(\n    From: "a" # (source)\n);', 0, 10), 'Copy-Files(\n    From: "a", # (source)\n    To: \n);');
    assert.equal(add('Copy-Files(\n    Include: @("*"),\n);', 0, 10), 'Copy-Files(\n    Include: @("*"),\n    To: \n);');
    assert.equal(add('Jira::Create-Issue(Title: "x");', 6, 18), 'Jira::Create-Issue(Title: "x", Type: );');
    // A block comment that goes on past the line: on the same line, not in the comment.
    assert.equal(add('Copy-Files(\n    From: "a" /* source\n    folder */\n);', 0, 10),
      'Copy-Files(\n    From: "a", To:  /* source\n    folder */\n);');
    assert.equal(fixFor(createMissingArgumentFix, 'Copy-Files(From: "a", To: "b");', 0, 10), null, "nothing missing any more");
  });
});

// ============================================================
// quick-fix factories
// ============================================================

describe("quick-fix factories", () => {
  /**
   * @param {number} s
   * @param {number} e
   */
  const diagAt = (s, e) => /** @type {any} */ ({
    range: { start: new Position(0, s), end: new Position(0, e) },
  });

  it("createMissingDollarFix inserts '$' at the diagnostic start", () => {
    const fix = /** @type {any} */ (createMissingDollarFix(makeDoc("if x == 5"), diagAt(3, 4)));
    assert.equal(fix.title, "Insert missing '$'");
    assert.equal(fix.isPreferred, true);
    assert.equal(fix.diagnostics.length, 1);
    const [op, , at, text] = fix.edit.edits[0];
    assert.equal(op, "insert");
    assert.equal(text, "$");
    assert.equal(at.character, 3);
  });

  it("createInvalidOperatorFix: & -> &&, | -> ||, other -> null", () => {
    const amp = /** @type {any} */ (createInvalidOperatorFix(makeDoc("if $a & $b"), diagAt(6, 7)));
    assert.equal(amp.title, "Replace '&' with '&&'");
    assert.equal(amp.edit.edits[0][3], "&&");
    const pipe = /** @type {any} */ (createInvalidOperatorFix(makeDoc("if $a | $b"), diagAt(6, 7)));
    assert.equal(pipe.edit.edits[0][3], "||");
    assert.equal(createInvalidOperatorFix(makeDoc("if $a + $b"), diagAt(6, 7)), null);
  });

  it("createAssignmentInConditionFix: '=' -> '==', anything else -> null", () => {
    const fix = /** @type {any} */ (createAssignmentInConditionFix(makeDoc("if $x = 5"), diagAt(6, 7)));
    assert.equal(fix.title, "Replace '=' with '=='");
    assert.equal(fix.edit.edits[0][3], "==");
    assert.equal(createAssignmentInConditionFix(makeDoc("if $x == 5"), diagAt(6, 8)), null);
  });

  it("createForToForeachFix replaces 'for' with 'foreach'", () => {
    const fix = /** @type {any} */ (createForToForeachFix(makeDoc("for $x in y"), diagAt(0, 3)));
    assert.equal(fix.title, "Replace 'for' with 'foreach'");
    assert.equal(fix.edit.edits[0][3], "foreach");
  });

  it("createForToForeachFix also works for a dashed loop variable", () => {
    assert.ok(createForToForeachFix(makeDoc("for $item-name in @list {"), diagAt(0, 3)));
  });

  it("createForToForeachFix offers nothing for the counting form, which has no foreach equivalent", () => {
    assert.equal(createForToForeachFix(makeDoc("for $i = 1 to 10 {"), diagAt(0, 3)), null);
  });

  it("createTemplateEndFix replaces the diagnostic range with '}'", () => {
    const fix = /** @type {any} */ (createTemplateEndFix(makeDoc("<% end %>"), diagAt(3, 6)));
    assert.equal(fix.title, "Replace with '}'");
    assert.equal(fix.edit.edits[0][0], "replace");
    assert.equal(fix.edit.edits[0][3], "}");
  });
});

// ============================================================
// The providers and commands
// ============================================================

/**
 * Registers the quick fixes with a diagnostics collection the real checks
 * fill, as extension.js does, or else `check`.
 *
 * @param {(document: any) => any[]} [check] - The diagnostics to report
 *   instead of the real checks'
 *
 * @returns {{
 *   quickFixes: any,
 *   fixAll: any,
 *   commands: Record<string, (...args: any[]) => any>,
 *   collection: Map<string, any[]>,
 *   checked: () => number
 * }} The lightbulb provider, the source.fixAll provider, the commands,
 *   the diagnostics by URI, and how many times a document was checked
 */
function registerFixes(check) {
  /** @type {Map<string, any[]>} */
  const collection = new Map();
  const diagnostics = {
    set: (/** @type {any} */ uri, /** @type {any[]} */ issues) => collection.set(uri.toString(), issues),
    get: (/** @type {any} */ uri) => collection.get(uri.toString()),
  };
  let runs = 0;
  /** @param {any} document */
  const runDiagnostics = (document) => {
    runs++;
    if (check) diagnostics.set(document.uri, check(document));
    else updateDiagnostics(document, /** @type {any} */ (diagnostics), /** @type {any} */ ({}));
  };
  const { providers, commands } = captureRegistrations(() => {
    registerCodeActions(/** @type {any} */ ({ product: "any", adaptiveCardMaxVersion: "1.6" }), /** @type {any} */ (diagnostics), runDiagnostics);
  });
  const [quickFixes, fixAll] = providers.CodeActionsProvider;
  return { quickFixes, fixAll, commands, collection, checked: () => runs };
}

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
 * Each edit of `edit` as `"<line>:<start>-<end> <text>"`, in order.
 *
 * @param {any} edit - A stub WorkspaceEdit
 * @returns {string[]}
 */
const describeEdits = (edit) => edit.edits.map((/** @type {any} */ [op, , where, text]) => {
  const range = op === "insert" ? { start: where, end: where } : where;
  return `${range.start.line}:${range.start.character}-${range.end.character} ${text}`;
});

describe("quick fixes (lightbulb)", () => {
  it("offers each diagnostic's fix, which re-checks the file once applied", () => {
    const { quickFixes } = registerFixes();
    const doc = makeDoc("if x == 5 {\n}\nif $a & $b {\n}");
    const actions = quickFixes.provideCodeActions(doc, undefined, { diagnostics: diagnose(doc) });
    const fixes = actions.filter((/** @type {any} */ a) => a.edit);
    assert.deepEqual(fixes.map((/** @type {any} */ a) => a.title), ["Insert missing '$'", "Replace '&' with '&&'"]);
    assert.deepEqual(fixes[0].command, { command: "otterscript.refreshDiagnostics", title: "Refresh OtterScript diagnostics", arguments: [doc.uri] });
  });

  it("offers to turn off each code once, after the fixes, in the workspace's settings when a folder is open", () => {
    const { quickFixes } = registerFixes();
    const doc = makeDoc("if x == 5 {\n}\nif y == 6 {\n}\nLog-Informaton hi;");
    const diagnostics = diagnose(doc);
    const titles = () => quickFixes.provideCodeActions(doc, undefined, { diagnostics }).map((/** @type {any} */ a) => a.title);
    assert.deepEqual(titles(), [
      "Insert missing '$'",
      "Insert missing '$'",
      "Change to 'Log-Information'",
      "Turn off 'missing-dollar' diagnostics in user settings",
      "Turn off 'unknown-operation' diagnostics in user settings",
    ]);
    const workspace = /** @type {any} */ (stub.workspace);
    workspace.workspaceFolders = [{}];
    try {
      assert.equal(titles().at(-1), "Turn off 'unknown-operation' diagnostics in workspace settings");
    } finally {
      workspace.workspaceFolders = undefined;
    }
    const [turnOff] = quickFixes.provideCodeActions(doc, undefined, { diagnostics }).filter((/** @type {any} */ a) => !a.edit);
    assert.deepEqual(turnOff.command.arguments, ["missing-dollar"]);
    assert.deepEqual(turnOff.diagnostics, [diagnostics[0]]);
  });

  it("ignores other extensions' diagnostics and codes it has no fix or rule for", () => {
    const { quickFixes } = registerFixes();
    const doc = makeDoc("if x == 5 {\n}");
    const [diagnostic] = diagnose(doc);
    const range = diagnostic.range;
    const diagnostics = [
      Object.assign(new stub.Diagnostic(range, "spelling"), { source: "cSpell", code: "missing-dollar" }),
      Object.assign(new stub.Diagnostic(range, "other"), { source: "OtterScript", code: "no-such-code" }),
      // A fix that doesn't apply (the text isn't '&' or '|'): only the "Turn off".
      Object.assign(new stub.Diagnostic(range, "operator"), { source: "OtterScript", code: "invalid-operator" }),
    ];
    assert.deepEqual(
      quickFixes.provideCodeActions(doc, undefined, { diagnostics }).map((/** @type {any} */ a) => a.title),
      ["Turn off 'invalid-operator' diagnostics in user settings"]
    );
  });
});

describe("Fix All", () => {
  afterEach(() => {
    const window = /** @type {any} */ (stub.window);
    window.activeTextEditor = undefined;
    window.showInformationMessage = () => undefined;
  });

  /**
   * Runs the Fix All command on `document` as the active editor.
   *
   * @param {any} document
   * @returns {Promise<{ messages: string[], applied: any[], checked: number }>}
   *   What it said, the edits it applied, and how many times it checked the file
   */
  async function runFixAll(document) {
    const { commands, checked } = registerFixes();
    const window = /** @type {any} */ (stub.window);
    const workspace = /** @type {any} */ (stub.workspace);
    /** @type {string[]} */
    const messages = [];
    /** @type {any[]} */
    const applied = [];
    window.activeTextEditor = { document };
    window.showInformationMessage = (/** @type {string} */ message) => messages.push(message);
    const applyEdit = workspace.applyEdit;
    workspace.applyEdit = async (/** @type {any} */ edit) => applied.push(edit);
    try {
      await commands["otterscript.fixAll"]();
    } finally {
      workspace.applyEdit = applyEdit;
    }
    return { messages, applied, checked: checked() };
  }

  it("applies every preferred fix as one edit, from the end of the file, and re-checks", async () => {
    const doc = makeDoc("if x == 5 {\n}\nif $a & $b {\n}\nLog-Informaton hi;");
    const { messages, applied, checked } = await runFixAll(doc);
    assert.equal(applied.length, 1);
    // The operation name is a guess, left to the lightbulb.
    assert.deepEqual(describeEdits(applied[0]), ["2:6-7 &&", "0:3-3 $"]);
    assert.deepEqual(messages, [`Fixed 2 issue(s) in ${doc.fileName}`]);
    assert.equal(checked, 2, "before, for fresh ranges, and after");
  });

  it("applies an edit two diagnostics share once, and skips a fix that doesn't apply", () => {
    const doc = makeDoc("if x == 5 {\n}");
    const [missing] = diagnose(doc);
    const operator = Object.assign(new stub.Diagnostic(missing.range, "operator"), { source: "OtterScript", code: "invalid-operator" });
    const { fixAll } = registerFixes(() => [missing, missing, operator]);
    const [action] = fixAll.provideCodeActions(doc, undefined, { diagnostics: [], only: stub.CodeActionKind.SourceFixAll });
    assert.deepEqual(describeEdits(action.edit), ["0:3-3 $"]);
  });

  it("says when nothing is fixable, or nothing can be fixed without a guess", async () => {
    const clean = makeDoc("Log-Information hi;");
    assert.deepEqual((await runFixAll(clean)).messages, [`No fixable OtterScript issues found in ${clean.fileName}`]);
    const guess = makeDoc("Log-Informaton hi;");
    const { messages, applied } = await runFixAll(guess);
    assert.deepEqual(messages, [`No issues in ${guess.fileName} can be fixed automatically; see the lightbulb for the remaining fixes`]);
    assert.deepEqual(applied, []);
  });

  it("does nothing without an OtterScript editor", async () => {
    const { commands, checked } = registerFixes();
    await commands["otterscript.fixAll"]();
    /** @type {any} */ (stub.window).activeTextEditor = { document: makeDocument("if x == 5 {\n}", { languageId: "plaintext" }) };
    await commands["otterscript.fixAll"]();
    assert.equal(checked(), 0);
  });

  it("is offered as the source.fixAll action only when that kind is asked for", () => {
    const { fixAll } = registerFixes();
    const doc = makeDoc("if x == 5 {\n}");
    assert.deepEqual(fixAll.provideCodeActions(doc, undefined, { diagnostics: [] }), []);
    assert.deepEqual(fixAll.provideCodeActions(doc, undefined, { diagnostics: [], only: stub.CodeActionKind.QuickFix }), []);
    const [action] = fixAll.provideCodeActions(doc, undefined, { diagnostics: [], only: stub.CodeActionKind.SourceFixAll });
    assert.equal(action.kind.value, "source.fixAll.otterscript");
    assert.deepEqual(describeEdits(action.edit), ["0:3-3 $"]);
    assert.deepEqual(fixAll.provideCodeActions(makeDoc("Log-Informaton hi;"), undefined, { diagnostics: [], only: stub.CodeActionKind.SourceFixAll }), []);
  });
});

describe("turning a diagnostic off", () => {
  /**
   * Runs the command behind "Turn off '<code>'" with the rules already set at
   * the user and workspace levels.
   *
   * @param {unknown} code
   * @param {{ folderOpen?: boolean }} [options]
   * @returns {Promise<any[]>} The settings updates it made: `[key, value, target]`
   */
  async function turnOff(code, { folderOpen = false } = {}) {
    const { commands } = registerFixes();
    const workspace = /** @type {any} */ (stub.workspace);
    /** @type {any[]} */
    const updates = [];
    const getConfiguration = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      inspect: () => ({ globalValue: { "unknown-operation": "warning" }, workspaceValue: { "missing-dollar": "error" } }),
      update: async (/** @type {any[]} */ ...args) => updates.push(args),
    });
    workspace.workspaceFolders = folderOpen ? [{}] : undefined;
    try {
      await commands["otterscript.disableDiagnosticRule"](code);
    } finally {
      workspace.getConfiguration = getConfiguration;
      workspace.workspaceFolders = undefined;
    }
    return updates;
  }

  it("adds the code as off to the user's rules, keeping the others", async () => {
    assert.deepEqual(await turnOff("invalid-operator"), [
      ["diagnostics.rules", { "unknown-operation": "warning", "invalid-operator": "off" }, stub.ConfigurationTarget.Global],
    ]);
  });

  it("writes to the workspace's rules when a folder is open", async () => {
    assert.deepEqual(await turnOff("invalid-operator", { folderOpen: true }), [
      ["diagnostics.rules", { "missing-dollar": "error", "invalid-operator": "off" }, stub.ConfigurationTarget.Workspace],
    ]);
  });

  it("ignores anything but a known code", async () => {
    assert.deepEqual(await turnOff("no-such-code"), []);
    assert.deepEqual(await turnOff(undefined), []);
  });
});

describe("refreshing diagnostics", () => {
  it("re-checks an open OtterScript document, and nothing else", () => {
    const { commands, checked } = registerFixes();
    const doc = makeDoc("if x == 5 {\n}");
    const text = makeDocument("x", { languageId: "plaintext" });
    const disk = useWorkspace({ open: [doc, text] });
    try {
      const refresh = commands["otterscript.refreshDiagnostics"];
      refresh(doc.uri);
      assert.equal(checked(), 1);
      refresh(text.uri);
      refresh(stub.Uri.parse("file:///closed.otter"));
      refresh(undefined);
      assert.equal(checked(), 1);
    } finally {
      disk.restore();
    }
  });
});
