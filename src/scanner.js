// @ts-check
/**
 * @fileoverview Pure, dependency-free text scanning primitives for OtterScript.
 *
 * This module is deliberately **free of any `vscode` import** so it can be unit
 * tested with plain Node (`node:test`) and reused outside the extension host
 * (e.g. a future CLI linter).
 *
 * It owns the single source of truth for how the extension recognizes non-code
 * spans — quoted strings, line comments, block comments, and swim-strings — plus
 * what builds on that scan: the `<% %>` text-template tag masking, the
 * signature-help helpers (active parameter, parameter splitting), the
 * variable-occurrence index behind highlighting and rename, the module-name
 * regexes, and the operation-argument helpers (the argument context at the
 * cursor, module parameter lists).
 * Everything here operates on plain strings, numbers, and plain state objects
 * ({@link CodeScanState}, {@link TemplateScanState}); nothing here constructs a
 * `vscode.*` value.
 *
 * Callers import from this module directly; document-index.js wraps its
 * results in `vscode` ranges for open documents.
 *
 * @module scanner
 */

// ============================================================
// SCAN STATE
// ============================================================

/**
 * Carried scanning state for cross-line constructs.
 *
 * A block comment, string, or swim-string opened on one line stays "open" until
 * closed on a later line; callers thread a single {@link CodeScanState} through
 * consecutive lines to track that.
 *
 * @typedef {{
 *   inString: boolean,
 *   quote: string | null,
 *   inBlockComment: boolean,
 *   swimDelimiter: string | null
 * }} CodeScanState
 */

/**
 * Creates a fresh code-scan state object.
 *
 * @returns {CodeScanState}
 */
function createCodeScanState() {
  return {
    inString: false,
    quote: null,
    inBlockComment: false,
    swimDelimiter: null,
  };
}

// ============================================================
// LOW-LEVEL PRIMITIVES
// ============================================================

/**
 * Returns true when a quote at the given index is not escaped.
 *
 * Counts the run of preceding backslashes: an even count (including zero) means
 * the quote itself is not escaped.
 *
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isUnescapedQuoteAt(text, index) {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashCount++;
  }
  return backslashCount % 2 === 0;
}

/**
 * From `openParenIndex` (the index of the `(` itself), finds the index of its
 * matching `)` on the SAME line, skipping over quoted-string content (so a `)`
 * inside a string doesn't end the call early) and tracking nested parens (so a
 * map/vector literal argument works). Returns -1 when unclosed on this line.
 *
 * @param {string} line
 * @param {number} openParenIndex
 * @returns {number}
 */
function findBalancedParenEnd(line, openParenIndex) {
  let depth = 1;
  /** @type {string | null} */
  let quote = null;
  for (let i = openParenIndex + 1; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && isUnescapedQuoteAt(line, i)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * From `dollarIndex` (the index of a `$` found in literal template text),
 * determines whether it starts an embedded OtterScript value expression --
 * `$(expression)`, `$Name(args)`, or a bare `$Name` / `$Name.Prop.Chain`
 * variable reference -- and returns the index just past its end. Returns -1
 * when the `$` isn't followed by anything that looks like one (e.g. a literal
 * `$` in prose or a price like "$5.00"), so it's just literal text.
 *
 * Single-line only, matching {@link findBalancedParenEnd}: a call whose `)`
 * isn't found on this line is treated as not an embedded expression here (it
 * stays blanked, same as plain literal text, rather than risk misreading the
 * rest of the line).
 *
 * @param {string} line
 * @param {number} dollarIndex
 * @returns {number}
 */
function findEmbeddedExpressionEnd(line, dollarIndex) {
  const next = line[dollarIndex + 1];

  if (next === "(") {
    const close = findBalancedParenEnd(line, dollarIndex + 1);
    return close === -1 ? -1 : close + 1;
  }

  if (!next || !/[A-Za-z_]/.test(next)) return -1;

  let i = dollarIndex + 2;
  while (i < line.length && /[A-Za-z0-9_]/.test(line[i])) i++;

  if (line[i] === "(") {
    const close = findBalancedParenEnd(line, i);
    return close === -1 ? -1 : close + 1;
  }

  while (line[i] === "." && line[i + 1] && /[A-Za-z_]/.test(line[i + 1])) {
    i++;
    while (i < line.length && /[A-Za-z0-9_]/.test(line[i])) i++;
  }

  return i;
}

// ============================================================
// MODULE-NAME REGEXES
// ============================================================
// Pure regexes describing `module <Name>` declarations and `call [Raft::]<Name>`
// targets. They live here (next to the scanner) because module discovery runs on
// scanner-masked text and the context predicates below consume them.

/**
 * Token regex for module names used by word-range lookups.
 *
 * @readonly
 * @type {RegExp}
 */
const MODULE_NAME_TOKEN_REGEX = /[A-Za-z][\w-]*/;

/** Matches a `module <Name>` declaration at line start and captures the name. */
const MODULE_DECLARATION_REGEX = /^\s*module\s+([A-Za-z][\w-]*)/;
/** Matches a `call [Raft::]<Name>` target and captures the module name. */
const MODULE_CALL_TARGET_REGEX = /\bcall\s+(?:[A-Za-z][\w-]*::)?([A-Za-z][\w-]*)\b/;
/** Global-flagged sibling of {@link MODULE_CALL_TARGET_REGEX} for `matchAll`. */
const MODULE_CALL_TARGET_GLOBAL_REGEX = new RegExp(MODULE_CALL_TARGET_REGEX.source, "g");
/** Matches the text left of the cursor when about to type a module declaration name. */
const MODULE_DECL_PREFIX_REGEX = /^\s*module\s+$/i;
/** Matches the text left of the cursor when about to type a `call` target name. */
const MODULE_CALL_PREFIX_REGEX = /\bcall\s+(?:[A-Za-z][\w-]*::)?$/i;

/**
 * Returns true when the current word position is in a module declaration context.
 *
 * @param {string} lineText - Full source line text
 * @param {number} wordStart - Start index of the current word
 * @returns {boolean}
 */
function isModuleDeclarationContext(lineText, wordStart) {
  const beforeWord = lineText.slice(0, wordStart);
  return MODULE_DECL_PREFIX_REGEX.test(beforeWord);
}

/**
 * Returns true when the current word position is in a module call context.
 *
 * @param {string} lineText - Full source line text
 * @param {number} wordStart - Start index of the current word
 * @returns {boolean}
 */
function isModuleCallContext(lineText, wordStart) {
  const beforeWord = lineText.slice(0, wordStart);
  return MODULE_CALL_PREFIX_REGEX.test(beforeWord);
}

// ============================================================
// TOP-LEVEL COMMAS OF MANY CALLS AT ONCE
// ============================================================

/**
 * How {@link findTopLevelCommas} counts nesting inside a call:
 * - `openers`, `closers` -- the brackets that nest (`"([{"` and `")]}"`)
 * - `clamp` -- whether a closer with nothing open leaves the depth at 0
 *   (true), or takes it below 0, where no comma is top-level any more (false)
 *
 * @typedef {{ openers: string, closers: string, clamp: boolean }} NestingRule
 */

/**
 * The top-level commas of a call: those at depth 0 counted by a
 * {@link NestingRule} from just after its `(`, and whether the depth is
 * back at 0 at its `)`.
 *
 * @typedef {{ close: number, commas: number[], closesAtTop: boolean }} TopLevelCommas
 */

