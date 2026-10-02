# Changelog

## [Unreleased]

### Added

- Hover, completion and signature help for every function and operation in Inedo's Otter and BuildMaster reference — about 100 operations and 80 functions more than before, such as `Extract-ZipFile`, `Replace-Text`, `IIS::Ensure-AppPool`, `Git::Checkout-Code`, `PSCall`, `%MapAdd` and `$PSCredential` — with their arguments and the products that have them, and syntax highlighting for their names
- ProGet notifier variables `$EventName`, `$ProjectName` and `$ReleaseNumber`
- Completion of the variables the file uses: after `$`, `@` or `%`, the file's own variables (`set $myVar`, `foreach %item`, module parameters, ...) are listed first, with the line where they're assigned
- Completion of module names after `call`: the file's own modules first, then those declared in other OtterScript files in the workspace
- Go to Definition (F12) on a variable goes to where the file assigns it; with several assignments, VS Code lists them all
- Go to Definition on `call MyModule` also finds a module declared in another OtterScript file in the workspace
- Rename (F2) for variables and modules. A variable is renamed everywhere in the file, including in strings, where OtterScript expands it; a new name with spaces gets the braces it needs (`${my var}`). A module is renamed with every `call` to it, in other workspace files too. Invalid names and names already in use are refused
- Find All References (Shift+F12) on a module also lists the calls in other OtterScript files in the workspace. A `call` counts for the module its own file declares, or else for the one workspace file that declares that name; when several files declare it, only the current file is searched
- Completion inside an Adaptive Card in a text template, on typing the opening `"` of a value (or Ctrl+Space inside it): `"type"` values that fit where the object is (actions in `actions`, `Column` in `columns`, ...) and that the card's `"version"` supports, a property's allowed values (`"weight": "` → `default`, `lighter`, `bolder`), and the card's element ids as `Action.ToggleVisibility` targets
- `adaptivecard-unknown-target` diagnostic: an `Action.ToggleVisibility` target that no element in the card has as its `"id"` — the button would silently do nothing — with a quick fix to the closest id (`"detials"` → `"details"`)
- `adaptivecard-duplicate-id` diagnostic: an `"id"` that another element in the same card already has, so a toggle reaches only one of them. Ids in alternative `<% if %>` / `<% else %>` branches aren't flagged
- `otterscript.product` setting (`any`, `ProGet`, `Otter` or `BuildMaster`): completion leaves out the functions, variables and operations the chosen product doesn't have, based on Inedo's Otter and BuildMaster reference (what both have counts as the core engine, which ProGet runs too). Hover notes it when a function, variable or operation isn't in the chosen product
- Argument names in operation calls: inside `Copy-Files(` (after the `(` or a `,`), completion lists the operation's arguments that aren't given yet, required ones first, with their format and description; hovering an argument name (`To:`) shows what it is. An operation's hover now lists its arguments too
- Hover says when a function works with every sigil (`$FromJson`, `@FromJson`, `%FromJson`), where the sigil picks what it returns. The `@` and `%` forms of `$Eval` and `$GetVariableValue` now have the same full documentation as their `$` form

- `unknown-map-function` diagnostic: an unknown `%Name(...)` function, as `$Name(...)` and `@Name(...)` calls already are
- `too-few-arguments` diagnostic: a function call with fewer arguments than the function requires (`$Substring($x)`), based on the `[optional]` parameters in its signature and the most lenient of its forms in Inedo's products

### Changed

- Function parameter names in hover, signature help and completion are now the ones in Inedo's reference, such as `$Substring(Text, Offset, [Length])` (was `text, startIndex, [length]`) or `$RegexReplace(Text, MatchExpression, ReplaceWith)`

### Fixed

- Operations and functions that exist in Otter or BuildMaster but weren't documented here, such as `Extract-ZipFile` or `Ensure-DscResource`, were flagged as unknown
- `$Trim` accepts the characters to trim (`$Trim($x, "-")`), as `$TrimStart` and `$TrimEnd` already did; it was flagged as too many arguments
- `$PackageHash` and `$PackageProperty` mixed ProGet's and BuildMaster's forms. Hover now shows ProGet's (`$PackageHash([format], [algorithm])`, `$PackageProperty(name, [default])`) with BuildMaster's below it, and a three-argument BuildMaster `$PackageProperty(...)` is no longer flagged as too many arguments
- `unknown-namespace` flagged real namespaces of Inedo's extensions, such as `GitHub::`, `Jira::`, `NuGet::`, `MSBuild::`, `Kubernetes::` or `AzureDevOps::`. Every namespace declared in Inedo's public extensions is now known, and an operation behind a namespace whose operations the extension doesn't document yet (`GitHub::Ensure-Release`) is no longer flagged as unknown either

### Removed

- `$Base64Encode` and `$Base64Decode`, which don't exist in Inedo's products; using them is now flagged as an unknown function

## [0.5.0] - 2026-10-01

### Added

