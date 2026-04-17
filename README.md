# OtterScript Language Extension

This extension provides syntax highlighting, code snippets, and function support for OtterScript used in Inedo products (Otter, BuildMaster, ProGet).

Not affiliated with or endorsed by [Inedo](https://inedo.com/).

[Otter](https://inedo.com/otter), [BuildMaster](https://inedo.com/buildmaster) and [ProGet](https://inedo.com/proget) are trademarks of [Inedo](https://inedo.com/).

## Background

This extension started as a learning project while implementing [custom webhook notification](https://docs.inedo.com/docs/proget/administration/proget-notifications-webhooks/proget-notifications-custom-webhook) in [ProGet](https://inedo.com/proget).

## Features

- Syntax highlighting for OtterScript constructs
- Function signature help for built-in functions
- Auto-completion for variables and functions
- Code snippets for common patterns
- Hover information with documentation

## Status

This extension is in active development and currently considered early-stage.
Features may change as the extension evolves.

**Testing scope:**
This extension is primarily developed and tested against **ProGet** usage
(particularly custom webhook action context).
While OtterScript is shared across Otter, BuildMaster, and ProGet, not all
constructs or product-specific behaviors have been tested equally.

Feedback, issues, and pull requests are welcome.

See [CHANGELOG.md](https://github.com/sighanse/otterscript-vscode/blob/main/CHANGELOG.md) for release notes.

## What this extension does NOT do

- It does not validate or execute OtterScript
- It does not connect to Otter, ProGet, or other Inedo services
- It does not provide a formatter or auto‑fix code actions
- It does not attempt full semantic analysis

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "OtterScript Language Extension"
4. Click Install

## Getting Started

Open any `.otter` or `.oscript` file in VS Code to activate the extension.

No additional configuration is required.

## Language Support Coverage

The extension provides hover documentation, completion, and signature help
for common OtterScript language constructs and built‑in functions, including:

- Core OtterScript functions
- Common string, JSON, and math helpers
- File system helpers
- Execution statements and directives

Coverage is continuously improving and may vary by context.

Some symbols are only relevant in ProGet‑specific contexts (such as webhooks).

## Troubleshooting

If hover or completion does not appear, ensure the file extension is
`.otter` or `.oscript` and that the language mode is set to OtterScript.

### Diagnostics

Diagnostics are best‑effort and designed to catch common mistakes
(e.g. missing `$`, unknown functions, invalid operators).

They do not attempt full semantic analysis and may prefer false negatives
over false positives.

## Contributing

Contributions are welcome.
Please see [CONTRIBUTING.md](https://github.com/sighanse/otterscript-vscode/blob/main/CONTRIBUTING.md) for guidelines.

## Security

Please see [SECURITY.md](https://github.com/sighanse/otterscript-vscode/blob/main/SECURITY.md).

## License

MIT

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://github.com/sighanse/otterscript-vscode/blob/main/CODE_OF_CONDUCT.md).