/**
 * For each `(` in `opens`, its matching `)` (counting parentheses only) and
 * its top-level commas, in text masked by {@link maskNonCodeSpans}: the same
 * result as walking from each `(` to its `)` and counting depth by `rule`,
 * but in one pass over the text. Walking each call on its own made nested or
 * unclosed calls quadratic: every call rescanned its inner calls, and an
 * unclosed one the rest of the document (100 KB took seconds).
 *
 * The one pass works on depth counted from the start of the text. A comma
 * is top-level for a call when the depth there is where it was at the call's
 * start (`clamp: false`), or, when clamped, when the depth never went lower
 * in between: when the last position with a lower depth is before the call.
 *
 * A comma can be top-level for many calls at once only in malformed text
 * (`%( %( ] ] , ...`), where the result can grow with the square of the
 * text. Past a limit linear in the text's length, this gives up and
 * returns null, so the caller skips its check.
 *
 * @param {string} maskedText
 * @param {number[]} opens - Indexes of `(`, ascending
 * @param {NestingRule} rule
 * @returns {Map<number, TopLevelCommas> | null} Keyed by the `(`'s index;
 *   a `(` without a matching `)` has no entry. Null past the limit.
 */
function findTopLevelCommas(maskedText, opens, rule) {
  /** @type {Map<number, TopLevelCommas>} */
  const result = new Map();
  // No requested opens means no entries, so skip the document-wide scans and
  // typed-array allocations that would only return the empty map.
  if (!opens.length) return result;

  const n = maskedText.length;

  // Every `(`'s matching `)`, from one stack of parentheses.
  const closeOf = new Int32Array(n).fill(-1);
  /** @type {number[]} */
  const parens = [];
  for (let i = 0; i < n; i++) {
    if (maskedText[i] === "(") parens.push(i);
    else if (maskedText[i] === ")" && parens.length) closeOf[/** @type {number} */ (parens.pop())] = i;
  }

  // depth[i]: the nesting depth before maskedText[i], from the text's start.
  const depth = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ch = maskedText[i];
    depth[i + 1] = depth[i] + (rule.openers.includes(ch) ? 1 : rule.closers.includes(ch) ? -1 : 0);
  }

  // Clamped: lowerBefore[i] is the last position before i with a lower
  // depth, or -1 (a stack of positions of rising depth).
  const lowerBefore = new Int32Array(n + 1);
  if (rule.clamp) {
    /** @type {number[]} */
    const rising = [];
    for (let i = 0; i <= n; i++) {
      while (rising.length && depth[rising[rising.length - 1]] >= depth[i]) rising.pop();
      lowerBefore[i] = rising.length ? rising[rising.length - 1] : -1;
      rising.push(i);
    }
  }
  /**
   * Whether position `i`, inside the call whose `(` is at `open`, is at the
   * call's top level.
   *
   * @param {number} open
   * @param {number} i
   * @returns {boolean}
   */
  const atTopLevel = (open, i) => (rule.clamp ? lowerBefore[i] < open + 1 : depth[i] === depth[open + 1]);

  const isOpen = new Uint8Array(n);
  for (const open of opens) if (closeOf[open] !== -1) isOpen[open] = 1;

  // The calls open at the current position, innermost last; unclamped, also
  // by their starting depth, as a comma counts for exactly those.
  /** @type {number[]} */
  const active = [];
  /** @type {Map<number, number[]>} */
  const activeByDepth = new Map();
  let budget = 4 * n + 10000;
  for (let i = 0; i < n; i++) {
    const ch = maskedText[i];
    if (active.length && closeOf[active[active.length - 1]] === i) {
      const open = /** @type {number} */ (active.pop());
      /** @type {TopLevelCommas} */ (result.get(open)).closesAtTop = atTopLevel(open, i);
      if (!rule.clamp) activeByDepth.get(depth[open + 1])?.pop();
    } else if (ch === ",") {
      if (rule.clamp) {
        // The calls whose start is after the last lower depth: a run at the top.
        for (let k = active.length - 1; k >= 0 && atTopLevel(active[k], i); k--) {
          /** @type {TopLevelCommas} */ (result.get(active[k])).commas.push(i);
          if (--budget < 0) return null;
        }
      } else {
        for (const open of activeByDepth.get(depth[i]) ?? []) {
          /** @type {TopLevelCommas} */ (result.get(open)).commas.push(i);
          if (--budget < 0) return null;
        }
      }
    } else if (isOpen[i]) {
      active.push(i);
      result.set(i, { close: closeOf[i], commas: [], closesAtTop: false });
      if (!rule.clamp) {
        const key = depth[i + 1];
        const list = activeByDepth.get(key);
        if (list) list.push(i);
        else activeByDepth.set(key, [i]);
      }
    }
  }
  return result;
}

// ============================================================
// LOOKING BACK FROM A WORD
// ============================================================
// These walk back from an index instead of matching a `...$` regex against
// the text before it: such a regex is tried at every position of that text,
// so a check run for each word of a line made a long line quadratic (a
// 100 KB line took seconds).

/**
 * The namespace written right before `end` (`DotNet` for `DotNet::Build`
 * with `end` at `B`), or undefined. Same result as matching
 * `/([A-Za-z][A-Za-z0-9]*)::$/` against `text.slice(0, end)`.
 *
 * @param {string} text
 * @param {number} end - Index right after the `::`
 * @returns {string | undefined}
 */
function namespaceBefore(text, end) {
  if (end < 2 || text[end - 1] !== ":" || text[end - 2] !== ":") return undefined;
  const nameEnd = end - 2;
  let start = nameEnd;
  while (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) start--;
  // A name starts with a letter, so leading digits aren't part of it.
  while (start < nameEnd && !/[A-Za-z]/.test(text[start])) start++;
  return start < nameEnd ? text.slice(start, nameEnd) : undefined;
}

/**
 * Whether a statement can start at `end`: only whitespace separates it from
 * the start of `text`, a `;`, a block's closing `}`, or a block's opening `{`
 * — not the braces of a braced variable such as `${my-var}`, whose `{` is
 * preceded by a `$`, `@`, or `%` sigil and whose `}` closes back to it.
 *
 * @param {string} text
 * @param {number} end
 * @returns {boolean}
 */
function isStatementStart(text, end) {
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (end === 0) return true;
  const last = text[end - 1];
  if (last === ";") return true;
  if (last === "}") return !closesBracedVariable(text, end - 1);
  return last === "{" && (end < 2 || !/[$@%]/.test(text[end - 2]));
}

/** A character a braced variable's name may contain (see BRACED_NAME_PATTERN). */
const BRACED_NAME_CHAR_REGEX = /[A-Za-z0-9_ -]/;

/**
 * Whether the `}` at `index` closes a braced variable (`${x}`, `@{x}`,
 * `%{x}`) rather than a block: only name characters lie between it and a
 * `{` right after a sigil. Looking back over the name alone, not to the
 * matching `{` of a block, keeps a line full of `}` linear.
 *
 * @param {string} text
 * @param {number} index - Index of the `}`
 * @returns {boolean}
 */
function closesBracedVariable(text, index) {
  let i = index - 1;
  while (i >= 0 && BRACED_NAME_CHAR_REGEX.test(text[i])) i--;
  return i > 0 && text[i] === "{" && /[$@%]/.test(text[i - 1]) && /[A-Za-z]/.test(text[i + 1]);
}

// ============================================================
// EXECUTION DIRECTIVES AND AWAIT
// ============================================================

/**
 * One directive in a `with` header: `retry=3` or `isolation`. Offsets into
 * the text {@link findExecutionDirectives} was given.
 *
 * @typedef {{ name: string, nameStart: number, value: string | undefined, valueStart: number, valueEnd: number }} ExecutionDirective
 *   `value`: what follows the `=`, trimmed, from the unmasked text (a
 *   quoted string keeps its quotes); undefined without an `=`.
 *   `valueStart`/`valueEnd`: where it is (equal when it's empty or missing).
 */

/**
 * A `with ... {` block's header.
 *
 * @typedef {{ start: number, headerEnd: number, directives: ExecutionDirective[] }} WithHeader
 *   `start`: the `with`; `headerEnd`: its `{`.
 */

