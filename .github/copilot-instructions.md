# GitHub Copilot Instructions for OtterScript Language Extension

## Purpose

This repository is a VS Code extension for OtterScript (a product by Inedo) with syntax highlighting, snippets, completions, hover, signature help and quick-fixes.

Not affiliated with or endorsed by [Inedo](https://inedo.com/).

Use these instructions to produce safe (does not introduce security vulnerabilities or unintended breaking behavior), minimal, reviewable changes.

If a user request is invalid or unsupported, explain why and propose the closest safe alternative.

## Priority Order

Safety and platform policies always override all other instructions.

After that, when instructions conflict, follow this order:

1. User request for the current task
2. This file
3. Existing repository conventions and style

If repository conventions or style are unclear or inconsistent, default to the rules in this file.

## Hard Rules (Always Follow)

- Use `const`/`let`; never use `var`.
- Add complete JSDoc for all functions in `.js` files
  - Repo uses `// @ts-check` at top of each file
  - Also utilize parameters like @private, @readonly and @examples when applicable.
- Prefer early returns for validation.
- Use `Object.freeze()` for constant language-data objects.
- Completion providers return `[]` when no suggestions.
- Hover/signature providers return `null` when not applicable.
- Do not hardcode extension version; use `context.extension.packageJSON.version`.
- Keep edits focused. Do not do unrelated refactors or formatting churn.
- Preserve behavior unless the task explicitly requires behavior changes.

## File Map

- `src/extension.js`: extension activation and provider wiring.
- `src/language-data.js`: OtterScript docs model used by IntelliSense including snippets.
- `src/helpers.js`: pure helper utilities.
- `syntaxes/otterscript.tmLanguage.json`: TextMate grammar.
- `snippets/otterscript.json`: VS Code snippets.
- `language-configuration.json`: comments/brackets/indentation rules.
- `test/sample.otter`: quick sanity file for manual checks.

## File-Specific Rules

### `src/language-data.js`

- Keep language entries aligned with official Inedo docs.
- Verify function/variable names before adding or changing entries.
- Keep `DocEntry` shape consistent:

```javascript
/**
 * @typedef {Object} DocEntry
 * @property {string} name
 * @property {string} description
 * @property {string=} signature
 * @property {string=} snippet
 * @property {string=} documentation
 */
```

### `snippets/otterscript.json`

- File must be a valid root JSON object for snippets.
- Each snippet needs valid `prefix`, `body`, and `description` as appropriate.
- Avoid malformed JSON and schema/type mismatches.
- If JSON is malformed or incomplete, return a clear error describing the issue and suggest the minimal correction needed.

### `syntaxes/otterscript.tmLanguage.json`

- Keep scopes consistent with existing grammar naming.
- Validate rule precedence with representative OtterScript examples.

### Provider behavior

- Completion provider: return array (`[]` when empty), never `null`.
- Hover/signature providers: return `null` when not applicable.
- Diagnostic severity:
  - Error: runtime-breaking issues (for example missing `$`, unbalanced braces)
  - Warning: suspicious but potentially valid patterns

## Sources of Truth

For language semantics and syntax, verify against:

- <https://docs.inedo.com/docs/executionengine/otterscript/overview>
- <https://docs.inedo.com/docs/executionengine/reference/formal-specification>
- <https://docs.inedo.com/docs/executionengine/reference/otterscript-formal-grammar>
- <https://docs.inedo.com/docs/executionengine/otterscript/strings-and-literals>

## Definition of Done

Before finishing any code change, do all applicable checks:

1. Run `npm run lint`.
2. Run `npm run package` for full validation when behavior changed.
3. Manual smoke test in Extension Development Host (`F5`) when provider/grammar/snippet behavior changed:
   - `$` completion appears
   - `@` vector completion appears
   - Hover shows docs
   - `if condition =` warns about missing `$`
   - `>>` auto-closes swim string
4. Confirm no unrelated files were modified.

## Common Failure Modes

- Returning `null` from completion providers.
- Returning `[]` from hover/signature providers when `null` is expected.
- Incomplete JSDoc that breaks `@ts-check` quality.
- Language-data names not matching official docs.
- Snippet JSON schema/type problems (root not object, malformed structure).
- Grammar changes that unintentionally shadow existing patterns.

## Git, Commit, and PR Requirements

### Conventional Commit format

`<type>(<scope>): <description>`

Types:

- `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`

Common scopes:

- `completion`, `hover`, `signature`, `grammar`, `snippets`, `language`, `diagnostics`, `config`, `deps`

Breaking changes:

- Use `!` in type (`feat!`) or `BREAKING CHANGE:` footer.

### PR expectations

- PR title follows Conventional Commits format.
- Keep changes scoped and reviewable.
- Ensure CI checks pass.
- Require maintainer approval before merge.

## Release/Version Rules

When bumping versions:

- Update `CHANGELOG.md` (Keep a Changelog format).
- Update `README.md` if behavior/features changed.
- Update versions in `package.json` and `package-lock.json` with:

```bash
npm version [<newversion> | major | minor | patch | premajor | preminor | prepatch | prerelease [--preid=<prerelease-id>]] --no-git-tag-version
```

- If the working tree is dirty and version bump is intentional, `--force` may be required.
- Re-run package validation before release.

## Delivery Format for Copilot Responses

When returning results for a code task, include:

1. What changed
2. Files touched
3. Validation performed (commands and outcome)
4. Risks or follow-up checks (if any)
5. Supply recommended conventional commit message

## VS Code Extension Best Practices (Review Guidelines)

When proposing changes, ensure:

- Code runs in the **extension host (Node.js)**, not a browser:
  - Do not use `window`, `document`, `localStorage`, or DOM APIs.
- Activation path must stay lightweight:
  - Avoid heavy computation or I/O during `activate()`.
- Providers must be defensive:
  - Never throw from completion/hover/diagnostics providers.
- Do not block the event loop:
  - Avoid synchronous filesystem or CPU-heavy work on hot paths.
- Prefer VS Code APIs over custom implementations:
  - Use `vscode.window`, `vscode.workspace`, `vscode.languages`.
- Dispose resources correctly:
  - All disposables must be registered via `context.subscriptions`.
- If a change would slow startup, break IntelliSense, or behave differently in the Extension Host, it needs explicit justification.
