// @ts-check
/**
 * @fileoverview Pure, dependency-free text scanning primitives for OtterScript.
 *
 * This module is deliberately **free of any `vscode` import** so it can be unit
 * tested with plain Node (`node:test`) and reused outside the extension host
 * (e.g. a future CLI linter).
 *
 * It owns the single source of truth for how the extension recognises non-code
 * spans — quoted strings, line comments, block comments, and swim-strings — plus
 * the argument-index helper and module-name regexes that build on that scan.
 * Everything here operates on plain strings, numbers, and the {@link CodeScanState}
 * plain object; nothing here constructs a `vscode.*` value.
 *
 * `helpers.js` re-exports the public members of this module, so existing callers
 * that `require("./helpers")` keep working unchanged.
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

/** Matches a `module <Name>` declaration and captures the name. */
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
 * Core line scanner shared by {@link maskNonCodeSpans} and {@link advanceScanState}.
 *
 * Advances `state` by processing every character of `lineText`.  When `chars`
 * is non-null it is treated as a split-string output buffer: every character
 * that belongs to a non-code span is replaced with a space in that buffer.
 *
 * Exported (rather than kept file-private) so unit tests can exercise the
 * character-classification logic directly.
 *
 * @param {string} lineText
 * @param {CodeScanState} state - Mutated in place.
 * @param {string[] | null} chars - Output buffer, or null for state-only mode.
 * @returns {void}
 * @internal
 */
