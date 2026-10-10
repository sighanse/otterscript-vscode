# Contributing

Thanks for your interest in contributing to OtterScript Language Extension for VS Code!

Contributions are welcome and appreciated.

## Guidelines

- Keep changes focused and scoped to a single concern
- Update documentation where relevant
- Test changes in VS Code before submitting
- Use the pull request template when submitting PRs

## Development

Requires Node.js 22.22.2 or newer on the 22 line, or 24.15 or newer: the
JSDoc lint plugin needs it, and the packaging tool (`@vscode/vsce`) needs
22. CI uses the version in `.nvmrc` (24).

```sh
npm install       # dev dependencies
npm run check     # ESLint + JSDoc type-check + grammar/language-data sync
                  # + generated-data checks + a CHANGELOG section for the
                  # version in package.json + bundle contents + unit tests
npm test          # unit tests only (node:test)
npm run test:cov  # unit tests with coverage of src/; fails below the line,
                  # branch and function limits in package.json (Sanity runs it)
npm run lint      # ESLint only
npm run lint:fix  # ESLint, fixing what it can
npm run build              # bundle src/ (scripts/build.js) into
                           # dist/extension.js for the desktop and
                           # dist/web/extension.js for the browser, with source
                           # maps (F5 and the tests build first; packaging
                           # builds without them, `npm run bundle`)
npm run test:integration   # integration tests in real VS Code (see below)
npm run test:web           # web tests in VS Code for the Web (see below)
npm run package            # build the .vsix, to install and try locally
                           # (Extensions view > ... > Install from VSIX)
npm run update:cards       # re-download the Adaptive Card schema and regenerate
                           # src/adaptivecard-data.js
npm run update:reference   # re-download Inedo's function/operation reference,
                           # regenerate src/inedo-reference-data.js and the
                           # grammar's name lists
npm run update:grammar     # regenerate the grammar's name lists only
```

### Project layout

Plain JavaScript (CommonJS), type-checked from its JSDoc, bundled by esbuild
into `dist/extension.js`.

- `src/extension.js`: activation, settings, and when the diagnostics run.
  It and everything in `src/` use only the `vscode` API, with no Node
  built-ins or npm packages, so the same code runs in VS Code for the Web;
  `npm run check` fails otherwise
- `src/providers/`: one module per group of language features (completion,
  hover, signature help, inlay hints, navigation, workspace symbols, quick
  fixes)
- `src/diagnostics.js` and `src/adaptivecard.js`: the checks
- `src/scanner.js`: text scanning (strings, comments, template tags). It must
  stay free of `vscode` imports; ESLint enforces it. `src/json-view.js` is the
  same kind of layer for JSON in templates
- `src/document-index.js`: per-document caches built on the scanner
- `src/language-data.js`: the hand-written docs tables, merged with Inedo's
  generated reference (`src/inedo-reference*.js`)
- `src/helpers.js`: settings, logging and the hover and completion builders
- `test/unit/`, `test/integration/`, `test/web/`: the tests (see below);
  `scripts/`: the build (`build.js`), and the generators and checks
  `npm run` calls

Some files are generated; `npm run check` fails when one is out of date:

- `src/adaptivecard-data.js`, by `scripts/update-adaptivecard-data.js` from
  the saved schema in `scripts/adaptive-card-schema.json`. The script also
  holds the Teams-only types and values that Microsoft's schema leaves out.
- `src/inedo-reference-data.js`, by `scripts/update-inedo-reference.js` from
  the saved reference in `scripts/inedo-reference.json` (Inedo's Otter and
  BuildMaster function/operation reference). The script also holds the
  namespace corrections. The file is compact (no derivable fields);
  `src/inedo-reference.js` expands it into docs entries. An operation whose
  name another namespace also uses (`DevEnv::Build`, `DotNet::Build`) has one
  entry per namespace: the first in `operationDocs`, the others in
  `operationVariants`; look operations up with `lookupOperation(name,
  namespace)` and their arguments with `operationArguments`. Hand-written entries
  in `src/language-data.js` win over generated ones, so better docs or
  ProGet's meaning go there.
- The function and operation name lists in
  `syntaxes/otterscript.tmLanguage.json`, by
  `scripts/check-language-sync.js --write` from the tables in
  `src/language-data.js`. After adding an entry there, run
  `npm run update:grammar`.

