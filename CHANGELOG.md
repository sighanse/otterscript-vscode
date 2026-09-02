# Changelog

## [0.2.6] - 2026-09-02

### Added

- Preparation for namespace support in the language
- Re-run diagnostics when a document is saved, so externally-made changes (e.g. a Git checkout or an edit from another editor) are picked up
- `npm run check:lang` script (and `npm run check`) that fails when the TextMate grammar's function/operation name lists drift out of sync with `src/language-data.js`; wired into the Sanity CI workflow as a blocking check

### Fixed

- Fixed namespaced signature help in helpers
- Fixed `isFunction` check in completion provider
- Fixed newline snippet handling in language features
- Fixed scalar `$` completion classifying non-function entries (`$ExecutionId`, `$ExecutionState`, `$WorkingDirectory`, `$RoleName`) as functions and sorting them ahead of variables
- Added missing syntax highlighting for `$EncodeBasicAuth`, `$SecureCredentialProperty`, `$SecureResourceProperty`, `$PackageHash`, `$PackageProperty`, `@BuildIssues`, `@FilesOnDisk`, `@AcquiredServers`, `@AllServers`, `@ServersInEnvironment`, `@ServersInRole`, and `@ServersInRoleAndEnvironment`
- Removed `GetVariableValue` from language data until another completion/hover provider is added
- Removed duplicate `WorkingDirectory` entry
- Corrected operation and function signatures in language data, added 13 scalar functions

### Changed

- Bumped eslint from 10.8.0 to 10.9.1 in devDependencies
- Bumped globals from 17.8.0 to 17.12.0 in devDependencies
- Bumped ovsx from 1.0.2 to 1.1.1 in devDependencies

## [0.2.5] - 2026-08-07

### Added

- Added `Copy-Files`, `Create-Directory`, `Create-File`, `Delete-Files`, `Ensure-File`, `Set-Variable`, and `Exec` operations to the language data.
- Added `$Coalesce`, `$PadLeft`, `$PadRight`, `$TrimStart`, `$TrimEnd`, `GetVariableValue`, and `$IsVariableDefined` scalar functions to the language data.
- Added `@FilesOnDisk`, `@AcquiredServers`, `@AllEnvironments`, `@AllRoles`, `@AllServers`, `@ServersInEnvironment`, `@ServersInRole`, and `@ServersInRoleAndEnvironment` vector functions/variables to the language data.

### Changed

Fix missing highlight for: `Ensure-Package`, `Install-Package`, `Push-PackageFile`, and `Query-Package`

## [0.2.4] - 2026-07-08

Adds new language coverage and editor folding support, plus documentation updates.

### Added

- Added `Install-Package`, `Ensure-Package`, `Query-Package`, and `Push-PackageFile` operation to the language data.
- Added `SecureCredentialProperty` and `SecureResourceProperty` functions to the language data.
- Added folding range support for OtterScript blocks via a dedicated folding range provider.

### Changed

- Updated folding range behavior.
- Improved duplicate map-key diagnostics internals by reusing shared scan state.

## [0.2.3] - 2026-05-22

### Added

- 19 new operations with full IntelliSense (completion, hover, signature help, snippets): `Restart-Server`, `Get-Asset`, `Release-Server`, `Download-Http`, `Upload-Http`, `Ensure-Service`, `Ensure-Directory`, `Ensure-Server`, `Ensure-Asset`, `Ensure-PsModule`, `Ensure-HostsEntry`, `Acquire-Server`, `Get-Http`, `Concatenate-Files`, `Create-ZipFile`, `Rename-File`, `Transfer-Files`, `Sign-Exe`, `Collect-RpmPackages`.
- CodeLens reference counts above module declarations linking to VS Code reference peek (`otterscript.codeLens.enable`, default `true`).
- `ReferenceProvider` for module declarations and call sites (Shift+F12).
- `DocumentSymbolProvider` for Outline panel, breadcrumbs, and Ctrl+Shift+O.

### Fixed

- Fixed `set` and `call` keywords not highlighted when lowercase (missing grammar `beginCaptures`).
- Fixed cross-line block comment and swim-string detection for module navigation.
- Fixed stale diagnostics after quick-fix execution.
- Fixed module reference scans to ignore strings, comments, and swim-strings.
- Fixed module info cache growth on document close.
- Fixed pending diagnostic timer not cleared on deactivation.

### Changed

- Internal code quality improvements: scanner consolidation, module navigation helpers, cached module analysis, and shared utilities.

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
