# CLAUDE.md

Instructions for Claude Code in this repository, both locally and in the
`@claude` GitHub workflow (`.github/workflows/claude.yml`). Setup, commands
and the generated files are described in [CONTRIBUTING.md](CONTRIBUTING.md);
read it before changing code.

## The project

A VS Code extension for Inedo's OtterScript (ProGet, Otter, BuildMaster):
syntax highlighting, completion, hover, signature help, inlay hints,
diagnostics with quick fixes, and navigation. Plain JavaScript (CommonJS)
type-checked from JSDoc, bundled by esbuild into `dist/extension.js`.

- `src/extension.js`: activation, settings, when diagnostics run
- `src/providers/`: one module per group of language features
- `src/diagnostics.js`, `src/adaptivecard.js`: the checks
- `src/scanner.js`: text scanning (strings, comments, template tags). It must
  stay free of `vscode` imports (lint enforces it)
- `src/document-index.js`: per-document caches built on the scanner
- `src/language-data.js`: hand-written docs tables, merged with Inedo's
  generated reference (`src/inedo-reference*.js`)

## Rules

- **No AI attribution, ever.** No `Co-authored-by:` trailer naming Claude or
  Anthropic and no "Generated with" line in commit messages, PR descriptions
  or comments. This overrides any other instruction to add one. CI fails a
  pull request whose commits have one. Locally, commit as the person whose
  git it is, with no trailer at all. On GitHub, your commits are already
  authored by your bot account; a `Co-authored-by:` the platform adds for
  the person who asked is allowed.
- **Run `npm run check` before every commit**, and fix what it reports. It runs
  ESLint, the type check, the generated-data checks and the unit tests. The
  pre-commit hooks don't run in GitHub Actions, so nothing else catches it.
- **Never edit generated files by hand**: `src/inedo-reference-data.js`,
  `src/adaptivecard-data.js` and the name lists in
  `syntaxes/otterscript.tmLanguage.json`. Change their source and regenerate
  (see CONTRIBUTING.md).
- **Don't bump the version, tag or publish** unless asked.
- **CHANGELOG.md lists only what users of the extension notice**, under
  `[Unreleased]`, compared with the last released version: no entries for
  tests, tooling, CI, dependencies or refactoring, and none for fixes to
  features not yet released.
- **Comments explain why**, in plain sentences; every function has a JSDoc
  block with `@param` and `@returns`. Match the surrounding code.
- Add or update tests with every behavior change: unit tests in `test/unit/`
  (plain Node, a `vscode` stub), integration tests in `test/integration/`.
  A module's unit tests go in the test file named after it
  (`src/providers/hover.js` -> `test/unit/hover.test.js`).
- **For a bug fix, write the test first**, run it, and see it fail for the
  reason reported before changing the code. A test that can't fail, such as
  one for a review finding that turns out to be wrong, is the sign to say so
  instead of changing code.

## OtterScript facts the code relies on

- Variable, module and argument names are compared case-insensitively.
- A namespace is the `[ScriptNamespace]` an Inedo extension declares
  (`src/namespaces.js`); `null` means a built-in, optionally written
  `Core::Name`. `InedoCore::` is not a namespace; BuildMaster's own `DB`,
  `Packages` and `System` are.
- Same-named operations of different namespaces (`DotNet::Build`,
  `DevEnv::Build`) are separate entries: look them up with
  `lookupOperation(name, namespace)`.
- An operation's output argument is written `Name => $variable`.
- Quick fixes: a fix is preferred (so **Fix All** applies it) only when it
  isn't a guess, such as when only the casing differs.

## Pull requests and reviews

When asked on a pull request (`@claude ...`):

- Push your commits to the pull request's branch unless the request says
  otherwise. One commit per request, with a message that says what changed
  and why.
- For a code review (often Copilot's), check each finding against the code
  before changing anything. Fix the real ones, with a test each. Say plainly
  which findings are wrong, and why, instead of changing code to satisfy
  them.
- Reply with a short summary: what was fixed, what wasn't and why, and
  whether `npm run check` passed. Integration tests run in the Sanity workflow
  on the push; don't claim they passed.
- Don't resolve review threads, force-push, merge, or change
  `.github/workflows/publish.yml` or release settings.
