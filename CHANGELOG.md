# Changelog

## [Unreleased]

### Added

- CodeLens reference counts above module declarations, linking to VS Code's reference peek UI (`otterscript.codeLens.enable` setting, default `true`).
- `ReferenceProvider` for module declarations and call sites (powers Shift+F12 and CodeLens counts).
- `DocumentSymbolProvider` populating the Outline panel, breadcrumbs, and Ctrl+Shift+O.
- JS/JSDoc validation workflow via `npm run check:js` (pinned TypeScript 6.0.3, `jsconfig.json`).

### Changed

- Unified completion item documentation to use `buildHoverMarkdown` for consistent formatting across hover and completion popups.
- Extracted `getActiveParameterIndex(argsText)` as a pure reusable helper in `helpers.js`.
- Extracted shared module navigation helpers (`getModuleDeclarations`, `findModuleDeclarationRange`, `findModuleReferences`, `isModuleCallContext`, `isModuleDeclarationContext`, `MODULE_NAME_TOKEN_REGEX`) into `helpers.js`.
- Replaced per-call dynamic regex compilation in `findModuleReferences` with static module-level constants.
- Optimized logger hot path with a cached output channel reference (`appendOutputLine`).
- Extracted `PROGET_VAR_DOC` constant in `language-data.js` to deduplicate 20 identical ProGet variable documentation strings.
- Aligned ESLint globals to ES2022 to match `jsconfig.json` compiler target.

### Fixed

- Fixed pending diagnostic timer not cleared on deactivation.
- Fixed optional chaining on `DocEntry.name` in variable completion provider.
- Fixed `DocEntry` typedef duplication by importing from `language-data.js`.
- Fixed `lastBracePos`/`lastParenPos`/`lastBracketPos` using `-1` sentinel instead of `null`.

## [0.2.2] - 2026-05-18

### Added

- Added language data and documentation for `Apply-Template`.
- Added warning for assignment-like `=` in `if` conditions with a quick-fix to replace `=` with `==`.
- Added warning diagnostics for duplicate keys in map expressions.
- Added duplicate map key diagnostics entry

### Fixed

- Added diagnostic codes for unknown scalar, vector, and operation warnings.
- Set `diagnostic.source` to `OtterScript` for extension diagnostics.
- Improved grammar handling for `Apply-Template` so asset highlighting is reachable and position-aware.
- Fixed variable escaping before snippet insertion in language data.
- Fixed missing `$` diagnostics in parenthesized `if` conditions.
- Minor typo and formatting fixes.

### Changed

- General language-data cleanup and maintenance.

## [0.2.1] - 2026-05-01

### Added

- Improved diagnostics performance with debouncing and caching
- Enhancements to `for` language construct and related quick fixes
- **Fix All Issues** command (`otterscript.fixAll`) that automatically applies all available quick-fixes in the current document

### Changed

- Move source code to src/
- Rename `docs.js` to `language-data.js`
- Improve logging consistency and startup information

### Fixed

- Reliability issues in completions and diagnostics
- Incorrect variable position detection in diagnostics
- Minor bugs, formatting, and documentation issues

## [0.2.0] - 2026-04-21

### Added

- Quick‑fix code actions for selected diagnostics
  - Insert missing $ prefix for variables.
  - Replace invalid boolean operators
  - These fixes are user‑initiated via the editor lightbulb and operate only on the precise diagnostic range.
- Editor folding using `#region` / `#endregion` directives (editor-only)
- Go‑to‑definition support for document‑local module calls.
  - When the cursor is on a module name in call ModuleName(...), navigation (F12 / Ctrl+Click) jumps to the corresponding module ModuleName definition within the same document.
  - This feature performs a best‑effort textual search and does not resolve cross‑file or imported modules.
- Completion trigger and hover documentation for map expressions using the `%` sigil.
- Syntax highlighting for built-in operations
- Centralized logger with consistent prefix

### Fixed

- Correctly skip multi‑line block comments when counting braces, preventing:
  - Braces inside comments from being counted as code.
  - Code following a closing */ from being skipped during validation.

### Changed

- Reorganized code: extracted helper functions, logger, constants, and regex patterns to dedicated `helpers.js` module for improved maintainability

## [0.1.1] - 2026-04-16

### Added

- Extended documentation for syntax-only constructs (swim strings, template tags, map/vector expressions).
- Richer ProGet-specific variable documentation, including availability notes and examples.
- Improved documentation coverage for scalar and vector functions, including clearer parameter descriptions and examples.

### Changed

- Hover provider fully refactored:
  - Unified rendering via a shared Markdown builder.
  - Correct suppression of hover inside strings and comments.
- Completion providers refactored for consistency and maintainability:
  - Centralized completion item construction.
  - Improved sorting and prioritization across keywords, operations, functions, and variables.
  - More accurate snippet insertion without guessing function signatures.
- Signature help significantly improved:
  - Supports scalar functions, vector functions, and operations.
  - Handles nested parentheses and complex argument expressions.
  - More reliable active-parameter tracking.
- Documentation model normalized:
  - Syntax documentation now uses the same structured format as functions and keywords.
  - Removed redundant or duplicated documentation text across entries.

### Fixed

- Removed stale diagnostic markers when closing files.
- Prevented hover and completion from triggering inside string literals and comments.
- Corrected snippet definitions for several scalar functions.
- Fixed keyword hover regressions caused by overly broad word matching.
- Improved error recovery and stability when documentation entries are incomplete or optional.

## [0.1.0] - 2026-04-13

### Added

- Syntax highlighting
- Function signatures and hover information
- Code snippets
- Basic validation
