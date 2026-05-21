// @ts-check
/**
 * @fileoverview Pure helper functions for OtterScript language extension.
 *
 * Dependencies:
 * - vscode (required for OutputChannel, CompletionItem, etc.)
 *
 * @module helpers
 */

const vscode = require("vscode");

// ============================================================
// CONFIGURATION
// ============================================================

/**
 * Loads OtterScript configuration from VS Code workspace settings.
 *
 * Settings are stored in .vscode/settings.json or user preferences.
 * Schema defined in package.json under "contributes.configuration".
 *
 * @returns {{
 *   completionEnabled: boolean,
 *   hoverEnabled: boolean,
 *   signatureHelpEnabled: boolean,
 *   codeLensEnabled: boolean
 * }}
 *
 * @example
 * // .vscode/settings.json
 * // {
 * //   "otterscript.completion.enable": false,
 * //   "otterscript.hover.enable": true
 * // }
 */
function loadConfig() {
  const config = vscode.workspace.getConfiguration("otterscript");

  return {
    completionEnabled: config.get("completion.enable", true),
    hoverEnabled: config.get("hover.enable", true),
    signatureHelpEnabled: config.get("signatureHelp.enable", true),
    codeLensEnabled: config.get("codeLens.enable", true)
  };
}

// ============================================================
// CONSTANTS
// ============================================================

/**
 * Set of identifier names that are valid without a '$' prefix in conditions.
 * These are language literals, not user-defined variables.
 *
 * Used by diagnostics to avoid false "missing $" errors on literals.
 * @readonly
 * @type {Set<string>}
 */
const NON_VARIABLE_IDENTIFIERS = new Set([
  "true",   // Boolean literal
  "false",  // Boolean literal
  "null"    // Null literal
]);

// ============================================================
// TIME UTILITIES
// ============================================================

/**
 * Returns current time formatted as HH:MM:SS.
 * @returns {string}
 * @private
 */
function timestamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

// ============================================================
// LOGGER
// ============================================================

const LOGPREFIX = '[OtterScript] ';
/** @type {import('vscode').OutputChannel | null} */
let outputChannel = null;

/**
 * Gets or creates the OtterScript output channel.
 * The channel appears in VS Code under View → Output → OtterScript.
 *
 * @returns {import('vscode').OutputChannel}
 */
function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('OtterScript');
  }
  return outputChannel;
}

/**
 * Centralized logger for OtterScript Language extension.
 *
 * @example
 * log.info('Extension activated');
 * log.warn('Missing documentation field');
 * log.error('Failed to load docs', err);
 * log.debug('Processing line', lineIndex);
 */