function scanLineState(lineText, state, chars) {
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i];

    if (state.inBlockComment) {
      if (chars) chars[i] = " ";
      if (ch === "*" && lineText[i + 1] === "/") {
        if (chars) chars[i + 1] = " ";
        state.inBlockComment = false;
        i++;
      }
      continue;
    }

    if (state.swimDelimiter) {
      if (chars) chars[i] = " ";
      if (lineText.startsWith(state.swimDelimiter, i)) {
        if (chars) {
          for (let j = 0; j < state.swimDelimiter.length; j++) {
            if (i + j < chars.length) chars[i + j] = " ";
          }
        }
        i += state.swimDelimiter.length - 1;
        state.swimDelimiter = null;
      }
      continue;
    }

    if (state.inString) {
      if (chars) chars[i] = " ";
      if (ch === state.quote && isUnescapedQuoteAt(lineText, i)) {
        state.inString = false;
        state.quote = null;
      }
      continue;
    }

    if (ch === "/" && lineText[i + 1] === "*") {
      if (chars) {
        chars[i] = " ";
        if (i + 1 < chars.length) chars[i + 1] = " ";
      }
      state.inBlockComment = true;
      i++;
      continue;
    }

    if (ch === ">") {
      const swimMatch = lineText.slice(i).match(/^>[^>]{0,5}>/);
      if (swimMatch) {
        const delimiter = swimMatch[0];
        if (chars) {
          for (let j = 0; j < delimiter.length; j++) {
            if (i + j < chars.length) chars[i + j] = " ";
          }
        }
        state.swimDelimiter = delimiter;
        i += delimiter.length - 1;
        continue;
      }
    }

    if (ch === '"' || ch === "'") {
      if (chars) chars[i] = " ";
      state.inString = true;
      state.quote = ch;
      continue;
    }

    if (ch === "#") {
      if (chars) { for (let j = i; j < chars.length; j++) chars[j] = " "; }
      break;
    }

    if (ch === "/" && lineText[i + 1] === "/") {
      if (chars) { for (let j = i; j < chars.length; j++) chars[j] = " "; }
      break;
    }
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
    if (code.inBlockComment) {
      if (ch === "*" && line[i + 1] === "/") { code.inBlockComment = false; i++; }
      continue;
    }
    if (code.swimDelimiter) {
      if (line.startsWith(code.swimDelimiter, i)) {
        i += code.swimDelimiter.length - 1;
        code.swimDelimiter = null;
      }
      continue;
    }
    if (code.inString) {
      if (ch === code.quote && isUnescapedQuoteAt(line, i)) {
        code.inString = false;
        code.quote = null;
      }
      continue;
    }
    if (ch === "%" && line[i + 1] === ">") {
      chars[i] = " ";
      chars[i + 1] = " ";
      state.inTemplateTag = false;
      i++;
      continue;
    }
    if (ch === "/" && line[i + 1] === "*") {
      code.inBlockComment = true;
      i++;
      continue;
    }
    if (ch === ">") {
      const swimMatch = line.slice(i).match(/^>[^>]{0,5}>/);
      if (swimMatch) {
        code.swimDelimiter = swimMatch[0];
        i += swimMatch[0].length - 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      code.inString = true;
      code.quote = ch;
      continue;
    }
    if (ch === "#" || (ch === "/" && line[i + 1] === "/")) {
      break; // rest of the line is a comment; nothing after can close the tag
    }
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
    // code, mirroring maskOutsideTemplateTags's inside-tag branch exactly. --
    chars[i] = " ";
    if (code.inBlockComment) {
      if (ch === "*" && line[i + 1] === "/") { chars[i + 1] = " "; code.inBlockComment = false; i++; }
      continue;
    }
    if (code.swimDelimiter) {
      if (line.startsWith(code.swimDelimiter, i)) {
        for (let k = 1; k < code.swimDelimiter.length; k++) chars[i + k] = " ";
        i += code.swimDelimiter.length - 1;
        code.swimDelimiter = null;
      }
      continue;
    }
    if (code.inString) {
      if (ch === code.quote && isUnescapedQuoteAt(line, i)) {
        code.inString = false;
        code.quote = null;
      }
      continue;
    }
    if (ch === "%" && line[i + 1] === ">") {
      chars[i + 1] = " ";
      state.inTemplateTag = false;
      i++;
      continue;
    }
    if (ch === "/" && line[i + 1] === "*") {
      chars[i + 1] = " ";
      code.inBlockComment = true;
      i++;
      continue;
    }
    if (ch === ">") {
      const swimMatch = line.slice(i).match(/^>[^>]{0,5}>/);
      if (swimMatch) {
        for (let k = 1; k < swimMatch[0].length; k++) chars[i + k] = " ";
        code.swimDelimiter = swimMatch[0];
        i += swimMatch[0].length - 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      code.inString = true;
      code.quote = ch;
      continue;
    }
    if (ch === "#" || (ch === "/" && line[i + 1] === "/")) {
      for (let k = i; k < line.length; k++) chars[k] = " ";
      break; // rest of the line is a comment; nothing after can close the tag
    }
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
 * Pure counterpart of the declaration scan in `helpers.getModuleInfo`, for
 * callers (e.g. a workspace-symbol index) that only have text and want plain
 * data rather than `vscode` ranges.
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

  for (let i = 0; i < limit; i++) {
    const ch = line[i];

    if (scanState.inBlockComment) {
      if (ch === "*" && line[i + 1] === "/") {
        scanState.inBlockComment = false;
        i++;
      }
      continue;
    }

    if (scanState.swimDelimiter) {
      if (line.startsWith(scanState.swimDelimiter, i)) {
        i += scanState.swimDelimiter.length - 1;
        scanState.swimDelimiter = null;
      }
      continue;
    }

    if (scanState.inString) {
      if (ch === scanState.quote && isUnescapedQuoteAt(line, i)) {
        scanState.inString = false;
        scanState.quote = null;
      }
      continue;
    }

    if (ch === "/" && line[i + 1] === "*") {
      scanState.inBlockComment = true;
      i++;
      continue;
    }

    if (ch === ">") {
      const swimMatch = line.slice(i).match(/^>[^>]{0,5}>/);
      if (swimMatch) {
        scanState.swimDelimiter = swimMatch[0];
        i += scanState.swimDelimiter.length - 1;
        continue;
      }
    }

    if (ch === '"' || ch === "'") {
      scanState.inString = true;
      scanState.quote = ch;
      continue;
    }

    if (ch === "#" || (ch === "/" && line[i + 1] === "/")) {
      return true;
    }
  }

  return scanState.inString || scanState.inBlockComment || scanState.swimDelimiter !== null;
}

// ============================================================
// ARGUMENT HELPERS
// ============================================================

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
  let quote = null;
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

  // -- Argument helpers
  getActiveParameterIndex,

  // -- Module-name regexes & context predicates
  MODULE_NAME_TOKEN_REGEX,
  MODULE_DECLARATION_REGEX,
  MODULE_CALL_TARGET_REGEX,
  MODULE_CALL_TARGET_GLOBAL_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  findModuleDeclarations,
};
