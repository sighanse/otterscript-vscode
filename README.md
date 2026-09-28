# OtterScript Language Extension

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-sighanse.otterscript--vscode-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sighanse.otterscript-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/sighanse/otterscript-vscode?label=Open%20VSX)](https://open-vsx.org/extension/sighanse/otterscript-vscode)
[![Build](https://github.com/sighanse/otterscript-vscode/actions/workflows/build.yml/badge.svg)](https://github.com/sighanse/otterscript-vscode/actions/workflows/build.yml)

This extension provides syntax highlighting, code snippets, and function support for OtterScript used in Inedo products (Otter, BuildMaster, ProGet).

Not affiliated with or endorsed by [Inedo](https://inedo.com/).

[Otter](https://inedo.com/otter), [BuildMaster](https://inedo.com/buildmaster) and [ProGet](https://inedo.com/proget) are trademarks of [Inedo](https://inedo.com/).

## Background

This extension started as a learning project while implementing [custom webhook notification](https://docs.inedo.com/docs/proget/administration/proget-notifications-webhooks/proget-notifications-custom-webhook) in [ProGet](https://inedo.com/proget).

## Features

- Syntax highlighting for OtterScript constructs, including namespaced operations (`ProGet::`, `Otter::`, `Windows::`)
- Hover documentation, auto-completion, and signature help for built-in functions (including the `@` / `%` forms of `FromJson` and `ListItem`), operations, variables, and map/vector expressions
- Diagnostics for common mistakes (missing `$`, unknown functions, invalid operators, `=` used in `if` conditions, duplicate map keys, too many arguments to a fixed-arity function, unknown `Namespace::` prefixes, malformed `<% %>` text-template tags, template/expression mode mixing) — including `$` expressions embedded directly in a text template's literal output (e.g. `$ToJson(...)` in a webhook body), not just code inside `<% %>`
- Adaptive Card checks for Teams webhook bodies, automatically triggered when a literal `"type": "AdaptiveCard"` object is found: an unrecognized `"type"` value, a missing `"version"`, or an element/action that needs a newer card version than the card declares (e.g. a 1.5 `Table` in a 1.2 card, unless it has a `"fallback"`) is flagged, with a quick fix to raise the version. Best-effort only — it does not validate full card structure against the schema, since a template's `<% %>` control flow means there's no single concrete JSON document to validate against
- Quick‑fix code actions, plus a **Fix All Issues** command (`Ctrl+Shift+Alt+F`) that applies every available fix in the file
- Go to Definition (F12) and Find All References (Shift+F12) for document-local module calls
- Outline and breadcrumbs via document symbols
- Go to Symbol in Workspace (`Ctrl+T`) — jump to any `module` declaration across all OtterScript files
- CodeLens reference counts above module declarations
- Code folding via `#region` / `#endregion` and block structure
- Code snippets for common patterns

## Status

This extension is in active development and currently considered early-stage.
Features may change as the extension evolves.

**Testing scope:**
This extension is primarily developed and tested against **ProGet** usage.
While OtterScript is shared across Otter, BuildMaster, and ProGet, not all
constructs or product-specific behaviors have been tested equally.

Feedback, issues, and pull requests are welcome.

See [CHANGELOG.md](https://github.com/sighanse/otterscript-vscode/blob/main/CHANGELOG.md) for release notes.

## What this extension does NOT do

- It does not execute OtterScript — diagnostics are static, best-effort pattern checks (see below), not proof a script will run correctly
- It does not connect to Otter, ProGet, or other Inedo services
- It does not auto-fix on save or format your code; fixes are only applied when you explicitly invoke a quick‑fix or the **Fix All Issues** command
- It does not attempt full semantic analysis

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "OtterScript Language Extension"
4. Click Install

## Getting Started

Open any `.otter` or `.oscript` file in VS Code to activate the extension.

No additional configuration is required.

## Settings

All features are enabled by default and can be toggled individually:

- `otterscript.completion.enable` — auto-completion suggestions
- `otterscript.signatureHelp.enable` — signature help for functions and operations
- `otterscript.hover.enable` — hover information for functions and operations
- `otterscript.codeLens.enable` — CodeLens reference counts above module declarations
- `otterscript.workspaceSymbols.enable` — index module declarations for "Go to Symbol in Workspace" (`Ctrl+T`)

### Turning individual diagnostics off

Every diagnostic has a code, shown in the Problems panel. Use
`otterscript.diagnostics.rules` to turn a check off (`"off"`) or change its
severity (`"error"`, `"warning"`, `"information"`, `"hint"`):

```jsonc
"otterscript.diagnostics.rules": {
  "unknown-operation": "off",
  "assignment-in-condition": "hint"
}
```

Each diagnostic's lightbulb menu also offers **Turn off '&lt;code&gt;' diagnostics**,
which adds the `"off"` entry to your workspace settings (or user settings
when no folder is open).

| Code | Flags |
| --- | --- |
| `unbalanced-symbol` | Unclosed or unexpected `{` `}`, `(` `)` or `[` `]` |
| `missing-dollar` | A variable in a condition without its `$` |
| `assignment-in-condition` | `=` in a condition where `==` was probably meant |
| `invalid-operator` | `&` or `\|` where `&&` or `\|\|` is required |
| `incorrect-for-usage` | `for` used as a loop (use `foreach`) |
| `duplicate-map-key` | The same key twice in a `%(...)` map |
| `unknown-scalar-function` | Unknown `$Name(...)` function |
| `unknown-vector-function` | Unknown `@Name(...)` function |
| `unknown-operation` | Unknown operation |
| `unknown-namespace` | Unknown `Namespace::` prefix |
| `too-many-arguments` | More arguments than the function accepts |
| `template-unexpected-close` | `%>` with no matching `<%` |
| `template-unclosed` | `<%` that is never closed |
| `template-end-keyword` | `<% end %>` where `<% } %>` is required |
| `template-missing-brace` | Block tag such as `<% if ... %>` missing its `{` |
| `template-in-expression` | `<% %>` inside an unclosed OtterScript expression |
| `adaptivecard-missing-version` | Adaptive Card without a `"version"` |
| `adaptivecard-unknown-type` | Unrecognized Adaptive Card `"type"` |
| `adaptivecard-version-too-low` | Card element or action newer than the card's `"version"` |

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
over false positives. If a check misfires for your scripts, turn it off with
`otterscript.diagnostics.rules` (see [Settings](#settings)).

## Contributing

Contributions are welcome.
Please see [CONTRIBUTING.md](https://github.com/sighanse/otterscript-vscode/blob/main/CONTRIBUTING.md) for guidelines.

## Security

Please see [SECURITY.md](https://github.com/sighanse/otterscript-vscode/blob/main/SECURITY.md).

## License

[MIT](https://github.com/sighanse/otterscript-vscode/blob/main/LICENSE)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://github.com/sighanse/otterscript-vscode/blob/main/CODE_OF_CONDUCT.md).