/**
 * An `await` statement, with the token it waits for, if any.
 *
 * @typedef {{ start: number, token: string | undefined, tokenStart: number }} AwaitStatement
 */

/** A directive in a `with` header: its name, then an optional `=` and value. */
const EXECUTION_DIRECTIVE_REGEX = /^(\s*)([A-Za-z][\w-]*)\s*(?:=(.*))?$/s;

/**
 * A comment-masked view of possibly multi-line text, offsets preserved:
 * comments are blanked, strings kept whole (so a `#` or `//` inside a string
 * survives). Used to drop a trailing comment from a directive's raw value
 * before trimming, without masking a `#` that is part of a string value.
 *
 * @param {string} text
 * @returns {string}
 */
function maskCommentsAcrossLines(text) {
  const state = createCodeScanState();
  return text.split("\n").map((line) => maskComments(line, state)).join("\n");
}

/**
 * Every `with` block header and `await` statement in `maskedText`: a
 * statement keyword (see {@link isStatementStart}), written in lower case.
 * A `with` whose header reaches a `;` or `}` before its `{` isn't a block,
 * so it is left out. One pass: each header is read once.
 *
 * @param {string} maskedText - Strings and comments blanked, offsets kept
 * @param {string} text - The same text unmasked, for the directives' values
 * @returns {{ withs: WithHeader[], awaits: AwaitStatement[] }}
 */
function findExecutionDirectives(maskedText, text) {
  /** @type {WithHeader[]} */
  const withs = [];
  /** @type {AwaitStatement[]} */
  const awaits = [];
  const keyword = /\b(with|await)\b/g;
  for (let match; (match = keyword.exec(maskedText));) {
    const start = match.index;
    // Not a word inside another (`$with`, `Do-with`) or a statement's text.
    if (/[$@%\w-]/.test(maskedText[start - 1] ?? "") || maskedText[start + match[0].length] === "-") continue;
    if (!isStatementStart(maskedText, start)) continue;
    const after = start + match[0].length;

    if (match[1] === "await") {
      const tail = /^\s*([A-Za-z][A-Za-z0-9]*)?\s*;/.exec(maskedText.slice(after, after + 200));
      if (!tail) continue;
      const token = tail[1];
      awaits.push({ start, token, tokenStart: token ? after + tail[0].indexOf(token) : after });
      continue;
    }

    let headerEnd = after;
    // A `${name}` value's `{` isn't the block opener, so step over its span.
    while (headerEnd < maskedText.length && !"{;}".includes(maskedText[headerEnd])) {
      if (maskedText[headerEnd] === "$" && maskedText[headerEnd + 1] === "{") {
        const close = maskedText.indexOf("}", headerEnd + 2);
        if (close === -1) break;
        headerEnd = close + 1;
      } else headerEnd++;
    }
    keyword.lastIndex = headerEnd;
    if (maskedText[headerEnd] !== "{") continue;

    /** @type {ExecutionDirective[]} */
    const directives = [];
    // The directives are separated by commas; a comma in a string is masked.
    let segmentStart = after;
    for (const segment of maskedText.slice(after, headerEnd).split(",")) {
      const segmentEnd = segmentStart + segment.length;
      const directive = EXECUTION_DIRECTIVE_REGEX.exec(segment);
      if (directive) {
        const nameStart = segmentStart + directive[1].length;
        const name = directive[2];
        if (directive[3] === undefined) {
          const end = nameStart + name.length;
          directives.push({ name, nameStart, value: undefined, valueStart: end, valueEnd: end });
        } else {
          const raw = text.slice(segmentEnd - directive[3].length, segmentEnd);
          // The raw value can carry a trailing comment from a multi-line
          // header (`retry=3 # note\n{`); blank comments but keep strings,
          // so a `#` or `//` inside a string stays, before trimming.
          const bare = maskCommentsAcrossLines(raw);
          const trimmedStart = bare.length - bare.trimStart().length;
          const trimmedEnd = bare.trimEnd().length;
          const valueStart = segmentEnd - directive[3].length + trimmedStart;
          const value = raw.slice(trimmedStart, trimmedEnd);
          directives.push({ name, nameStart, value, valueStart, valueEnd: valueStart + value.length });
        }
      }
      segmentStart = segmentEnd + 1;
    }
    withs.push({ start, headerEnd, directives });
  }
  return { withs, awaits };
}

// ============================================================
// CORE LINE SCANNER
// ============================================================

/**
 * What {@link stepCodeScan} found at a position:
 * - `code` -- one character of real code
 * - `stringDelimiter` -- a quote, or a swim-string's opening/closing fish
 * - `stringContent` -- one character inside a quoted string or swim-string
 * - `blockComment` -- part of a `/* ... *\/` comment, delimiters included
 * - `lineComment` -- a `#` or `//` comment running to the end of the line
 *
 * @typedef {"code" | "stringDelimiter" | "stringContent" | "blockComment" | "lineComment"} ScanKind
 */

/**
 * The one OtterScript string/comment state machine, one step at a time.
 * Classifies whatever starts at `line[i]`, advances `state` past it, and
 * returns where the next step starts. Every scanner in this module
 * ({@link scanLineState}, {@link isInStringOrComment}, and the inside-tag
 * parts of {@link maskOutsideTemplateTags} / {@link maskTemplateTagContents})
 * is a loop over this, so they cannot disagree on what is a string or comment.
 *
 * Recognized: `"..."` and `'...'` strings (backslash-escaped quotes), swim
 * strings (`>>...>>`, `>END>...>END>`: `>`, up to 5 non-`>` chars, `>`, with
 * the body running until the same fish appears again, possibly lines later),
 * `/* *\/` block comments, and `#` / `//` line comments.
 *
 * @param {string} line
 * @param {number} i - Position to classify
 * @param {CodeScanState} state - Mutated in place.
 * @returns {{ kind: ScanKind, next: number }} `next` is the index just past
 *   the classified piece (`line.length` for a line comment).
 */
function stepCodeScan(line, i, state) {
  const ch = line[i];

  if (state.inBlockComment) {
    if (ch === "*" && line[i + 1] === "/") {
      state.inBlockComment = false;
      return { kind: "blockComment", next: i + 2 };
    }
    return { kind: "blockComment", next: i + 1 };
  }

  if (state.swimDelimiter) {
    if (line.startsWith(state.swimDelimiter, i)) {
      const next = i + state.swimDelimiter.length;
      state.swimDelimiter = null;
      return { kind: "stringDelimiter", next };
    }
    return { kind: "stringContent", next: i + 1 };
  }

  if (state.inString) {
    if (ch === state.quote && isUnescapedQuoteAt(line, i)) {
      state.inString = false;
      state.quote = null;
      return { kind: "stringDelimiter", next: i + 1 };
    }
    return { kind: "stringContent", next: i + 1 };
  }

  if (ch === "/" && line[i + 1] === "*") {
    state.inBlockComment = true;
    return { kind: "blockComment", next: i + 2 };
  }

  if (ch === ">") {
    const swimMatch = /^>[^>]{0,5}>/.exec(line.slice(i, i + 7));
    if (swimMatch) {
      state.swimDelimiter = swimMatch[0];
      return { kind: "stringDelimiter", next: i + swimMatch[0].length };
    }
  }

  if (ch === '"' || ch === "'") {
    state.inString = true;
    state.quote = ch;
    return { kind: "stringDelimiter", next: i + 1 };
  }

  if (ch === "#" || (ch === "/" && line[i + 1] === "/")) {
    return { kind: "lineComment", next: line.length };
  }

  return { kind: "code", next: i + 1 };
}

