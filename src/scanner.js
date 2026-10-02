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
 * variable-occurrence index behind highlighting, and the module-name regexes.
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
 * Core line scanner shared by {@link maskNonCodeSpans} and {@link advanceScanState}.
 *
 * Advances `state` by processing every character of `lineText`.  When `chars`
 * is non-null it is treated as a split-string output buffer: every character
 * that belongs to a non-code span is replaced with a space in that buffer --
 * except, with `keepStrings`, the contents of quoted strings and swim-strings
 * (see {@link maskCommentSpans}).
 *
 * Exported (rather than kept file-private) so unit tests can exercise the
 * character-classification logic directly.
 *
 * @param {string} lineText
 * @param {CodeScanState} state - Mutated in place.
 * @param {string[] | null} chars - Output buffer, or null for state-only mode.
 * @param {boolean} [keepStrings] - Leave quoted-string and swim-string
 *   contents unmasked (their delimiters are still blanked).
 * @returns {void}
 * @internal
 */
function scanLineState(lineText, state, chars, keepStrings = false) {
  let i = 0;
  while (i < lineText.length) {
    const { kind, next } = stepCodeScan(lineText, i, state);
    if (chars && kind !== "code" && !(keepStrings && kind === "stringContent")) {
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
 * Prepares the text before the cursor for signature-help matching: blanks
 * strings and comments, then every fully closed `( ... )` group, so only the
 * still-open calls keep their parentheses. Length-preserving (blanked chars
 * become spaces).
 *
 * This is what lets signature help find the call the cursor is really in
 * when an earlier argument contains a nested call or a parenthesis inside a
 * string -- e.g. `$Substring($Trim($x), ` or `$Substring("a(b", ` -- and
 * keeps commas inside those closed groups from shifting the active parameter.
 *
 * @param {string} text - Document text up to the cursor
 * @returns {string}
 */
function maskClosedGroups(text) {
  const state = createCodeScanState();
  const chars = text
    .split("\n")
    .map((line) => maskNonCodeSpans(line, state))
    .join("\n")
    .split("");

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
  scanLineState(lineText, state, chars, true);
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
/** Text before a token at statement start (optionally after `set` / `global`). */
const ASSIGNMENT_PREFIX_REGEX = /(?:^|[;{}]|\bset|\bglobal)\s*$/i;
/** Text after a token that makes it an assignment target (`=` but not `==`). */
const ASSIGNMENT_SUFFIX_REGEX = /^\s*=(?!=)/;

/**
 * @typedef {{ line: number, character: number, length: number, write: boolean }} VariableOccurrence
 *   `line`/`character` are 0-based and point at the sigil; `length` covers
 *   the whole token (`$name` or `${name}`). `write` is true for a declaration
 *   or assignment target (`set $x = ...`, `$x = ...`, `global $x = ...`,
 *   `foreach %p in ...`, or a module parameter, whose list may span several
 *   lines).
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
      const before = view.slice(0, character);
      // Inside a string, `@` / `%` are variables only within `$( ... )`.
      const inString = code[character] === " ";
      if (inString && tokenSigil !== "$" && !before.endsWith("$(")) continue;

      const after = view.slice(character + match[0].length);
      const isParameter =
        paramStart !== -1 && character >= paramStart && character < paramEnd &&
        MODULE_PARAMETER_PREFIX_REGEX.test(code.slice(paramStart, character));
      const write = !inString && (
        isParameter ||
        FOREACH_VARIABLE_PREFIX_REGEX.test(before) ||
        (ASSIGNMENT_PREFIX_REGEX.test(before) && ASSIGNMENT_SUFFIX_REGEX.test(after))
      );

      const key = variableKey(tokenSigil, tokenName);
      const occurrence = { line, character, length: match[0].length, write };
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
 *   names of the arguments already given before it.
 */

/**
 * The argument context at the end of `maskedPrefix`, or null when the end
 * isn't at an argument name inside an operation or module call (it's in a
 * value, outside any call, in a function call `$F(`, a literal, ...).
 *
 * @param {string} maskedPrefix - The code before the cursor, masked by
 *   {@link maskNonCodeSpans} (so brackets in strings and comments are gone);
 *   from at least the start of the statement
 * @returns {OperationArgumentContext | null}
 */
function findOperationArgumentContext(maskedPrefix) {
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

  const typedMatch = /^\s*([A-Za-z]\w*)?$/.exec(text.slice(argumentStart === -1 ? open + 1 : argumentStart));
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
      const name = /^\s*([A-Za-z]\w*)\s*:(?!:)/.exec(text.slice(segmentStart, i))?.[1];
      if (name) used.push(name);
      segmentStart = i + 1;
    }
  }

  return { operation: callee[2], namespace: callee[1] ?? null, module, typed: typedMatch[1] ?? "", used };
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
  const close = maskedText.indexOf(">", header[0].length);
  const list = maskedText.slice(header[0].length, close === -1 ? undefined : close);
  /** @type {ModuleParameter[]} */
  const params = [];
  for (const part of list.split(",")) {
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
  findOperationArgumentContext,
  parseModuleParameters,
  BRACED_NAME_PATTERN,

  // -- Argument helpers
  getActiveParameterIndex,
  splitSignatureParameters,
  maskClosedGroups,

  // -- Module-name regexes & context predicates
  MODULE_NAME_TOKEN_REGEX,
  MODULE_DECLARATION_REGEX,
  MODULE_CALL_TARGET_REGEX,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  findModuleDeclarations,
};
