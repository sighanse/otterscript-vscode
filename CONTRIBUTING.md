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
npm run check     # JSDoc type-check + grammar/language-data sync + unit tests
npm test          # unit tests only (node:test)
npm run lint      # ESLint
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with this
repo loaded as the test workspace. The same checks run in CI
(`.github/workflows/sanity.yml`) on every pull request.

## Questions

Open an issue if you're unsure about a change.
