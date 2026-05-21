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
- Package extension: `npm run package`

No dedicated `npm test` script exists; rely on lint/package/CI checks and manual Extension Host smoke tests.

## Architecture Map

- `src/extension.js`: activation and provider wiring
- `src/language-data.js`: language docs model for IntelliSense/snippets
- `src/diagnostics.js`: diagnostic analysis/rules
- `src/helpers.js`: shared pure utilities
- `syntaxes/otterscript.tmLanguage.json`: TextMate grammar
- `snippets/otterscript.json`: snippets (JSONC-valid)
- `language-configuration.json`: comments/brackets/indent rules

## Hard Rules

- Use `const`/`let`; never use `var`.
- Keep edits focused; avoid unrelated refactors or formatting churn.
- Preserve existing behavior unless task explicitly requires change.
- Add complete JSDoc for all functions in `.js` files (`// @ts-check` is enforced style).
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

- https://docs.inedo.com/docs/executionengine/otterscript/overview
- https://docs.inedo.com/docs/executionengine/reference/formal-specification
- https://docs.inedo.com/docs/executionengine/reference/otterscript-formal-grammar
- https://docs.inedo.com/docs/executionengine/otterscript/strings-and-literals

## Done Checklist

Run these when applicable:

1. `npm run lint`
2. `npm run check:js`
3. `npm run package` when behavior changes
4. Manual smoke test (`F5`) when provider/grammar/snippet behavior changes:
   - `$` completion appears
   - `@` vector completion appears
   - Hover shows docs
   - `if condition =` warns about missing `$`
   - `>>` auto-closes swim string
5. Confirm no unrelated files were modified

Before recommending or finalizing changes, require both `npm run lint` and `npm run check:js` to pass.

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