- Highlight all occurrences for variables and modules: clicking `$x`, `@list`, `%map` (or the braced `${x}` / `@{list}` forms, whose names may contain spaces) highlights every reference in the file — including inside strings, where OtterScript expands them, but not in comments — and marks declarations and assignments as writes. Clicking a module name highlights its declaration and every `call` to it
- `otterscript.diagnostics.rules` setting to turn individual diagnostics off or change their severity, keyed by diagnostic code; every diagnostic also gets a **Turn off '&lt;code&gt;' diagnostics** quick fix. Unbalanced-symbol and unmatched/unclosed `<% %>` diagnostics now have codes too (`unbalanced-symbol`, `template-unexpected-close`, `template-unclosed`)
- `teamscard` snippet: a complete text-template body for a Teams incoming webhook or Workflows trigger — the message envelope with the right `contentType`, an Adaptive Card whose values come from OtterScript through `$ToJson(...)`, and a `<% foreach %>` loop that adds fact rows while keeping the JSON valid
- `adaptivecard-version-too-low` diagnostic: an Adaptive Card element, action or property that needs a newer card version than the card's declared `"version"` (e.g. a 1.5 `Table` or `"rtl"`, or an input's 1.3 `"label"`, in a 1.2 card) is flagged, unless it or an enclosing element has a `"fallback"`. The quick fix **Change card version to X** raises the version to the highest one the card needs; when that is above `otterscript.adaptiveCards.maxVersion`, the fix says so and **Fix All** leaves it to you
- `adaptivecard-invalid-value` diagnostic: an Adaptive Card property value that the property doesn't allow, such as `"weight": "bold"` or `"color": "red"`, with a quick fix to the closest allowed value (`bolder`). Values are compared case-insensitively, as hosts do, and values filled in by OtterScript are skipped
- `adaptivecard-version-too-high` diagnostic and `otterscript.adaptiveCards.maxVersion` setting (default `1.6`, what Microsoft Teams supports): a card whose `"version"` is newer than the host supports is flagged, since the host would show its `fallbackText` instead
- `adaptivecard-templating-keyword` diagnostic: an Adaptive Card Templating key such as `"$data"` or `"$when"`, which OtterScript expands as its own variable in a text template, with a quick fix to escape it (`` "`$data" ``)
- Teams message checks, when the card is sent as an attachment of a `"type": "message"` body: `adaptivecard-content-type` flags a missing or wrong `"contentType"` (with a quick fix), and `adaptivecard-webhook-submit` flags `Action.Submit`, which Teams incoming webhooks and Workflows don't support

### Changed

- The Adaptive Card checks now cover the whole Adaptive Card 1.6 schema plus the Teams-only elements it leaves out, such as `Badge`, `Icon`, `CodeBlock` and the charts, which were previously flagged as unknown types
- The Adaptive Card checks are much faster on large cards: each card is now parsed once per check instead of being re-scanned for every lookup (a 2,000-element card went from about 1 s to about 10 ms)
- Hover, completion and highlighting no longer rescan a large file from the top on every request

### Fixed