/**
 * Which kinds of span ({@link ScanKind}) each mask keeps; every other
 * character is blanked:
 * - `code` -- only code ({@link maskNonCodeSpans})
 * - `stringContent` -- code and what's inside strings, their delimiters
 *   blanked ({@link maskCommentSpans})
 * - `strings` -- code and whole strings, delimiters included ({@link maskComments})
 * @type {Readonly<Record<"code" | "stringContent" | "strings", ReadonlySet<ScanKind>>>}
 */
const KEPT_KINDS = Object.freeze({
  code: new Set(/** @type {ScanKind[]} */ (["code"])),
  stringContent: new Set(/** @type {ScanKind[]} */ (["code", "stringContent"])),
  strings: new Set(/** @type {ScanKind[]} */ (["code", "stringContent", "stringDelimiter"])),
});

/**
 * Core line scanner shared by every mask in this module and {@link advanceScanState}.
 *
 * Advances `state` by processing every character of `lineText`.  When `chars`
 * is non-null it is treated as a split-string output buffer: every character
 * of a span `keep` doesn't list is replaced with a space in that buffer.
 *
 * Exported (rather than kept file-private) so unit tests can exercise the
 * character-classification logic directly.
 *
 * @param {string} lineText
 * @param {CodeScanState} state - Mutated in place.
 * @param {string[] | null} chars - Output buffer, or null for state-only mode.
 * @param {keyof typeof KEPT_KINDS} [keep] - What stays unmasked (default:
 *   code only)
 * @returns {void}
 * @internal
 */
function scanLineState(lineText, state, chars, keep = "code") {
  const kept = KEPT_KINDS[keep];
  let i = 0;
  while (i < lineText.length) {
    const { kind, next } = stepCodeScan(lineText, i, state);
    if (chars && !kept.has(kind)) {
      for (let j = i; j < next && j < chars.length; j++) chars[j] = " ";
    }
    i = next;
  }
}

/**
 * Produces a length-preserving mask of non-code spans.
 *
 * Masked spans include strings, line comments, block comments, and swim-strings.
 * State is carried across lines for block comments, strings, and swim-strings.
 *
 * @param {string} lineText
 * @param {CodeScanState} state
 * @returns {string}
 */
function maskNonCodeSpans(lineText, state) {
  const chars = lineText.split("");
  scanLineState(lineText, state, chars);
  return chars.join("");
}

/**
 * A length-preserving mask of comments only: strings stay whole, their quotes
 * included. Unlike {@link maskCommentSpans}, which blanks string delimiters,
 * this keeps every non-comment character, so a caller can find where the
 * last argument of a call really ends (the add-missing-argument fix inserts
 * after a trailing string argument, not inside it).
 *
 * @param {string} lineText
 * @param {CodeScanState} state - Mutated in place.
 * @returns {string}
 */
function maskComments(lineText, state) {
  const chars = lineText.split("");
  scanLineState(lineText, state, chars, "strings");
  return chars.join("");
}

/**
 * Advances a {@link CodeScanState} by processing one line of text without
 * producing any output string.
 *
 * This is the state-only sibling of {@link maskNonCodeSpans}.  Use it when
 * you need to accumulate cross-line comment/string state for lines whose
 * masked text is not required.  Avoids the `split`/`join` allocation that
 * `maskNonCodeSpans` performs on every line.
 *
 * @param {string} lineText
 * @param {CodeScanState} state - Mutated in place.
 * @returns {void}
 */
function advanceScanState(lineText, state) {
  scanLineState(lineText, state, null);
}

// ============================================================
// TEXT-TEMPLATE TAGS  (<% ... %>)
// ============================================================
// OtterScript text templates (ProGet / BuildMaster / Otter notification bodies,
// `Apply-Template` literals) are literal output text with `<% ... %>` code
// blocks. Everything OUTSIDE a tag is not OtterScript; only the tag bodies are.
// These helpers let the diagnostics engine see just the code.

/**
 * Carried state for {@link maskOutsideTemplateTags}:
 * - `inTemplateTag` — is the scan currently between a `<%` and its `%>`
 * - `code` — the {@link CodeScanState} for the OtterScript *inside* a tag, so a
 *   `%>` that sits in a tag-body string / comment / swim-string (possibly opened
 *   on an earlier line of a multi-line tag) does not close the tag early.
 *
 * Kept separate from a bare {@link CodeScanState} on purpose — the outer pass
 * runs before, and independently of, {@link maskNonCodeSpans}, and every
 * non-template scan (the common case) would otherwise carry these fields.
 *
 * @typedef {{ inTemplateTag: boolean, code: CodeScanState }} TemplateScanState
 */

/**
 * Creates a fresh template-scan state object.
 *
 * @returns {TemplateScanState}
 */
function createTemplateScanState() {
  return { inTemplateTag: false, code: createCodeScanState() };
}

/**
 * Whether a `%>` at `line[i]` closes the current template tag: only when the
 * tag's code is not inside a string, block comment or swim-string (a line
 * comment never gets here -- the scan stops at it).
 *
 * @param {string} line
 * @param {number} i
 * @param {CodeScanState} code - The inside-tag scan state
 * @returns {boolean}
 */
function isTemplateTagClose(line, i, code) {
  return line[i] === "%" && line[i + 1] === ">" &&
    !code.inString && !code.inBlockComment && !code.swimDelimiter;
}

/**
 * Blanks every character that is NOT inside a `<% ... %>` template tag AND NOT
 * part of an embedded `$` value expression in the literal text (see
 * {@link findEmbeddedExpressionEnd}), length-preserving, so downstream code
 * diagnostics see the real OtterScript between tags, the real OtterScript
 * embedded directly in literal output (`$ToJson(...)`, `$PackageName`, ...),
 * and nothing else. The `<%` / `%>` delimiters are blanked too.
 *
 * Runs on the RAW line, before {@link maskNonCodeSpans}: outside a tag there is
 * mostly no OtterScript, so only quoted spans (a `<%` inside a string literal
 * is not a tag opener) and embedded `$` expressions are tracked; inside a tag
 * the body IS OtterScript, so `%>` closes the tag only when it is real code —
 * a `%>` in a tag-body string, line comment, block comment, or swim-string is
 * ignored, mirroring {@link scanLineState}. Callers gate this on
 * {@link documentUsesTemplateTags} so a `.otter` file with no tags is never
 * affected.
 *
 * @param {string} line
 * @param {TemplateScanState} state - Mutated in place; carries `inTemplateTag`
 *   and the inside-tag {@link CodeScanState} across lines.
 * @returns {string}
 */
function maskOutsideTemplateTags(line, state) {
  const chars = line.split("");
  const code = state.code;
  /** @type {string | null} open quote char in the literal text (line-local) */
  let litQuote = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    // ---- Outside a tag: blank everything except strings and embedded `$`
    // value expressions, which are tracked/kept respectively -------------------
    if (!state.inTemplateTag) {
      if (litQuote) {
        chars[i] = " ";
        if (ch === litQuote && isUnescapedQuoteAt(line, i)) litQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        chars[i] = " ";
        litQuote = ch;
        continue;
      }
      if (ch === "<" && line[i + 1] === "%") {
        chars[i] = " ";
        chars[i + 1] = " ";
        state.inTemplateTag = true;
        i++;
        continue;
      }
      if (ch === "$") {
        const end = findEmbeddedExpressionEnd(line, i);
        if (end !== -1) {
          i = end - 1; // keep chars[i..end) as-is; outer loop's i++ lands at `end`
          continue;
        }
      }
      chars[i] = " ";
      continue;
    }

    // ---- Inside a tag: keep the code; `%>` closes only when it is real code --
    // A tag never closes mid string/comment/swim, so on the next `<%` `code` is
    // already clean; no reset needed.
    if (isTemplateTagClose(line, i, code)) {
      chars[i] = " ";
      chars[i + 1] = " ";
      state.inTemplateTag = false;
      i++;
      continue;
    }
    const { kind, next } = stepCodeScan(line, i, code);
    if (kind === "lineComment") break; // nothing after it can close the tag
    i = next - 1; // the loop's i++ lands on `next`
  }

  return chars.join("");
}

