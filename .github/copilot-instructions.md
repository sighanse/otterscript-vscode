# Copilot instructions: OtterScript VS Code extension

A VS Code extension for Inedo's OtterScript, in plain CommonJS JavaScript typed with JSDoc (`// @ts-check`), bundled by esbuild into `dist/extension.js` (desktop) and `dist/web/extension.js` (VS Code for the Web). No runtime dependencies.

## Review checklist

Flag a pull request that breaks any of these:

- **Compatibility:** VS Code 1.85 (`engines.vscode`) and Node 18. No `vscode` API newer than 1.85, no Node API newer than 18. VS Code for the Web: `src/` uses no Node built-ins (`fs`, `path`, `process`, `Buffer`) and no npm packages.
- **Generated files are never edited by hand:** `src/inedo-reference-data.js`, `src/adaptivecard-data.js` and the name lists in `syntaxes/otterscript.tmLanguage.json`. They change through `scripts/` and `npm run update:*`.
- **A new diagnostic code** goes in `DIAGNOSTIC_CODES` (`src/diagnostics.js`), the `otterscript.diagnostics.rules` schema in `package.json` and the README table.
- **Diagnostics never flag valid code:** missing a problem is better. Hint for guesses (operations accept undocumented aliases), Warning for suspicious code, Error only for code that can't run.
- **Strings and comments:** code that reads script text masks them first (`maskNonCodeSpans` in `src/scanner.js`), keeping lengths so offsets stay valid.
- **`src/scanner.js` never requires `vscode`.**
- **Providers:** completion returns `[]`, hover and signature help return `null`, and nothing throws. `activate()` stays light; disposables go in `context.subscriptions`.
- **Language data:** names and parameters match Inedo's reference. Hand-written entries in `src/language-data.js` win over generated ones; operations are looked up with `lookupOperation(name, namespace)`.
- **Tests:** pure logic in `test/unit/<module>.test.js`, named after the module it tests; provider behavior in `test/integration/*.test.js`. A bug fix comes with a test that fails without it.
- **CHANGELOG:** only user-visible changes, under `[Unreleased]`; no dependency, tooling, test, CI or refactoring entries.
- **README** covers new settings, diagnostics and features.
- **Code:** JSDoc on every function, with `@param`/`@returns` matching; `const`/`let`, never `var`; LF line endings.
- **Workflows:** actions pinned to a commit SHA with a version comment, least `permissions`, secrets only on the steps that use them.

## Layout

- `src/extension.js`: activation and wiring. `src/providers/`: completion, hover, signature help, inlay hints, code actions, navigation, workspace symbols.
- `src/diagnostics.js`: the checks. `src/adaptivecard.js`: Adaptive Card checks.
- `src/scanner.js`: text primitives. `src/document-index.js`: per-document caches.
- `src/language-data.js`: docs tables, merged with the generated reference (expanded by `src/inedo-reference.js`). `src/namespaces.js`: known namespaces.
- `src/helpers.js`: settings, logging, hover and completion builders.
- Unit tests run against `test/vscode-stub.js`. Integration tests run in real VS Code 1.85 and stable (`.vscode-test.mjs`).

## Validation

`npm run check` (lint, type check, generated-data sync, unit tests) must pass; `npm run test:integration` runs when provider behavior changes. Details are in CONTRIBUTING.md.

## OtterScript references

- <https://docs.inedo.com/docs/executionengine/otterscript/overview>
- <https://docs.inedo.com/docs/executionengine/reference/otterscript-formal-grammar>
