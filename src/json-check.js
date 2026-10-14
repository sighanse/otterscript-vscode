// @ts-check
/**
 * @fileoverview The JSON syntax check of a text template's literal output,
 * such as a ProGet webhook body: what the template writes outside its
 * `<% %>` tags must parse as JSON once the template has run. Reports the
 * first problem only, as a JSON parser does, since one mistake makes the
 * rest of the text misread.
 *
 * Two things in the literal output aren't JSON until the template runs, and
 * are taken as what they become:
 * - an OtterScript expression (`$ToJson($x)`, `$x`, `${my var}`,
 *   `$(%p.Name)`, `@list`, `%map`) is a value, or a property name;
 * - a `<% %>` tag can write anything, or nothing (a loop that writes a comma
 *   before each element), so no problem is reported right after one: the
 *   check gives up instead.
 *
 * Runs only when the literal output starts with `{` or `[`. vscode-free.
 *
 * @module json-check
 */

const { maskTemplateTags } = require("./scanner");

/**
 * A problem, as offsets into the document's text. `fix`, when there is one,
 * replaces `[fix.start, fix.end)` with `fix.text`; it is certain, not a
 * guess.
 *
 * @typedef {{
 *   start: number,
 *   end: number,
 *   message: string,
 *   fix?: { start: number, end: number, text: string, title: string }
 * }} JsonProblem
 */

/**
 * What the parser expects next in an object or array, or at the top:
 * - `key-or-close`: after `{`; `key`: after a comma in an object
 * - `colon`: after a property name
 * - `value`: after `:`, or the top-level value
 * - `value-or-close`: after `[`; `element`: after a comma in an array
 * - `comma-or-close`: after a property's value or an element
 * - `end`: after the top-level value
 *
 * @typedef {"key-or-close" | "key" | "colon" | "value" | "value-or-close" | "element" | "comma-or-close" | "end"} JsonState
 */

/**
 * An object or array still open: its bracket (`{` or `[`), where that is,
 * and what it expects next.
 *
 * @typedef {{ open: string, start: number, state: JsonState }} JsonFrame
 */

/** A JSON number, matched where it starts. */
const NUMBER_REGEX = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
/** A run of text up to the next space or JSON punctuation: what a message names. */
const WORD_REGEX = /[^\s,:[\]{}"]+/y;
/** An unquoted property name that quoting would make right. */
const BARE_NAME_REGEX = /[A-Za-z_][\w-]*/y;
/** A character after which a number or a word goes on (`01`, `1a`). */
const WORD_CHAR_REGEX = /[\w.$]/;
/** The characters a JSON string may follow a backslash with. */
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * The first JSON syntax problem in a text template's literal output, or null
 * when there is none or the output isn't JSON (doesn't start with `{` or
 * `[`).
 *
 * @param {string} text - The document's text
 * @returns {JsonProblem | null}
 */