/**
 * The inverse of {@link maskOutsideTemplateTags}: blanks everything INSIDE a
 * `<% ... %>` template tag, length-preserving, and leaves the literal output
 * text completely untouched (not even embedded `$` expressions are blanked —
 * callers that need those gone too should mask separately). For a caller
 * that wants to see the literal text as-is (e.g. treating it as JSON), this
 * is what removes the OtterScript control-flow noise (`<% foreach ... %>`,
 * `<% } %>`, ...) without disturbing anything else.
 *
 * Uses the same tag-boundary detection as {@link maskOutsideTemplateTags}
 * (a `<%` inside a literal-text string is not a real opener; a `%>` inside a
 * tag-body string/comment/swim-string does not close the tag early), so the
 * two functions agree on exactly where tags start and end.
 *
 * @param {string} line
 * @param {TemplateScanState} state - Mutated in place; carries `inTemplateTag`
 *   and the inside-tag {@link CodeScanState} across lines. Use a SEPARATE
 *   state object from any {@link maskOutsideTemplateTags} pass over the same
 *   lines -- each function's state must only ever see its own calls.
 * @returns {string}
 */
function maskTemplateTagContents(line, state) {
  const chars = line.split("");
  const code = state.code;
  /** @type {string | null} open quote char in the literal text (line-local) */
  let litQuote = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    // ---- Outside a tag: keep the literal text as-is; only track strings
    // (so a '<%' inside one isn't mistaken for a real tag opener) and the
    // tag opener itself, which IS blanked. ----------------------------------
    if (!state.inTemplateTag) {
      if (litQuote) {
        if (ch === litQuote && isUnescapedQuoteAt(line, i)) litQuote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        litQuote = ch;
        continue;
      }
      if (ch === "<" && line[i + 1] === "%") {
        chars[i] = " ";
        chars[i + 1] = " ";
        state.inTemplateTag = true;
        i++;
      }
      continue;
    }

    // ---- Inside a tag: blank everything; `%>` closes only when it is real
    // code, using the same rule as maskOutsideTemplateTags. -----------------
    if (isTemplateTagClose(line, i, code)) {
      chars[i] = " ";
      chars[i + 1] = " ";
      state.inTemplateTag = false;
      i++;
      continue;
    }
    const { next } = stepCodeScan(line, i, code);
    for (let k = i; k < next && k < line.length; k++) chars[k] = " ";
    i = next - 1; // the loop's i++ lands on `next`
  }

  return chars.join("");
}

/**
 * Finds `<%` / `%>` template-tag delimiters in one already-masked line, in
 * source order. The single place the "what is a tag delimiter" rule lives, so
 * folding and diagnostics cannot drift on it.
 *
 * @param {string} maskedLine - Output of {@link maskNonCodeSpans} for one line
 *   (so a `<%` inside a string or comment is already gone)
 * @returns {{ index: number, open: boolean }[]}
 */
function findTemplateTagDelimiters(maskedLine) {
  /** @type {{ index: number, open: boolean }[]} */
  const out = [];
  for (let i = 0; i < maskedLine.length - 1; i++) {
    if (maskedLine[i] === "<" && maskedLine[i + 1] === "%") {
      out.push({ index: i, open: true });
      i++;
    } else if (maskedLine[i] === "%" && maskedLine[i + 1] === ">") {
      out.push({ index: i, open: false });
      i++;
    }
  }
  return out;
}

/**
 * True when `text` uses OtterScript text templating: after {@link maskNonCodeSpans}
 * (so a `<%` inside a string, `#` / `//` line comment, block comment, or
 * swim-string does not count) it contains a `<%` with a later `%>`. Cheap; the
 * diagnostics engine calls it once per pass to decide whether to run
 * {@link maskOutsideTemplateTags} and the template-specific checks.
 *
 * KNOWN LIMITATION: `maskNonCodeSpans` applies OtterScript comment rules
 * everywhere, but in a text template the content outside `<% %>` is literal
 * output (JSON, Markdown, ...), where `#` / `//` are not comments. So a `<%`
 * that appears *after* an unquoted `#` or `//` on the same line is masked away
 * here, and if every `<% %>` pair in the file is hidden that way the document
 * is never treated as template-aware. This trade-off is deliberate: it keeps a
 * plain `.otter` file whose *comment* shows a `<% ... %>` example (or a
 * commented-out template line) from being misdetected as a template and having
 * its real code blanked. Realistic templates put tags on their own line or
 * after JSON/text with no bare `#` / `//`, so this rarely bites.
 *
 * @param {string} text - Full document text
 * @returns {boolean}
 */
function documentUsesTemplateTags(text) {
  const state = createCodeScanState();
  let sawOpen = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const masked = maskNonCodeSpans(rawLine, state);
    if (sawOpen) {
      if (masked.includes("%>")) return true;
      continue;
    }
    const open = masked.indexOf("<%");
    if (open === -1) continue;
    sawOpen = true;
    if (masked.indexOf("%>", open + 2) !== -1) return true;
  }
  return false;
}

/**
 * @typedef {{ name: string, line: number, character: number }} ModuleDeclarationHit
 *   `line` and `character` are 0-based; `character` is the column where the
 *   module name starts.
 */

/**
 * Finds every `module <Name>` declaration in a whole source string, ignoring
 * matches inside strings, comments, and swim-strings. At most one declaration is
 * reported per line (the grammar allows only one). Line endings may be LF or
 * CRLF -- suitable for scanning raw file contents read from disk.
 *
 * The single declaration scan: `document-index.getModuleInfo` wraps these hits in
 * `vscode` ranges for an open document, and the workspace-symbol index uses
 * them directly on raw file text read from disk.
 *
 * @param {string} text - Full document / file text
 * @returns {ModuleDeclarationHit[]}
 */
function findModuleDeclarations(text) {
  const state = createCodeScanState();
  /** @type {ModuleDeclarationHit[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);

  for (let line = 0; line < lines.length; line++) {
    const masked = maskNonCodeSpans(lines[line], state);
    const match = MODULE_DECLARATION_REGEX.exec(masked);
    if (match) {
      const name = match[1];
      const character = masked.indexOf(name, match.index);
      hits.push({ name, line, character });
    }
  }

  return hits;
}

// ============================================================
// STRING & COMMENT DETECTION
// ============================================================

/**
 * Returns true if the given position is inside non-code text on the line.
 *
 * This includes quoted strings, line comments, block comments, and
 * swim-string spans that are detectable from the current line prefix.
 *
 * **Cross-line accuracy:** For block comments and swim-strings that span
 * multiple lines, pass a `CodeScanState` pre-seeded by scanning all preceding
 * lines via {@link maskNonCodeSpans} or {@link advanceScanState}.  Without it,
 * this function only detects spans that opened on the same line as `position`.
 *
 * @param {string} line - The full line of text
 * @param {number} position - Character position within the line (0-indexed)
 * @param {CodeScanState} [initialState] - Optional scan state carried in from
 *   previous lines.  A shallow copy is taken so the caller's object is not
 *   mutated.  Defaults to a fresh state when omitted.
 * @returns {boolean} true if position is inside string/comment, false otherwise
 * @example
 * isInStringOrComment('if $x == 5', 5);        // false (code)
 * isInStringOrComment('# comment', 2);        // true (comment)
 * isInStringOrComment('"hello"', 3);          // true (inside string)
 *
 */
function isInStringOrComment(line, position, initialState) {
  const limit = Math.max(0, Math.min(position, line.length));
  // Shallow-copy so callers that pass a carried state are not mutated.
  const scanState = initialState ? { ...initialState } : createCodeScanState();

  let i = 0;
  while (i < limit) {
    const { kind, next } = stepCodeScan(line, i, scanState);
    if (kind === "lineComment") return true; // the comment starts before `position`
    i = next;
  }

  return scanState.inString || scanState.inBlockComment || scanState.swimDelimiter !== null;
}

// ============================================================
// ARGUMENT HELPERS
// ============================================================

/**
 * Prepares the code before the cursor for signature-help matching: blanks
 * every fully closed `( ... )` group, so only the still-open calls keep their
 * parentheses. Length-preserving (blanked chars become spaces; line breaks
 * stay).
 *
 * This is what lets signature help find the call the cursor is really in
 * when an earlier argument contains a nested call -- e.g.
 * `$Substring($Trim($x), ` -- and keeps commas inside those closed groups
 * from shifting the active parameter.
 *
 * @param {string} maskedText - The code before the cursor, with strings and
 *   comments already masked by {@link maskNonCodeSpans} (so a `(` inside a
 *   string, as in `$Substring("a(b", `, doesn't count)
 * @returns {string}
 */
function blankClosedGroups(maskedText) {
  const chars = maskedText.split("");

  /** @type {number[]} indexes of the currently open '(' */
  const open = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "(") {
      open.push(i);
    } else if (chars[i] === ")") {
      const start = open.pop();
      if (start === undefined) continue; // stray ')' -- not this helper's concern
      for (let k = start; k <= i; k++) if (chars[k] !== "\n") chars[k] = " ";
    }
  }
  return chars.join("");
}