const log = {
  /** @param {...any} args - @example log.info('Extension activated') */
  info: (...args) => {
    const now = timestamp();
    console.log(LOGPREFIX, `[${now}]`, ...args);
    getOutputChannel().appendLine(`[${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - @example log.warn('Missing field') */
  warn: (...args) => {
    const now = timestamp();
    console.warn(LOGPREFIX, `[${now}]`, ...args);
    getOutputChannel().appendLine(`⚠️ [${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - @example log.error('Failed', err) */
  error: (...args) => {
    const now = timestamp();
    console.error(LOGPREFIX, `[${now}]`, ...args);
    getOutputChannel().appendLine(`❌ [${now}] ${args.join(' ')}`);
  },

  /** @param {...any} args - @example log.debug('Processing', lineIndex) */
  debug: (...args) => {
    const now = timestamp();
    // Debug logs go to console only - intentionally excluded from Output Channel
    // to avoid flooding the user-visible log with internal diagnostics.
    console.debug(LOGPREFIX, `[${now}]`, '[DEBUG]', ...args);
  }
};

// ============================================================
// VALIDATION
// ============================================================

/**
 * Performs best-effort validation of documentation tables.
 *
 * @param {string} label - Human-readable category label (e.g. "keywordDocs")
 * @param {Record<string, unknown>} docsTable - Documentation table to validate
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateDocs(label, docsTable) {
  const errors = [];
  const warnings = [];

  for (const [key, rawDoc] of Object.entries(docsTable)) {
    /** @type {any} */
    const doc = rawDoc;

    if (!doc || typeof doc !== "object") {
      errors.push(`${label}.${key} is not an object`);
      continue;
    }

    // Required Field: 'name'
    if (!doc.name || typeof doc.name !== "string" || doc.name.trim() === "") {
      errors.push(`${label}.${key} is missing required 'name'`);
    }

    // Required Field: 'description'
    if (!doc.description || typeof doc.description !== "string") {
      errors.push(`${label}.${key} is missing required 'description'`);
    }

    // Optional Field: 'snippet'
    if (doc.snippet && typeof doc.snippet !== "string") {
      warnings.push(`${label}.${key} 'snippet' must be a string`);
    }

    // Optional Field: 'signature'
    if (doc.signature && typeof doc.signature !== "string") {
      warnings.push(`${label}.${key} 'signature' must be a string`);
    }

    // Optional Field: 'documentation'
    if (doc.documentation && typeof doc.documentation !== "string") {
      warnings.push(`${label}.${key} 'documentation' must be a string`);
    }
  }

  // Log errors
  if (errors.length) {
    log.error(`[docs] ${label} errors:`, errors);
  }
  // Log warnings
  if (warnings.length) {
    log.warn(`[docs] ${label} warnings:`, warnings);
  }

  return { errors, warnings };
}

/**
 * Checks if the cursor is in a valid position for showing completions.
 * @param {vscode.TextDocument} document - The current text document
 * @param {vscode.Position} position - The current cursor position
 * @param {boolean} completionEnabled - Whether completion is enabled in settings
 * @returns {boolean}
 */
function isValidCompletionPosition(document, position, completionEnabled) {
  if (!completionEnabled) return false;
  const line = document.lineAt(position.line).text;
  return !isInStringOrComment(line, position.character);
}

// ============================================================
// REGEX UTILITIES
// ============================================================

/**
 * Builds a word-boundary RegExp that matches any of the given names.
 * Used for creating efficient lookup regexes from Sets of known identifiers.
 *
 * @param {Iterable<string>} names - Collection of strings to match
 * @returns {RegExp} Regular expression with word boundaries
 * @private
 *
 * @example
 * const regex = buildWordRegex(['Log-Information', 'Log-Error']);
 * // Returns: /\b(Log-Information|Log-Error)\b/
 */
function buildWordRegex(names) {
  return new RegExp(
    `\\b(${[...names]
      .map(name =>
        name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
      )
      .join("|")})\\b`
  );
}

/**
 * Creates all regex patterns needed for the extension.
 * @param {Set<string>} knownOperations - Set of operation names
 * @returns {{
 *   scalarCallRegex: () => RegExp,
 *   vectorCallRegex: () => RegExp,
 *   operationCallRegex: () => RegExp,
 *   scalarSignatureRegex: () => RegExp,
 *   vectorSignatureRegex: () => RegExp,
 *   operationSignatureRegex: () => RegExp,
 *   operationRegex: () => RegExp
 * }}
 */
function createRegexPatterns(knownOperations) {
  return {
    scalarCallRegex: () => /\$([A-Za-z][A-Za-z0-9_]*)\s*\(/g,
    vectorCallRegex: () => /@([A-Za-z][A-Za-z0-9_]*)\s*\(/g,
    operationCallRegex: () => /\b([A-Za-z][A-Za-z-]*)\b/g,
    scalarSignatureRegex: () => /\$([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/,
    vectorSignatureRegex: () => /@([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)$/,
    operationSignatureRegex: () => /(?:^|\s)([A-Za-z][A-Za-z-]*)\s*\(([^()]*)$/,
    operationRegex: () => buildWordRegex(knownOperations),
  };
}

/**
 * Token regex for module names used by word-range lookups.
 *
 * @readonly
 * @type {RegExp}
 */
const MODULE_NAME_TOKEN_REGEX = /[A-Za-z][\w-]*/;

const MODULE_DECLARATION_REGEX = /^\s*module\s+(\w[\w-]*)/;
const MODULE_DECL_PREFIX_REGEX = /^\s*module\s+$/i;
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

/**
 * Scans a document and returns all module declarations.
 *
 * @param {vscode.TextDocument} document
 * @returns {{ name: string, range: vscode.Range, lineRange: vscode.Range }[]}
 */
function getModuleDeclarations(document) {
  const declarations = [];

  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    const match = MODULE_DECLARATION_REGEX.exec(lineText);
    if (!match) continue;

    const name = match[1];
    const nameStart = lineText.indexOf(name, match.index);
    const range = new vscode.Range(
      new vscode.Position(line, nameStart),
      new vscode.Position(line, nameStart + name.length)
    );

    declarations.push({ name, range, lineRange: document.lineAt(line).range });
  }

  return declarations;
}

/**
 * Finds the declaration range of a module in the document.
 *
 * @param {vscode.TextDocument} document
 * @param {string} moduleName
 * @returns {vscode.Range | null}
 */
function findModuleDeclarationRange(document, moduleName) {
  const declaration = getModuleDeclarations(document).find(entry => entry.name === moduleName);
  return declaration?.range ?? null;
}

/**
 * Finds references to a module declaration and module calls in the document.
 *
 * @param {vscode.TextDocument} document
 * @param {string} moduleName
 * @param {boolean} includeDeclaration
 * @returns {vscode.Location[]}
 */
function findModuleReferences(document, moduleName, includeDeclaration) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declarationRegex = new RegExp(`^\\s*module\\s+(${escaped})\\b`);
  const callRegex = new RegExp(`^\\s*call\\s+(?:[A-Za-z][\\w-]*::)?(${escaped})\\b`);

  /** @type {vscode.Location[]} */
  const locations = [];

  for (let line = 0; line < document.lineCount; line++) {
    const lineText = document.lineAt(line).text;
    const declMatch = declarationRegex.exec(lineText);
    if (declMatch) {
      const start = declMatch.index + declMatch[0].indexOf(declMatch[1]);
      const range = new vscode.Range(
        new vscode.Position(line, start),
        new vscode.Position(line, start + moduleName.length)
      );
      if (includeDeclaration) {
        locations.push(new vscode.Location(document.uri, range));
      }
      continue;
    }

    const callMatch = callRegex.exec(lineText);
    if (callMatch) {
      const start = callMatch.index + callMatch[0].indexOf(callMatch[1]);
      const range = new vscode.Range(
        new vscode.Position(line, start),
        new vscode.Position(line, start + moduleName.length)
      );
      locations.push(new vscode.Location(document.uri, range));
    }
  }

  return locations;
}

// ============================================================
// STRING & COMMENT DETECTION
// ============================================================

/**
 * Returns true if the given position is inside a quoted string
 * or a line comment.
 *
 * This uses a fast, best-effort heuristic and does not attempt
 * full parsing.
 * @param {string} line - The full line of text
 * @param {number} position - Character position within the line (0-indexed)
 * @returns {boolean} true if position is inside string/comment, false otherwise
 * @example
 * isInStringOrComment('if $x == 5', 5);        // false (code)
 * isInStringOrComment('# comment', 2);        // true (comment)
 * isInStringOrComment('"hello"', 3);          // true (inside string)
 *
 */
function isInStringOrComment(line, position) {
  // Get text from line start up to cursor position
  const prefix = line.slice(0, position);

  // Check if the line starts with a comment marker (# or //)
  // Note: Only catches comments at START of line, not inline comments
  if (/^\s*(#|\/\/)/.test(prefix)) {
    return true;
  }

  // Inside quoted string (simple, fast heuristic)
  // Odd count of quotes means we're inside an unclosed string
  const doubleQuotes = (prefix.match(/"/g) || []).length;
  const singleQuotes = (prefix.match(/'/g) || []).length;

  // Return true if either quote type has an odd count (unclosed string)
  return doubleQuotes % 2 === 1 || singleQuotes % 2 === 1;
}

/**
 * Replaces quoted string literals in a line with empty placeholders.
 *
 * This is used by diagnostics to avoid flagging symbols inside strings.
 * For example: $var = "Unknown $Function" -> $var = "" (no false positive)
 *
 * Handles:
 *   - Double-quoted strings with escaped characters: "hello \"world\""
 *   - Single-quoted strings with escaped characters: 'hello \'world\''
 *   - Empty strings: "" or ''
 *
 * @param {string} line - The line of code to process
 * @returns {string} The line with string contents removed (quotes preserved)
 *
 * @example
 * stripStrings('$var = "Hello $name"');  // Returns: '$var = ""'
 * stripStrings("$var = 'Hello $name'");  // Returns: '$var = \'\''
 */
function stripStrings(line) {
  return line
    // Double-quoted strings: "anything here" becomes ""
    // Handles escaped quotes: \", and escaped backslashes: \\
    .replace(/"([^"\\]|\\.)*"/g, '""')
    // Single-quoted strings: 'anything here' becomes ''
    // Handles escaped quotes: \', and escaped backslashes: \\
    .replace(/'([^'\\]|\\.)*'/g, "''");
}

// ============================================================
// HOVER & COMPLETION BUILDERS
// ============================================================

/**
 * Builds a standardised hover MarkdownString from a documentation entry.
 *
 * This creates the formatted tooltip content shown when hovering over
 * symbols, keywords, operations, and syntax elements.
 *
 * @param {Readonly<{ name: string, signature?: string, description?: string, documentation?: string }>} doc
 *   - name: Required - Display name (e.g., "$ToJson")
 *   - signature: Optional - Function signature (monospace formatted)
 *   - description: Optional - Short description
 *   - documentation: Optional - Extended Markdown documentation
 * @param {boolean} [isTrusted=false] - Set true to allow command URIs in Markdown.
 * Currently unused; reserved for future use.
 * @returns {vscode.MarkdownString} - Formatted hover content
 *
 * @example
 * const doc = { name: "$ToJson", signature: "$ToJson(data)", description: "Converts to JSON" };
 * const hover = buildHoverMarkdown(doc);
 * // Returns MarkdownString with:
 * // ### $ToJson
 * // **Signature:** `$ToJson(data)`
 * // Converts to JSON
 */
function buildHoverMarkdown(doc, isTrusted = false) {
  const md = new vscode.MarkdownString();

  // Heading (### is h3 in Markdown, renders bold in VS Code)
  md.appendMarkdown(`### ${doc.name}\n\n`);

  // Signature (monospace for code clarity)
  if (doc.signature) {
    md.appendMarkdown(`**Signature:** \`${doc.signature}\`\n\n`);
  }

  // Short description
  if (doc.description) {
    md.appendMarkdown(`${doc.description}\n\n`);
  }

  // Extended documentation (supports Markdown)
  if (typeof doc.documentation === "string") {
    md.appendMarkdown(doc.documentation);
  }

  // true would allow richer formatting, but we set the default to false
  md.isTrusted = isTrusted;

  return md;
}

/**
 * Builds a completion item with consistent formatting.
 *
 * This centralizes completion item creation to ensure all providers
 * produce consistent UI elements (labels, details, documentation, sorting).
 *
 * @param {import('../src/language-data.js').DocEntry} doc - Documentation object
 * @param {vscode.CompletionItemKind} kind - Item kind (Function, Variable, Keyword, etc.)
 * @param {string} sortPrefix - Sort order prefix (e.g., "0_" for operations, "1_" for functions)
 * @param {string | vscode.SnippetString} insertText - Text to insert when selected
 * @param {boolean} [triggerSignatureHelp=false] - Whether to trigger signature help after insertion
 * @returns {vscode.CompletionItem} - Formatted completion item
 *
 * @example
 * // For a scalar function
 * buildCompletionItem(doc, vscode.CompletionItemKind.Function, '1_', snippet, true);
 *
 * // For a variable (no signature help)
 * buildCompletionItem(doc, vscode.CompletionItemKind.Variable, '2_', snippet, false);
 */
function buildCompletionItem(doc, kind, sortPrefix, insertText, triggerSignatureHelp = false) {
  const item = new vscode.CompletionItem(
    { label: doc.name, description: doc.description },
    kind
  );

  item.insertText = insertText;
  item.detail = doc.signature ?? doc.description;
  item.documentation = doc.documentation
    ? new vscode.MarkdownString(doc.documentation)
    : undefined;
  item.sortText = `${sortPrefix}${doc.name}`;

  // Trigger signature help after insertion (for functions with parameters)
  if (triggerSignatureHelp) {
    item.command = {
      command: 'editor.action.triggerParameterHints',
      title: ''  // Title required but not shown for built-in commands
    };
  }

  return item;
}

/**
 * Checks for missing '$' before variable names in if conditions.
 *
 * @param {string} line - The raw line of code
 * @param {number} lineIndex - The line number (0-indexed)
 * @param {Set<string>} nonVariableIdentifiers - Set of literals (true, false, null)
 * @returns {vscode.Diagnostic | null} - Diagnostic if missing '$' found, null otherwise
 */
function checkMissingDollar(line, lineIndex, nonVariableIdentifiers) {
  const match = line.match(/^\s*if\s*(?:\(\s*)*([a-zA-Z][a-zA-Z0-9_]*)\s*(=|==|!=|<=|>=|<|>)/);

  // -- Guard: ensure regex matched and we have a valid index position
  if (!match || typeof match.index !== 'number') return null;

  const varName = match[1];

  // -- Skip known literals that don't need '$' (true, false, null)
  if (nonVariableIdentifiers.has(varName)) {
    return null;
  }

  // -- Calculate exact position of variable name within the line
  const varNameIndex = match.index + match[0].indexOf(varName);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(lineIndex, varNameIndex),
      new vscode.Position(lineIndex, varNameIndex + varName.length)
    ),
    `Missing '$' before variable: ${varName}. Use $${varName}`,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.code = "missing-dollar";
  diagnostic.source = "OtterScript";

  return diagnostic;
}

/**
 * Finds duplicate keys inside map expressions and returns diagnostics.
 *
 * This performs a best-effort scan of `%(... )` blocks and warns when
 * the same key appears more than once at the top level of a map.
 *
 * @param {vscode.TextDocument} document - Document to analyze
 * @param {string} [source] - Optional pre-fetched document text; defaults to document.getText()
 * @returns {vscode.Diagnostic[]} Duplicate-key diagnostics
 */
function findDuplicateMapKeyDiagnostics(document, source = document.getText()) {
  // Produce a length-preserving masked copy so offsets remain valid for document.positionAt().
  // String contents and comments are replaced with spaces; newlines are kept to preserve line offsets.
  const maskedText = source
    // Mask quoted strings first so // or # inside strings are not treated as comments.
    .replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, match => match.replace(/[^\n]/g, " "))
    // Mask block comments but keep indexes stable.
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "))
    // Mask line comments (# and //) — no preceding-whitespace requirement.
    .replace(/(\/\/|#).*$/gm, match => ' '.repeat(match.length));

  /** @type {vscode.Diagnostic[]} */
  const issues = [];

  /**
   * Finds the matching ')' for an opening '(' position.
   *
   * @param {number} openParenIndex - Index of opening '('
   * @returns {number} Matching ')' index, or -1 when not found
   */
  function findMatchingParen(openParenIndex) {
    let depth = 1;
    for (let i = openParenIndex + 1; i < maskedText.length; i++) {
      if (maskedText[i] === '(') depth++;
      if (maskedText[i] === ')') depth--;
      if (depth === 0) return i;
    }
    return -1;
  }

  /**
   * Parses a map expression body and reports duplicate top-level keys.
   *
   * @param {number} start - Start index of map body (after '%(')
   * @param {number} end - End index of map body (at matching ')')
   * @returns {void}
   */
  function scanMapBody(start, end) {
    let nestingDepth = 0;
    let segmentStart = start;
    const seenKeys = new Set();

    for (let i = start; i <= end; i++) {
      const ch = i === end ? ',' : maskedText[i];

      if (ch === '(' || ch === '[' || ch === '{') {
        nestingDepth++;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (nestingDepth > 0) nestingDepth--;
        continue;
      }

      if (ch === ',' && nestingDepth === 0) {
        const segmentText = maskedText.slice(segmentStart, i);
        const keyMatch = segmentText.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/);

        if (keyMatch) {
          const key = keyMatch[1];
          const keyStart = segmentStart + keyMatch[0].indexOf(key);

          if (seenKeys.has(key)) {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(
                document.positionAt(keyStart),
                document.positionAt(keyStart + key.length)
              ),
              `Duplicate key '${key}' in map expression.`,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = "duplicate-map-key";
            diagnostic.source = "OtterScript";
            issues.push(diagnostic);
          } else {
            seenKeys.add(key);
          }
        }

        segmentStart = i + 1;
      }
    }
  }

  for (let i = 0; i < maskedText.length - 1; i++) {
    if (maskedText[i] === '%' && maskedText[i + 1] === '(') {
      const close = findMatchingParen(i + 1);
      if (close !== -1) {
        scanMapBody(i + 2, close);
        i = close;
      }
    }
  }

  return issues;
}

/**
 * Gets the diagnostic code as a string.
 * @param {vscode.Diagnostic} diagnostic
 * @returns {string}
 */
function getDiagnosticCode(diagnostic) {
  const code = diagnostic.code;
  if (code === undefined || code === null) return '';
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

// ============================================================
// CODE ACTION FACTORY
// ============================================================

/**
 * Generic code action factory for creating quick-fix actions.
 *
 * This factory centralizes the creation of VS Code CodeAction objects,
 * reducing duplication across multiple fix providers.
 *
 * @private
 * @param {string} title - Human-readable action title shown in lightbulb menu
 * @param {vscode.Diagnostic} diagnostic - The diagnostic this action fixes
 * @param {(edit: vscode.WorkspaceEdit) => void} applyFix - Callback that applies the fix to a WorkspaceEdit
 * @returns {vscode.CodeAction} Configured code action ready to be returned to VS Code
 *
 * @example
 * // Create a fix that inserts a character
 * createCodeAction("Insert '$'", diagnostic, (edit) => {
 *   edit.insert(uri, position, "$");
 * });
 *
 */
function createCodeAction(title, diagnostic, applyFix) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  const edit = new vscode.WorkspaceEdit();
  applyFix(edit);
  action.edit = edit;
  return action;
}

/**
 * Creates a quick-fix that inserts a missing '$' at the diagnostic position.
 *
 * This code action appears in the lightbulb menu (💡) when a variable
 * is used without a '$' prefix in an if condition.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the missing '$' error
 * @returns {vscode.CodeAction} A code action that inserts '$' at the diagnostic position
 *
 * @example
 * // For diagnostic on "if x > 5"
 * // The action inserts "$" before "x" -> "if $x > 5"
 */
function createMissingDollarFix(document, diagnostic) {
  const uri = document.uri;
  const start = diagnostic.range.start;

  return createCodeAction("Insert missing '$'", diagnostic, (edit) => {
    edit.insert(uri, start, "$");
  });
}

/**
 * Creates a quick-fix that replaces invalid boolean operators.
 *
 * This code action appears in the lightbulb menu (💡) when a single
 * '&' or '|' is used instead of '&&' or '||'.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the invalid operator
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 *
 * @example
 * // For diagnostic on "&" -> creates action to replace with "&&"
 */
function createInvalidOperatorFix(document, diagnostic) {
  const text = document.getText(diagnostic.range);
  const replacement = text === "&" ? "&&" : text === "|" ? "||" : null;

  if (!replacement) return null;

  return createCodeAction(`Replace '${text}' with '${replacement}'`, diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, replacement);
  });
}

/**
 * Creates a quick-fix that replaces assignment-like '=' with '==' in conditions.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with assignment-like usage
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 */
function createAssignmentInConditionFix(document, diagnostic) {
  const text = document.getText(diagnostic.range);
  if (text !== "=") return null;

  return createCodeAction("Replace '=' with '=='", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, "==");
  });
}

/**
 * Creates a quick-fix that replaces incorrect 'for' loop usage with 'foreach'.
 *
 * @param {vscode.TextDocument} document - The document containing the diagnostic
 * @param {vscode.Diagnostic} diagnostic - The diagnostic with the incorrect 'for' usage
 * @returns {vscode.CodeAction | null} Code action or null if replacement unknown
 */
function createForToForeachFix(document, diagnostic) {
  return createCodeAction("Replace 'for' with 'foreach'", diagnostic, (edit) => {
    edit.replace(document.uri, diagnostic.range, 'foreach');
  });
}

/**
 * Creates a diagnostic for unbalanced symbols.
 * @param {number} count - Current count (positive = unclosed, negative = extra closing)
 * @param {number} lastPos - Position of last unmatched symbol
 * @param {string} openChar - Opening character ('{', '(', '[')
 * @param {string} closeChar - Closing character ('}', ')', ']')
 * @param {string} name - Display name ('brace', 'parenthesis', 'bracket')
 * @param {vscode.TextDocument} document - The document
 * @returns {vscode.Diagnostic | null}
 */
function createUnbalancedDiagnostic(count, lastPos, openChar, closeChar, name, document) {
  if (count === 0) return null;

  const pos = document.positionAt(lastPos);
  const lineNum = pos.line + 1;
  const colNum = pos.character + 1;
  const message = count > 0
    ? `Unclosed ${name}(s): ${count} '${openChar}' not closed (first at line ${lineNum}, col ${colNum})`
    : `Unexpected closing ${name}: Extra '${closeChar}' at line ${lineNum}, col ${colNum}`;

  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(pos, document.positionAt(lastPos + 1)),
    message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = "OtterScript";
  return diagnostic;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // -- Configuration
  loadConfig,

  // -- Constants
  NON_VARIABLE_IDENTIFIERS,

  // -- Logger
  log,
  getOutputChannel,

  // -- Helpers
  isValidCompletionPosition,
  isInStringOrComment,
  stripStrings,
  checkMissingDollar,
  findDuplicateMapKeyDiagnostics,
  validateDocs,
  createUnbalancedDiagnostic,
  getDiagnosticCode,

  // -- Builders
  buildHoverMarkdown,
  buildCompletionItem,

  // -- Code Actions
  createMissingDollarFix,
  createInvalidOperatorFix,
  createAssignmentInConditionFix,
  createForToForeachFix,

  // -- Module navigation
  MODULE_NAME_TOKEN_REGEX,
  isModuleDeclarationContext,
  isModuleCallContext,
  getModuleDeclarations,
  findModuleDeclarationRange,
  findModuleReferences,

  // -- Regex
  createRegexPatterns
};
