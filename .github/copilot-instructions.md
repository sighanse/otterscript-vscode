# GitHub Copilot Instructions for OtterScript Language Extension

## Purpose

This repository is a VS Code extension for OtterScript (Inedo) with syntax highlighting, snippets, completion, hover, signature help, diagnostics, and quick fixes.

Use these instructions to make minimal, safe, reviewable changes.

## Priority

If priorities conflict, always follow the highest item in this list. Safety and platform policy always take precedence over user requests.

1. Safety and platform policy
2. User request for current task
3. This file
4. Existing repository conventions

## Start Here

- Product and feature scope: [README.md](../README.md)
- Contribution basics: [CONTRIBUTING.md](../CONTRIBUTING.md)
- CI validation behavior: [sanity.yml](workflows/sanity.yml)
- Build/package workflow: [build.yml](workflows/build.yml)
- Release workflow: [publish.yml](workflows/publish.yml)

## Quick Commands

- Install deps: `npm ci --no-audit --no-fund`
- Lint local: `npm run lint`
- Lint strict (CI parity): `npm run lint:ci`
- JS + JSDoc type check: `npm run check:js`
- Grammar / language-data sync: `npm run check:lang`
- Unit tests: `npm test` (`node:test`, `test/unit/*.test.js`)
- Integration tests: `npm run test:integration` (real VS Code via `@vscode/test-cli`, `test/integration/*.test.js`; add `-- --label minimum` or `-- --label stable` for one version)
- Everything (CI parity): `npm run check` (lint + type check + grammar sync + unit tests)
- Package extension: `npm run package`

`npm test` runs the pure-logic unit suite (the `src/scanner.js` scanner plus the
diagnostic and module-navigation helpers) against a small `vscode` module stub
(`test/vscode-stub.js`). It is a blocking step in the Sanity workflow.

`npm run test:integration` loads the extension in real VS Code -- both the
minimum version in `engines.vscode` (1.85.0) and current stable, configured in
`.vscode-test.mjs` -- opens `test/integration/workspace/` and the `test/*.otter`
samples, and calls VS Code's `vscode.execute*Provider` commands to check hover,
completion, signature help, diagnostics, the rules setting, quick fixes, Fix All,
navigation, folding and highlighting. The first run downloads VS Code into
`.vscode-test/`. It is not part of `npm run check` (too slow for the pre-commit
hook) but is a blocking step in the Sanity workflow. Grammar colours, snippets
and editor UI (lightbulb, auto-closing) still need a manual `F5` check.

`npm run check:lang` (script: [scripts/check-language-sync.js](../scripts/check-language-sync.js)) fails when a scalar/vector/map function or operation is added to `src/language-data.js` without updating the matching regex alternation in `syntaxes/otterscript.tmLanguage.json` (or vice versa), or when an entry carries a `namespace` outside the `NAMESPACES` allowlist. It runs as a blocking step in the Sanity workflow.

## Architecture Map

- `src/extension.js`: activation and provider wiring
- `src/language-data.js`: language docs model for IntelliSense/snippets; also exports the `NAMESPACES` allowlist
- `src/diagnostics.js`: diagnostic analysis/rules; `DIAGNOSTIC_CODES` lists every code, and must match the `otterscript.diagnostics.rules` schema in `package.json` (a unit test checks this)
- `src/adaptivecard.js`: best-effort Adaptive Card checks for JSON bodies in text templates; its type list lives in `src/adaptivecard-data.js`
- `src/helpers.js`: VS Code-facing helpers (builds `vscode.*` objects); re-exports the `src/scanner.js` members its callers need
- `src/scanner.js`: pure, `vscode`-free text primitives (non-code masking, string/comment detection, `<% %>` template-tag masking, module-name scan, variable-occurrence scan, arg-index)
- `test/unit/*.test.js`: `node:test` unit suite; `test/vscode-stub.js` is the `vscode` module stub
- `test/integration/*.test.js`: mocha suite run inside real VS Code by `vscode-test` (config: `.vscode-test.mjs`; fixture workspace: `test/integration/workspace/`)
- `syntaxes/otterscript.tmLanguage.json`: TextMate grammar
- `snippets/otterscript.json`: snippets (JSONC-valid)
- `language-configuration.json`: comments/brackets/indent rules

## Hard Rules

- Use `const`/`let`; never use `var`.
- Keep edits focused; avoid unrelated refactors or formatting churn.
- Preserve existing behavior unless task explicitly requires change.
- Add complete JSDoc for all functions in `.js` files (`// @ts-check` is enforced style). ESLint (`eslint-plugin-jsdoc`) requires a JSDoc block on every function declaration outside `test/`, and checks that `@param` / `@returns` match the code everywhere.
- Prefer early returns for validation.
- Use `Object.freeze()` for constant language-data objects.
- Do not hardcode extension version; use `context.extension.packageJSON.version`.

## Provider Contracts

- Completion providers: return `[]` when no suggestions (never `null`).
- Hover/signature providers: return `null` when not applicable.
- Diagnostics severity:
  - Error: runtime-breaking issues (for example missing `$`, unbalanced braces)
  - Warning: suspicious but potentially valid patterns

## VS Code Extension Constraints

- Run in extension host (Node.js), not browser APIs (`window`, `document`, `localStorage`).
- Keep `activate()` lightweight; avoid heavy startup work.
- Providers must fail safely and avoid throwing.
- Avoid blocking event loop on hot paths.
- Register disposables via `context.subscriptions`.

## Language/Content Accuracy

For OtterScript semantics, verify against Inedo docs before changing language intelligence data:

- <https://docs.inedo.com/docs/executionengine/otterscript/overview>
- <https://docs.inedo.com/docs/executionengine/reference/formal-specification>
- <https://docs.inedo.com/docs/executionengine/reference/otterscript-formal-grammar>
- <https://docs.inedo.com/docs/executionengine/otterscript/strings-and-literals>

## Done Checklist

Run these when applicable:

1. `npm run check` (lint + JSDoc type check + grammar/language-data sync + unit tests)
2. Add or update `test/unit/*.test.js` when changing pure logic (`src/scanner.js`, diagnostic or module-navigation helpers)
3. `npm run test:integration` when provider behavior changes (hover, completion, signature help, diagnostics wiring, quick fixes, navigation, highlighting); add or update `test/integration/*.test.js` for new provider behavior
4. `npm run package` when behavior changes
5. Manual smoke test (`F5`) for what the integration tests can't see:
   - Syntax highlighting colours look right (grammar changes)
   - Snippets expand as expected
   - The lightbulb shows quick fixes on a diagnostic
   - `>>` auto-closes swim string
6. Confirm no unrelated files were modified

Before recommending or finalizing changes, require `npm run check` to pass.

## Common Failure Modes

- Completion providers accidentally return `null`.
- Hover/signature providers return `[]` instead of `null`.
- Incomplete JSDoc breaks `@ts-check` quality.
- `src/language-data.js` names diverge from official docs.
- Snippet JSONC shape/parsing issues.
- Grammar rule precedence changes unintentionally shadow existing matches.
- CRLF slips into source files (CI enforces LF).

## Delivery Expectations

When summarizing code changes, include:

1. What changed
2. Files touched
3. Validation performed and outcomes
4. Risks or follow-up checks
5. Recommended conventional commit message (`<type>(<scope>): <description>`)