/**
 * Splits a documented signature's parameter list into its parameters, for
 * signature help: `"$Substring(text, start, (length))"` gives
 * `["text", "start", "(length)"]`. Commas inside nested `()`, `[]` or `{}`
 * don't split. A signature without parentheses, or with an empty list
 * (`"$Now()"`), has no parameters.
 *
 * @param {string} signature
 * @returns {string[]}
 */
function splitSignatureParameters(signature) {
  const match = /\(([\s\S]*)\)/.exec(signature);
  if (!match || match[1].trim() === "") return [];

  const text = match[1];
  /** @type {string[]} */
  const params = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth > 0) depth--; }
    else if (ch === "," && depth === 0) {
      params.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  params.push(text.slice(start).trim());
  return params;
}

/**
 * Counts the active parameter index from a partial argument string.
 *
 * The input should be the text between an opening `(` and the cursor.
 * Commas are only counted at top level (not inside nested (), [], {}, or strings).
 *
 * @param {string} argsText - Partial argument text from opening `(` to cursor
 * @returns {number} Zero-based active parameter index
 */
function getActiveParameterIndex(argsText) {
  let activeParam = 0;
  let inString = false;
  /** @type {string | null} quote char of the open string */
  let quote = null;
  // Separate counters per bracket kind: a comma is top-level only when all are 0.
  let parenDepth = 0;
  let bracketDepth = 0;
  let curlyDepth = 0;

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];

    if ((ch === '"' || ch === "'") && !inString) {
      inString = true;
      quote = ch;
      continue;
    }

    if (inString && ch === quote) {
      if (isUnescapedQuoteAt(argsText, i)) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (inString) continue;

    if (ch === "(") parenDepth++;
    if (ch === ")") parenDepth--;
    if (ch === "[") bracketDepth++;
    if (ch === "]") bracketDepth--;
    if (ch === "{") curlyDepth++;
    if (ch === "}") curlyDepth--;

    if (ch === "," && parenDepth === 0 && bracketDepth === 0 && curlyDepth === 0) {
      activeParam++;
    }
  }

  return activeParam;
}

// ============================================================
// VARIABLE OCCURRENCES
// ============================================================
// Where a `$name` / `@name` / `%name` / `${name}` token is a real variable
// reference. Per Inedo's strings-and-literals docs, variables expand in every
// literal expression -- quoted (single or double) and swim strings included --
// but inside a string only `$name` is recognized on its own: `@` / `%` mid-
// string count only inside the `$( ... )` wrapper. Comments never count, and
// a grave accent (`` ` ``) escapes the sigil. In a text template, the tag code
// and the `$` expressions in the literal output are what count.

/**
 * Length-preserving mask that blanks only comments, keeping string and
 * swim-string contents (where OtterScript expands variables). String and
 * swim-string delimiters are blanked.
 *
 * @param {string} lineText
 * @param {CodeScanState} state - Mutated in place.
 * @returns {string}
 */
function maskCommentSpans(lineText, state) {
  const chars = lineText.split("");
  scanLineState(lineText, state, chars, "stringContent");
  return chars.join("");
}

/**
 * @typedef {{ view: string, code: string }} VariableLineView
 *   `view` is the line with comments (and, in a template, non-expression
 *   literal output) blanked. `code` additionally blanks string contents, so a
 *   non-space char there means that position is code, not inside a string.
 */

/**
 * Builds the {@link VariableLineView} of every line of a plain script.
 *
 * @param {string[]} lines
 * @returns {VariableLineView[]}
 */
function scriptVariableViews(lines) {
  const viewState = createCodeScanState();
  const codeState = createCodeScanState();
  return lines.map((raw) => ({
    view: maskCommentSpans(raw, viewState),
    code: maskNonCodeSpans(raw, codeState),
  }));
}

/**
 * Builds the {@link VariableLineView} of every line of a text template: the
 * tag code, plus every `$` expression in the literal output -- including one
 * inside literal-text quotes, since a template expands `$...` anywhere in its
 * output (e.g. `"title": "$(%p.Name)"`). Those expressions count as code.
 *
 * @param {string[]} lines
 * @returns {VariableLineView[]}
 */
function templateVariableViews(lines) {
  const tagState = createTemplateScanState();
  const literalState = createTemplateScanState();
  const viewState = createCodeScanState();
  const codeState = createCodeScanState();
  return lines.map((raw) => {
    const tagCode = maskOutsideTemplateTags(raw, tagState);
    const view = maskCommentSpans(tagCode, viewState).split("");
    const code = maskNonCodeSpans(tagCode, codeState).split("");
    const literal = maskTemplateTagContents(raw, literalState);
    for (let i = 0; i < literal.length; i++) {
      if (literal[i] !== "$" || literal[i - 1] === "`") continue;
      const end = findEmbeddedExpressionEnd(literal, i);
      if (end === -1) continue;
      for (let k = i; k < end; k++) view[k] = code[k] = raw[k];
      i = end - 1;
    }
    return { view: view.join(""), code: code.join("") };
  });
}

/**
 * Inedo's name rule, as regex source (no anchors, no groups that capture):
 * letters, digits, `-` and `_`, starting with a letter and not ending with
 * `-` or `_`. For variable, module and parameter names.
 */
const NAME_PATTERN = "[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?";
/** An explicit variable name, inside braces (`${my var}`): spaces allowed too. */
const BRACED_NAME_PATTERN = "[A-Za-z][A-Za-z0-9_ -]*";

/**
 * A variable token: a sigil (group 1), then either a plain name (group 2) or
 * an explicit name in braces (group 3) -- `$name` or `${name}`, likewise for
 * `@` / `%`. Per Inedo's formal grammar a name is letters, digits, dashes and
 * underscores, starting with a letter and not ending with a dash or
 * underscore (`$my-var`, but `$a-$b` is `$a`, a dash, then `$b`); an explicit
 * name may also contain spaces (`${my var}`). The char before must not be
 * part of an identifier (so `a$b` and `%>` never match) or the grave-accent
 * escape, and a name directly followed by `(` is a function call, not a
 * variable (the lookahead also stops backtracking into a shorter name, like
 * `$Fo` of `$Foo(` or `$a` of `$a-b(`).
 * @type {RegExp}
 */
