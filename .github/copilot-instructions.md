# Copilot instructions: OtterScript VS Code extension

VS Code extension for Inedo's OtterScript: plain CommonJS JavaScript typed with JSDoc, bundled by esbuild (`scripts/build.js`) into `dist/extension.js` (desktop) and `dist/web/extension.js` (VS Code for the Web). No runtime dependencies.

## Review checklist

Flag a pull request that breaks any of these:

- **Compatibility:** no `vscode` API newer than 1.85, no Node API newer than 18. `src/` uses no Node built-ins (`fs`, `path`, `process`, `Buffer`) and no npm packages.
- **Generated files are never edited by hand:** `src/inedo-reference-data.js`, `src/adaptivecard-data.js`, the grammar's name lists. They change through `npm run update:*`.
- **A new diagnostic code** goes in `DIAGNOSTIC_CODES`, the `otterscript.diagnostics.rules` schema in `package.json` and the README table.
- **Diagnostics never flag valid code.** Hint for guesses, Warning for suspicious code, Error only for code that can't run.
- **Quick fixes** are preferred (applied by Fix All) only when they aren't a guess.
- **OtterScript:** variable, module and argument names compare case-insensitively; an output argument is `Name => $variable`; operations are looked up with `lookupOperation(name, namespace)`.
- **Script text** is read through `maskNonCodeSpans` (`src/scanner.js`), which blanks strings and comments but keeps offsets. `scanner.js` never requires `vscode`.
- **Providers** return `[]` or `null` and never throw. `activate()` stays light; disposables go in `context.subscriptions`.
- **Tests:** unit tests in `test/unit/<module>.test.js`; behavior in VS Code in `test/integration/`; `test/web/` for what the browser bundle needs. A bug fix comes with a test that fails without it.
- **CHANGELOG:** user-visible changes only, under `[Unreleased]`. **README** covers new settings, diagnostics and features.
- **Code:** JSDoc with matching `@param`/`@returns` on every function; comments say why.
- **Workflows:** actions pinned to a commit SHA with a version comment, least `permissions`, secrets only on the steps that use them.

## Layout

- `src/extension.js`: activation. `src/providers/`: one module per feature group.
- `src/diagnostics.js`, `src/adaptivecard.js`: the checks.
- `src/scanner.js`: text scanning. `src/document-index.js`: per-document caches.
- `src/language-data.js`: hand-written docs, which win over the generated reference (`src/inedo-reference.js`).
- `src/helpers.js`: settings, logging, hover and completion builders.

## Validation

`npm run check` (lint, types, generated data, CHANGELOG, bundle contents, unit tests) must pass. Sanity also runs the integration tests (VS Code 1.85 and stable) and the web tests.