function findTemplateJsonProblem(text) {
  const literal = maskTemplateTags(text);
  const length = literal.length;
  let i = 0;
  /** Whether a tag lies between the last token and `i`. */
  let tagSinceToken = false;
  /** Where the last token ended, for inserting a missing comma after it. */
  let lastTokenEnd = 0;
  /** The last comma, for removing one before `}` or `]`. */
  let lastComma = -1;

  /** @type {JsonFrame[]} */
  const stack = [];
  /** @type {JsonState} */
  let topState = "value";

  /**
   * Skips whitespace, noting a tag in it (a tag is blanked to spaces in
   * `literal`, but not in `text`).
   *
   * @returns {void}
   */
  const skip = () => {
    while (i < length && /\s/.test(literal[i])) {
      if (literal[i] !== text[i]) tagSinceToken = true;
      i++;
    }
  };

  /**
   * Moves past a token ending at `end`.
   *
   * @param {number} end
   * @returns {void}
   */
  const consume = (end) => {
    i = end;
    lastTokenEnd = end;
    tagSinceToken = false;
  };

  /**
   * The problem at `[start, end)`, or null when a tag lies right before it.
   *
   * @param {number} start
   * @param {number} end
   * @param {string} message
   * @param {JsonProblem["fix"]} [fix]
   * @returns {JsonProblem | null}
   */
  const problem = (start, end, message, fix) => (tagSinceToken ? null : { start, end, message, ...(fix && { fix }) });

  /**
   * Where the token at `at` ends, for marking it: a string to its closing
   * quote on the line, a run of text, or one character.
   *
   * @param {number} at
   * @returns {number}
   */
  const tokenEnd = (at) => {
    if (literal[at] === '"' || literal[at] === "'") {
      const close = literal.indexOf(literal[at], at + 1);
      const lineEnd = lineEndAt(literal, at);
      return close !== -1 && close < lineEnd ? close + 1 : lineEnd;
    }
    WORD_REGEX.lastIndex = at;
    return WORD_REGEX.test(literal) ? WORD_REGEX.lastIndex : at + 1;
  };

  /**
   * Sets what comes after a value just read: a comma or the closing
   * bracket, or the end of the text.
   *
   * @returns {void}
   */
  const afterValue = () => {
    const frame = stack[stack.length - 1];
    if (frame) frame.state = "comma-or-close";
    else topState = "end";
  };

  skip();
  if (literal[i] !== "{" && literal[i] !== "[") return null;

  for (;;) {
    skip();
    const frame = stack[stack.length - 1];
    const state = frame ? frame.state : topState;
    const c = literal[i];

    if (i >= length) {
      if (!frame) return null;
      // The innermost bracket still open.
      return problem(frame.start, frame.start + 1, `This '${frame.open}' is never closed.`);
    }

    if (state === "end") {
      return problem(i, tokenEnd(i), "Unexpected text after the end of the JSON value.");
    }

    if (state === "comma-or-close") {
      const open = /** @type {NonNullable<typeof frame>} */ (frame);
      const close = open.open === "{" ? "}" : "]";
      if (c === ",") {
        lastComma = i;
        consume(i + 1);
        open.state = open.open === "{" ? "key" : "element";
      } else if (c === close) {
        consume(i + 1);
        stack.pop();
      } else if (c === "}" || c === "]") {
        return problem(i, i + 1, `Expected '${close}' to close the '${open.open}' on line ${lineNumberAt(literal, open.start)}.`);
      } else {
        const after = open.open === "{" ? "the property's value" : "the element";
        return problem(i, tokenEnd(i), `Expected ',' or '${close}' after ${after}.`,
          { start: lastTokenEnd, end: lastTokenEnd, text: ",", title: "Add ','" });
      }
      continue;
    }

    if (state === "colon") {
      if (c !== ":") return problem(i, tokenEnd(i), "Expected ':' after the property name.");
      consume(i + 1);
      /** @type {NonNullable<typeof frame>} */ (frame).state = "value";
      continue;
    }

    if (state === "key-or-close" || state === "key") {
      const open = /** @type {NonNullable<typeof frame>} */ (frame);
      if (c === "}") {
        if (state === "key") {
          return problem(lastComma, lastComma + 1, "JSON doesn't allow a comma before '}'.",
            { start: lastComma, end: lastComma + 1, text: "", title: "Remove the comma" });
        }
        consume(i + 1);
        stack.pop();
        continue;
      }
      if (c === '"') {
        const end = stringEnd(i);
        if (typeof end !== "number") return problem(end.start, end.end, end.message, end.fix);
        consume(end);
        open.state = "colon";
        continue;
      }
      if (c === "'") return problem(i, tokenEnd(i), "JSON strings need double quotes.");
      if (c === "$" || c === "@" || c === "%") {
        const end = expressionEnd(i);
        if (typeof end === "number") {
          consume(end);
          open.state = "colon";
          continue;
        }
        if (end) return problem(end.start, end.end, end.message);
      }
      BARE_NAME_REGEX.lastIndex = i;
      if (BARE_NAME_REGEX.test(literal)) {
        const end = BARE_NAME_REGEX.lastIndex;
        const name = literal.slice(i, end);
        return problem(i, end, `A property name needs double quotes: "${name}".`,
          { start: i, end, text: `"${name}"`, title: `Quote '${name}'` });
      }
      return problem(i, tokenEnd(i), "Expected a property name in double quotes.");
    }

    // -- A value: after ':', after '[' or a comma in an array, or at the top.
    if (c === "]" && state === "value-or-close") {
      consume(i + 1);
      stack.pop();
      continue;
    }
    if (c === "]" && state === "element") {
      return problem(lastComma, lastComma + 1, "JSON doesn't allow a comma before ']'.",
        { start: lastComma, end: lastComma + 1, text: "", title: "Remove the comma" });
    }
    if (c === "{" || c === "[") {
      afterValue();
      stack.push({ open: c, start: i, state: c === "{" ? "key-or-close" : "value-or-close" });
      consume(i + 1);
      continue;
    }
    if (c === "," || c === ":" || c === "}" || c === "]") return problem(i, i + 1, "Expected a value.");
    if (c === '"') {
      const end = stringEnd(i);
      if (typeof end !== "number") return problem(end.start, end.end, end.message, end.fix);
      consume(end);
      afterValue();
      continue;
    }
    if (c === "'") return problem(i, tokenEnd(i), "JSON strings need double quotes.");
    if (c === "$" || c === "@" || c === "%") {
      const end = expressionEnd(i);
      if (typeof end === "number") {
        consume(end);
        afterValue();
        continue;
      }
      if (end) return problem(end.start, end.end, end.message);
    }
    const end = literalValueEnd(i);
    if (end === -1) {
      const word = literal.slice(i, tokenEnd(i));
      return problem(i, i + word.length,
        `'${word}' isn't a JSON value: quote it, or write true, false, null or a number.`);
    }
    consume(end);
    afterValue();
  }

  /**
   * Where the string starting at `start` ends (after its closing quote), or
   * the problem in it: a line break before the closing quote, or a
   * backslash that isn't a JSON escape.
   *
   * @param {number} start - At the opening `"`
   * @returns {number | JsonProblem}
   */
  function stringEnd(start) {
    for (let j = start + 1; j < length; j++) {
      const ch = literal[j];
      if (ch === '"') return j + 1;
      if (ch === "\n" || ch === "\r") break;
      if (ch !== "\\") continue;
      const next = literal[j + 1];
      const isEscape = JSON_ESCAPES.has(next) && (next !== "u" || /^[0-9A-Fa-f]{4}$/.test(literal.slice(j + 2, j + 6)));
      if (!isEscape) {
        const shown = literal.slice(j, j + 2);
        return {
          start: j, end: j + 2,
          message: `'${shown}' isn't a JSON escape: write '\\\\' for a backslash.`,
          fix: { start: j, end: j + 1, text: "\\\\", title: "Escape the backslash" },
        };
      }
      j++;
    }
    return {
      start, end: lineEndAt(literal, start),
      message: "This string isn't closed on its line: a JSON string can't hold a line break (write \\n).",
    };
  }

  /**
   * Where the OtterScript expression starting at `start` ends: `$name`,
   * `$Name(...)`, `${name}` or `$(...)`, and the same with `@` or `%`.
   * Undefined when the sigil starts no expression; a problem when its `(`
   * is never closed.
   *
   * @param {number} start - At the sigil
   * @returns {number | JsonProblem | undefined}
   */
  function expressionEnd(start) {
    let j = start + 1;
    if (literal[j] === "{") {
      const close = literal.indexOf("}", j);
      return close !== -1 && close < lineEndAt(literal, j) ? close + 1 : undefined;
    }
    if (literal[j] !== "(") {
      if (!/[A-Za-z_]/.test(literal[j] ?? "")) return undefined;
      while (j < length && /\w/.test(literal[j])) j++;
      if (literal[j] !== "(") return j;
    }
    return parenEnd(j);
  }

  /**
   * Where the `(` at `open` is closed, skipping strings (OtterScript's,
   * escaped with a backtick) and nested parentheses; a problem when it
   * never is.
   *
   * @param {number} open
   * @returns {number | JsonProblem}
   */
  function parenEnd(open) {
    let depth = 0;
    /** @type {string | null} */
    let quote = null;
    for (let j = open; j < length; j++) {
      const ch = literal[j];
      if (quote) {
        if (ch === "`") j++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")" && --depth === 0) {
        return j + 1;
      }
    }
    return { start: open, end: open + 1, message: "This '(' is never closed." };
  }

  /**
   * Where the number, `true`, `false` or `null` at `start` ends, or -1 when
   * there is none, or it runs on into other text (`01`, `True`).
   *
   * @param {number} start
   * @returns {number}
   */
  function literalValueEnd(start) {
    let end = -1;
    NUMBER_REGEX.lastIndex = start;
    if (NUMBER_REGEX.test(literal)) end = NUMBER_REGEX.lastIndex;
    else {
      for (const word of ["true", "false", "null"]) {
        if (literal.startsWith(word, start)) end = start + word.length;
      }
    }
    if (end === -1 || WORD_CHAR_REGEX.test(literal[end] ?? "")) return -1;
    return end;
  }
}

/**
 * The offset where the line holding `offset` ends (its line break, or the
 * end of the text).
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
function lineEndAt(text, offset) {
  const newline = text.indexOf("\n", offset);
  const end = newline === -1 ? text.length : newline;
  return text[end - 1] === "\r" ? end - 1 : end;
}

/**
 * The 1-based line number of `offset`.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
function lineNumberAt(text, offset) {
  let line = 1;
  for (let j = text.indexOf("\n"); j !== -1 && j < offset; j = text.indexOf("\n", j + 1)) line++;
  return line;
}

module.exports = { findTemplateJsonProblem };