const VARIABLE_TOKEN_REGEX = new RegExp(
  String.raw`(?<![A-Za-z0-9_\`$@%])([$@%])(?:(${NAME_PATTERN})(?![A-Za-z0-9_(]|-[A-Za-z0-9])|\{(${BRACED_NAME_PATTERN})\})`,
  "g"
);

/** Text before a token that makes it a `foreach` loop variable. */
const FOREACH_VARIABLE_PREFIX_REGEX = /\bforeach\s+$/i;
/** A module header up to the `<` that opens its parameter list. */
const MODULE_PARAMETER_LIST_OPEN_REGEX = /^\s*module\s+[A-Za-z][\w-]*\s*</i;
/**
 * Text before a token, within a module parameter list, that makes it a
 * parameter name (`<$a`, `, $b`, `in $c`, `out $d`) rather than a default value.
 */
const MODULE_PARAMETER_PREFIX_REGEX = /(?:^|,|\b(?:in|out|ref))\s*$/i;
/** Text before a token that receives an operation's output (`ResponseBody => $body`). */
const OUTPUT_CAPTURE_PREFIX_REGEX = /=>\s*$/;
/** Text after a token that makes it an assignment target (`=` but not `==`). */
const ASSIGNMENT_SUFFIX_REGEX = /^\s*=(?!=)/;

/**
 * How far before the whitespace in front of a token the prefix regexes above
 * look: their longest word (`foreach`) plus the character before it, for `\b`.
 */
const PREFIX_LOOKBACK = 9;

/**
 * The end of `text[start, end)` that the prefix regexes above can see, to
 * test them on instead of all of it: the whitespace before `end` and the
 * {@link PREFIX_LOOKBACK} characters before that. Each regex ends in `\s*$`
 * after a short word or symbol, so it matches the tail exactly when it
 * matches the whole text. When the tail doesn't reach `start`, a `\0` goes in
 * front, so `^` can't match where the tail was cut off. Matching the whole
 * text before every token made a long line quadratic (100 KB took seconds).
 *
 * @param {string} text
 * @param {number} end
 * @param {number} [start]
 * @returns {string}
 */
function prefixTail(text, end, start = 0) {
  let whitespace = end;
  while (whitespace > start && /\s/.test(text[whitespace - 1])) whitespace--;
  const from = Math.max(start, whitespace - PREFIX_LOOKBACK);
  return (from > start ? "\0" : "") + text.slice(from, end);
}

/**
 * Whether the text before `end` makes the token there an assignment target:
 * `set`, optionally `local` or `global`, at a statement start. Bare
 * `$x = ...` and `global $x = ...` aren't statements; `set [local|global]
 * $x = ...` is the only form (see `src/language-data.js`). A backward scan,
 * so any spacing between the words works and a long line stays linear.
 *
 * @param {string} text
 * @param {number} end - Where the token starts
 * @returns {boolean}
 */
function followsSetKeyword(text, end) {
  let i = end;
  const skipWhitespace = () => {
    const from = i;
    while (i > 0 && /\s/.test(text[i - 1])) i--;
    return i < from;
  };
  const word = () => {
    const to = i;
    while (i > 0 && /[A-Za-z]/.test(text[i - 1])) i--;
    return text.slice(i, to).toLowerCase();
  };
  if (!skipWhitespace()) return false;
  let keyword = word();
  if (keyword === "local" || keyword === "global") {
    if (!skipWhitespace()) return false;
    keyword = word();
  }
  if (keyword !== "set") return false;
  skipWhitespace();
  return i === 0 || ";{}".includes(text[i - 1]);
}

/**
 * How an occurrence gives its variable a value: as a module parameter, a
 * `foreach` loop variable, an operation's output (`Name => $x`), or an
 * assignment (`set $x = ...`, `$x = ...`, `global $x = ...`).
 *
 * @typedef {"parameter" | "foreach" | "output" | "assignment"} AssignedBy
 */

/**
 * @typedef {{ line: number, character: number, length: number, write: boolean, assignedBy?: AssignedBy }} VariableOccurrence
 *   `line`/`character` are 0-based and point at the sigil; `length` covers
 *   the whole token (`$name` or `${name}`). `write` is true for a declaration
 *   or assignment target (`set $x = ...`, `$x = ...`, `global $x = ...`,
 *   `foreach %p in ...`, an operation's output capture `Name => $x`, or a
 *   module parameter, whose list may span several lines); `assignedBy` then
 *   says which.
 */

/**
 * The key {@link indexVariableOccurrences} files a variable under: its sigil
 * plus its lower-cased name (OtterScript variable names are treated as
 * case-insensitive; the sigil is part of the identity).
 *
 * @param {string} sigil - `$`, `@`, or `%`
 * @param {string} name - Variable name without its sigil
 * @returns {string}
 */
function variableKey(sigil, name) {
  return sigil + name.toLowerCase();
}

/**
 * Finds every variable reference in a document in one pass, grouped by
 * {@link variableKey}. `$x` and `@x` are different variables; `${x}` is the
 * same variable as `$x` (and `@{x}` as `@x`). The whole document is one
 * scope: modules are not treated separately.
 *
 * @param {string} text - Full document text
 * @returns {Map<string, VariableOccurrence[]>}
 */
function indexVariableOccurrences(text) {
  const lines = text.split(/\r?\n/);
  const views = documentUsesTemplateTags(text) ? templateVariableViews(lines) : scriptVariableViews(lines);

  /** @type {Map<string, VariableOccurrence[]>} */
  const index = new Map();
  let inParameterList = false;
  views.forEach(({ view, code }, line) => {
    // -- The part of this line inside a module's `< ... >` parameter list, if any
    let paramStart = -1;
    let paramEnd = -1;
    const header = inParameterList ? null : MODULE_PARAMETER_LIST_OPEN_REGEX.exec(code);
    if (inParameterList || header) {
      paramStart = header ? header[0].length : 0;
      const close = code.indexOf(">", paramStart);
      paramEnd = close === -1 ? code.length : close;
      inParameterList = close === -1;
    }

    for (const match of view.matchAll(VARIABLE_TOKEN_REGEX)) {
      const tokenSigil = match[1];
      const tokenName = match[2] ?? match[3];
      const character = match.index ?? 0;
      // Only the end of the text before the token (see prefixTail).
      const before = prefixTail(view, character);
      // Inside a string, `@` / `%` are variables only within `$( ... )`.
      const inString = code[character] === " ";
      if (inString && tokenSigil !== "$" && !view.slice(Math.max(0, character - 2), character).endsWith("$(")) continue;

      const after = view.slice(character + match[0].length);
      const isParameter =
        paramStart !== -1 && character >= paramStart && character < paramEnd &&
        MODULE_PARAMETER_PREFIX_REGEX.test(prefixTail(code, character, paramStart));
      /** @type {AssignedBy | undefined} */
      const assignedBy = inString ? undefined
        : isParameter ? "parameter"
          : FOREACH_VARIABLE_PREFIX_REGEX.test(before) ? "foreach"
            : OUTPUT_CAPTURE_PREFIX_REGEX.test(before) ? "output"
              : followsSetKeyword(view, character) && ASSIGNMENT_SUFFIX_REGEX.test(after) ? "assignment"
                : undefined;

      const key = variableKey(tokenSigil, tokenName);
      /** @type {VariableOccurrence} */
      const occurrence = { line, character, length: match[0].length, write: assignedBy !== undefined };
      if (assignedBy) occurrence.assignedBy = assignedBy;
      const existing = index.get(key);
      if (existing) existing.push(occurrence);
      else index.set(key, [occurrence]);
    }
  });
  return index;
}

// ============================================================
// OPERATION ARGUMENTS
// ============================================================