Optionally, install the [pre-commit](https://pre-commit.com) hooks once with
`pre-commit install`. Each commit then gets the file, Markdown, workflow
(actionlint, and zizmor's security audit) and ESLint checks, and each push
runs `npm run check`. The hook tools install themselves on first use
(actionlint is built with Go and zizmor installed with Python, which
pre-commit downloads if they aren't installed), so the first commit is slow.
The hooks are pinned to commits; update them with
`pre-commit autoupdate --freeze`.

Press <kbd>F5</kbd> in VS Code to build the bundle and launch an Extension
Development Host with this repo loaded as the test workspace. The same checks
run in CI (`.github/workflows/sanity.yml`) on every pull request.

### Tests

Every change in behavior comes with tests:

- Unit tests (`test/unit/`, Node's `node:test`) for the logic. A module's
  tests go in the file named after it (`src/providers/hover.js` ->
  `test/unit/hover.test.js`). They load `test/vscode-stub.js`, which stands
  in for the `vscode` module; `test/unit/fake-document.js` makes documents
  and `test/unit/fake-workspace.js` a workspace with files and open
  documents. Replace a stub member with `stubProperty`, which puts it back
  when the test ends.
- For a bug fix, write the test first and see it fail for the reason
  reported, then fix the code.
- Sanity fails when the unit tests cover less of `src/` than the limits in
  `package.json`'s `test:cov`.

### Integration tests

`npm run test:integration` runs `test/integration/` inside real VS Code, once on
the oldest version `engines.vscode` in `package.json` allows (1.85) and once on
current stable. The first run downloads each version into `.vscode-test/`
(about 130 MB each). To run just one:

```sh
npm run test:integration -- --label minimum   # or: --label stable
```

To debug them, pick **Extension Tests** in the Run and Debug view. With the
[Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)
extension installed, they also appear in the Testing view.

### Web tests

`npm run test:web` runs `test/web/` in VS Code for the Web (current stable)
in headless Chromium, with `test/integration/workspace` as the workspace,
to check that the browser bundle loads and its features work there. They
cover each kind of feature once; the integration tests cover them in depth.
The first run downloads VS Code for the Web into `.vscode-test-web/`; the
browser comes from Playwright: install it once with
`npx playwright install --only-shell chromium`.

To try the browser bundle by hand, pick **Run Web Extension** in the Run and
Debug view.

## Commit messages

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
a type, then what changed (`feat: hover for with directives`,
`fix: ...`, `test: ...`, `docs: ...`, `refactor: ...`, `ci: ...`,
`build: ...`), and a body that says why.

## Changelog

Add each user-visible change under `## [Unreleased]` in `CHANGELOG.md` (Added,
Changed, Fixed or Removed), written for people who use the extension. Leave
out what they can't notice: dependency updates, tooling, tests, CI and
refactoring.

## Asking Claude on a pull request

The repository owner and collaborators can mention `@claude` in a pull
request or issue comment, a review comment or a review, such as
`@claude address Copilot's latest review`. The **Claude** workflow
(`.github/workflows/claude.yml`) then runs Claude Code, which follows
[CLAUDE.md](CLAUDE.md): it checks each finding, pushes its fixes to the pull
request's branch (unless the comment says otherwise), and replies with what it
did. Nothing runs without a mention. The workflow needs the Claude GitHub App
and a `CLAUDE_CODE_OAUTH_TOKEN` repository secret (`claude setup-token`).

## Releasing

1. Bump `version` in `package.json` (`npm version <patch|minor|major> --no-git-tag-version`)
   and turn `[Unreleased]` in `CHANGELOG.md` into the version and date
   (`## [0.7.0] - 2026-10-05`). That section becomes the GitHub release's
   notes; `npm run check` fails until the version has one.
2. Merge to `main` through a pull request.
3. Run the **Publish Extension** workflow on `main`. After approval in the
   `release` environment it checks and packages the extension once, publishes
   that package to the Visual Studio Marketplace and Open VSX, then tags the
   commit `v<version>` and creates a GitHub release with the package attached
   and the version's CHANGELOG section as its notes.
   A run that failed half-way can be run again: versions already published
   are skipped.

   For now the Marketplace is published to by hand: while the `VSCE_PAT`
   secret isn't set, the workflow skips that step with a warning, so upload
   the package from the GitHub release to the Marketplace yourself.
4. Check the release package's build provenance (see
   [SECURITY.md](SECURITY.md)):
   `gh attestation verify otterscript-vscode-<version>.vsix --repo sighanse/otterscript-vscode`.

## Questions

Open an issue if you're unsure about a change.
