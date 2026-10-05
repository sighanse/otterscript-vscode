# Contributing

Thanks for your interest in contributing to OtterScript Language Extension for VS Code!

Contributions are welcome and appreciated.

## Guidelines

- Keep changes focused and scoped to a single concern
- Update documentation where relevant
- Test changes in VS Code before submitting
- Use the pull request template when submitting PRs

## Development

Requires Node.js 22.22 or newer (or 24.15+ on the 24 line): the packaging
tool (`@vscode/vsce`) and the JSDoc lint plugin need it. CI uses the version
in `.nvmrc` (24).

```sh
npm install       # dev dependencies
npm run check     # ESLint + JSDoc type-check + grammar/language-data sync
                  # + generated-data checks + a CHANGELOG section for the
                  # version in package.json + unit tests
npm test          # unit tests only (node:test)
npm run test:cov  # unit tests with coverage of src/; fails below the line,
                  # branch and function limits in package.json (Sanity runs it)
npm run lint      # ESLint only
npm run build              # bundle src/ into dist/extension.js, which the
                           # extension runs from, with a source map (F5 and the
                           # integration tests build it first; packaging builds
                           # it without one, `npm run bundle`)
npm run test:integration   # integration tests in real VS Code (see below)
npm run update:cards       # re-download the Adaptive Card schema and regenerate
                           # src/adaptivecard-data.js
npm run update:reference   # re-download Inedo's function/operation reference,
                           # regenerate src/inedo-reference-data.js and the
                           # grammar's name lists
npm run update:grammar     # regenerate the grammar's name lists only
```

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
`pre-commit install`. Each commit then gets the file, Markdown, workflow and
ESLint checks, and each push runs `npm run check`. The hook tools install
themselves on first use (the workflow linter, actionlint, is built with Go,
which pre-commit downloads if it isn't installed), so the first commit is slow.

Press <kbd>F5</kbd> in VS Code to build the bundle and launch an Extension
Development Host with this repo loaded as the test workspace. The same checks
run in CI (`.github/workflows/sanity.yml`) on every pull request.

### Integration tests

`npm run test:integration` runs `test/integration/` inside real VS Code, once on
the oldest supported version (1.85.0) and once on current stable. The first run
downloads each version into `.vscode-test/` (about 130 MB each). To run just one:

```sh
npm run test:integration -- --label minimum   # or: --label stable
```

To debug them, pick **Extension Tests** in the Run and Debug view. With the
[Extension Test Runner](https://marketplace.visualstudio.com/items?itemName=ms-vscode.extension-test-runner)
extension installed, they also appear in the Testing view.

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

## Questions

Open an issue if you're unsure about a change.