/**
 * Where an argument name may be typed in an operation or module call: right
 * after its `(` or a top-level `,` -- `Copy-Files(To: $x, |`,
 * `Copy-Files(\n\tFr|` or `call Greet(|`.
 *
 * @typedef {{
 *   operation: string,
 *   namespace: string | null,
 *   module: boolean,
 *   typed: string,
 *   used: string[]
 * }} OperationArgumentContext
 *   `operation` / `namespace` name the call (`ProGet::Create-Directory`);
 *   for a `call` (`module` true) they are the module and its raft, if any.
 *   `typed` is the part of the argument name before the cursor; `used` the
 *   names of the arguments the call already gives (`Name:` or `Name =>`),
 *   before it and after it.
 */

/**
 * An argument's name at the start of an argument (group 2, after the
 * whitespace in group 1): `Name:` (not `::`) or an output capture
 * `Name => $variable`.
 */
const ARGUMENT_NAME_REGEX = /^(\s*)([A-Za-z][\w-]*)\s*(?::(?!:)|=>)/;

/**
 * The argument context at the end of `maskedPrefix`, or null when the end
 * isn't at an argument name inside an operation or module call (it's in a
 * value, outside any call, in a function call `$F(`, a literal, ...).
 *
 * @param {string} maskedPrefix - The code before the cursor, masked by
 *   {@link maskNonCodeSpans} (so brackets in strings and comments are gone);
 *   from at least the start of the statement
 * @param {string} [maskedSuffix] - The code after the cursor, masked the same
 *   way, for the arguments given after it (none when left out)
 * @returns {OperationArgumentContext | null}
 */
function findOperationArgumentContext(maskedPrefix, maskedSuffix = "") {
  // A braced variable's `}` (`${my dir}`) isn't a block's.
  const text = maskedPrefix.replace(/[$@%]\{[^{}\n]*\}/g, (m) => "_".repeat(m.length));

  // Back to the call's unclosed `(`, noting the last top-level `,`.
  let depth = 0;
  let argumentStart = -1;
  let open = -1;
  for (let i = text.length - 1; i >= 0 && open === -1; i--) {
    const ch = text[i];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") {
      if (depth > 0) depth--;
      else if (ch === "(") open = i;
      else return null; // inside a vector literal or an index
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) return null; // statement boundary
    else if (depth === 0 && ch === "," && argumentStart === -1) argumentStart = i + 1;
  }
  if (open === -1) return null;

  const typedMatch = /^\s*([A-Za-z][\w-]*)?$/.exec(text.slice(argumentStart === -1 ? open + 1 : argumentStart));
  if (!typedMatch) return null; // in a value

  // The operation or module: a dashed or plain name right before `(`, not a
  // function (`$F(`) or a map or vector literal.
  const before = text.slice(0, open);
  const callee = /(?<![$@%\w:-])(?:([A-Za-z][A-Za-z0-9]*)::)?([A-Za-z][A-Za-z0-9-]*)\s*$/.exec(before);
  if (!callee) return null;
  const module = /\bcall\s+(?:[A-Za-z]\w*::)?[A-Za-z][\w-]*\s*$/i.test(before);

  // Arguments already given: each complete top-level `Name:` segment.
  /** @type {string[]} */
  const used = [];
  let segmentStart = open + 1;
  depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      const name = ARGUMENT_NAME_REGEX.exec(text.slice(segmentStart, i))?.[2];
      if (name) used.push(name);
      segmentStart = i + 1;
    }
  }

  // Arguments given after the cursor: each top-level `Name:` segment up to
  // the call's `)` -- or, while it has none, the end of the statement --
  // past the rest of the name being typed, when the cursor is inside one.
  const after = maskedSuffix.replace(/[$@%]\{[^{}\n]*\}/g, (m) => "_".repeat(m.length));
  let inCurrent = /^\w/.test(after);
  segmentStart = 0;
  depth = 0;
  let end = 0;
  for (; end < after.length; end++) {
    const ch = after[end];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) break;
    else if (depth === 0 && ch === ",") {
      if (!inCurrent) addUsed(after.slice(segmentStart, end));
      inCurrent = false;
      segmentStart = end + 1;
    }
  }
  if (!inCurrent) addUsed(after.slice(segmentStart, end));

  return { operation: callee[2], namespace: callee[1] ?? null, module, typed: typedMatch[1] ?? "", used };

  /** @param {string} segment - One argument, masked */
  function addUsed(segment) {
    const name = ARGUMENT_NAME_REGEX.exec(segment)?.[2];
    if (name) used.push(name);
  }
}

/**
 * One parameter of a `module Name<...>` declaration.
 *
 * @typedef {{ name: string, sigil: string, direction: "in" | "out" | "ref", optional: boolean }} ModuleParameter
 *   `name` without its sigil or braces; `optional` when it has a default
 *   value or is an `out` parameter (the call needn't pass it).
 */

/**
 * The parameters of the module declared at the start of `maskedText` --
 * `module Name<in $path, in $count = 0, out $result>`, possibly over several
 * lines.
 *
 * @param {string} maskedText - From the `module` line on, masked by
 *   {@link maskNonCodeSpans} (so a `>` or `,` in a default string is gone)
 * @returns {ModuleParameter[]}
 */
function parseModuleParameters(maskedText) {
  const header = MODULE_PARAMETER_LIST_OPEN_REGEX.exec(maskedText);
  if (!header) return [];
  // The parameters: split at the top-level commas up to the list's `>`, so a
  // default value's own commas (`in @tags = @($a, $b)`) stay inside it.
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = header[0].length;
  for (let i = start; i <= maskedText.length; i++) {
    const ch = maskedText[i];
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    else if (i === maskedText.length || (depth === 0 && (ch === "," || ch === ">"))) {
      parts.push(maskedText.slice(start, i));
      if (ch !== ",") break;
      start = i + 1;
    }
  }
  /** @type {ModuleParameter[]} */
  const params = [];
  for (const part of parts) {
    const match = /^\s*(?:(in|out|ref)\s+)?([$@%])(?:\{([^}]*)\}|([A-Za-z][\w-]*))\s*(=)?/i.exec(part);
    if (!match) continue;
    const direction = /** @type {"in" | "out" | "ref"} */ ((match[1] ?? "in").toLowerCase());
    params.push({ name: (match[3] ?? match[4]).trim(), sigil: match[2], direction, optional: Boolean(match[5]) || direction === "out" });
  }
  return params;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // -- Scan state
  createCodeScanState,
  createTemplateScanState,

  // -- Primitives
  isUnescapedQuoteAt,
  scanLineState,
  maskNonCodeSpans,
  maskComments,
  advanceScanState,

  // -- Text-template tags
  maskOutsideTemplateTags,
  maskTemplateTagContents,
  documentUsesTemplateTags,
  findTemplateTagDelimiters,
  findBalancedParenEnd,
  findEmbeddedExpressionEnd,

  // -- String & comment detection
  isInStringOrComment,

  // -- Variable occurrences
  maskCommentSpans,
  indexVariableOccurrences,
  variableKey,
  NAME_PATTERN,
  BRACED_NAME_PATTERN,

  // -- Operation arguments
  findOperationArgumentContext,
  ARGUMENT_NAME_REGEX,
  parseModuleParameters,

  // -- Argument helpers
  getActiveParameterIndex,
  splitSignatureParameters,
  blankClosedGroups,

  // -- Module-name regexes & context predicates
  MODULE_NAME_TOKEN_REGEX,
  MODULE_DECLARATION_REGEX,
  MODULE_CALL_TARGET_REGEX,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  findModuleDeclarations,

  // -- Top-level commas of many calls at once
  findTopLevelCommas,

  // -- Looking back from a word
  namespaceBefore,
  isStatementStart,
  findExecutionDirectives,
};
