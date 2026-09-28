# Contributing

Thanks for your interest in contributing to OtterScript Language Extension for VS Code!

Contributions are welcome and appreciated.

## Guidelines

- Keep changes focused and scoped to a single concern
- Update documentation where relevant
- Test changes in VS Code before submitting
- Use the pull request template when submitting PRs

## Development

```sh
npm install       # dev dependencies
npm run check     # ESLint + JSDoc type-check + grammar/language-data sync + unit tests
npm test          # unit tests only (node:test)
npm run lint      # ESLint only
npm run test:integration   # integration tests in real VS Code (see below)
```

Optionally, install the [pre-commit](https://pre-commit.com) hooks once with
`pre-commit install`. Each commit then gets the file, Markdown, workflow and
ESLint checks, and each push runs `npm run check`. The hook tools install
themselves on first use (the workflow linter, actionlint, is built with Go,
which pre-commit downloads if it isn't installed), so the first commit is slow.

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with this
repo loaded as the test workspace. The same checks run in CI
(`.github/workflows/sanity.yml`) on every pull request.

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

## Questions

Open an issue if you're unsure about a change.