- The `assignment-in-condition` and `invalid-operator` checks looked at the whole `if` line, so `if $Debug { set $Level = 2; }` was flagged, and the quick fix (also run by **Fix All**) turned the body's `=` into `==`. Only the condition is checked now
- **Replace 'for' with 'foreach'** is no longer offered for a counting loop (`for $i = 1 to 10`), where it produced `foreach $i = 1 to 10`, which is still invalid; the warning stays
- `unknown-operation` flagged dashed names that aren't operations — variables (`$my-var`), map keys and parameter names (`my-key: 1`), module names (`call My-Module`) and arguments (`Log-Information My-Arg`). Only the first word of a statement is checked now
- `incorrect-for-usage` on a capitalized `For` was placed at column -1, and a loop over a dashed name (`for $item-name in @list`) wasn't flagged
- Completion after `Core::` offered no operations; it now offers the built-in ones
- **Fix All** right after typing could apply fixes at positions from before the edit; it now re-checks the document first
- Variable names now follow Inedo's grammar: syntax highlighting no longer runs on past a plain name into the following words (`"Deploying $Name to $Server"` colored "$Name to " as one variable; only a braced `${my var}` may contain spaces). Indexed expressions such as `@list[1]` and `%map.key` now get their own color
- Signature help no longer disappears once an earlier argument contains a nested call or a parenthesis inside a string (e.g. `$Substring($Trim($x), …`), and no longer shows one empty parameter for functions that take none, such as `$ServerName()`
- Hovering `$constructor`, `$toString` or similar names showed a bogus "Object" entry
- The `#region` / `#endregion` hover appeared for the text anywhere on a line, even inside a string; it now appears only at the start of a line, where the marker folds. Its text now says it's an editor convention (a comment to OtterScript), and Ctrl+Space no longer lists it among the keywords (the `region` snippet still inserts it)
- Snippets that insert an OtterScript `$` literally: the `Execute-PowerShell` completion lost `$_` and a `}` (inserting `Where-Object { .Status -eq "Running"  | Out-String}`), and `Acquire-Server` lost `$AcquiredServerName`. The `ifMatchesRegex`, `joinIntoString`, `ifexists` and `ifdirexists` snippets had an extra tab stop on the function name, and caused VS Code's "snippets very likely confuse snippet-variables and snippet-placeholders" warning
- Go to Symbol in Workspace: modules added, renamed or removed in an open document now show up as you type, not only after saving; read-only views of another version of a file — the old side of a Git diff, a pull-request review — no longer add duplicate modules (or get diagnostics); closing a file without saving no longer leaves its unsaved modules in the list; and an untitled document's modules leave it when the document closes
- Adaptive Card checks: a `"version"` key inside a nested object (such as an action's `data` payload) no longer hides a card's missing `"version"`; `TextRun` inlines in a `RichTextBlock` and the free-form `"type"` of `Authentication` sign-in buttons are no longer flagged as unknown types

## [0.4.0] - 2026-09-27

### Added

- Template-aware diagnostics for `<% %>` text-template tags: malformed/unbalanced tags, `<% end %>` where `<% } %>` is required, a block opener (`if`/`foreach`/`while`/`for server|role|directory|deployable`) missing its `{` (including tags spanning multiple lines), and a `<% %>` tag mixed with an unclosed OtterScript expression
- Diagnostics for `$` expressions embedded directly in a text template's literal output (e.g. `$ToJson(...)` in a webhook body), not just code inside `<% %>`
- `too-many-arguments` diagnostic for a call that exceeds a function's documented fixed argument count
- Map-function support for `%FromJson(...)` and `%ListItem(...)` (the map-returning form of these sigil-polymorphic functions): highlighting, hover, completion after `%`, signature help, and the too-many-arguments check
- Adaptive Card checks for Teams webhook bodies, automatically triggered when a literal `"type": "AdaptiveCard"` object is found: flags an unrecognized `"type"` value or a missing `"version"` (free-form `data` / `msteams` payloads, such as Teams mentions, are not checked)

### Changed

- Corrected numerous hover-doc inaccuracies against Inedo's own docs (`$PackageHash`, `$Increment`/`$Decrement`, `$Substring`, `$Coalesce`, `$Compare`, `$FromJson`/`$ListItem` sigil-based return shape, `$PackageEvent` event codes, `Post-Http`/`Get-Http`/`Upload-Http`'s `Method` values, `foreach`'s loop-variable sigil rules, and several keyword docs); added missing `$GetVariableValue` and `$IsSimulation` entries
- Fixed example code throughout the docs that used invalid `$item.Property` dot-indexing on a map-bound loop variable — corrected to `%item.Property`
- The `foreachaffected` and `foreachapikey` snippets now bind the loop variable as a map (`%package`, `%apiKey`), since those vectors hold maps

### Removed

- Unused `otterscript.errorBackground` / `otterscript.warningBackground` theme colors (they were never applied to anything)

### Fixed

- Hovering anywhere on a `#region` / `#endregion` line no longer shows the directive's documentation — only hovering the directive itself does
- Duplicate map keys are now also detected in a map nested inside another map (e.g. `%( x: %( a: 1, a: 2 ) )`)
- `@FromJson(...)` and `@ListItem(...)` are no longer flagged as unknown vector functions, and now get highlighting, hover, completion, and signature help

## [0.3.0] - 2026-09-09

### Added

- Namespace metadata for operations and functions that declare a `[ScriptNamespace]` in the Inedo extension source (e.g. `Files`, `HTTP`, `Windows`, `Linux`); the namespace shows on hover. Core engine built-ins (`$ToJson`, `@Split`, `Exec`, …) carry no namespace — they are the optional `Core::` namespace and there is no `InedoCore::` prefix
- Signature help shows operations in their qualified `Namespace::Operation` form
- `unknown-namespace` diagnostic for a `Namespace::` qualifier that is not a known OtterScript namespace, with a quick-fix to the closest match; a missing prefix is never flagged (it is optional)
- Workspace symbol provider — `Ctrl+T` ("Go to Symbol in Workspace") lists every `module` declaration across all `.otter`/`.oscript` files, backed by an index kept fresh with a file-system watcher and from open documents
- `otterscript.workspaceSymbols.enable` setting (default `true`)
- Unit test suite (`node:test`), run by `npm test` and as a blocking step in the Sanity CI workflow; `npm run check` now runs it as well
- `.vscode/launch.json` so F5 opens this repo as the Extension Development Host workspace

### Changed

- Namespace values in `src/language-data.js` are validated against a fixed allowlist by `validateDocs` and the `check:lang` gate
- Extracted the vscode-free text-scanning primitives into `src/scanner.js` so they can be unit tested without a VS Code stub
- Added `@types/node` to devDependencies (for the test suite)

### Fixed

- The "unknown operation" diagnostic no longer also fires on the operation half of a `Namespace::Operation` when the namespace itself is unknown

## [0.2.6] - 2026-09-02

### Added

- Preparation for namespace support in the language
- Re-run diagnostics when a document is saved, for an immediate refresh instead of waiting for the change-debounce
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
