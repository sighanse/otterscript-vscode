# OtterScript Language Extension

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-sighanse.otterscript--vscode-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=sighanse.otterscript-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/sighanse/otterscript-vscode?label=Open%20VSX)](https://open-vsx.org/extension/sighanse/otterscript-vscode)
[![Build](https://github.com/sighanse/otterscript-vscode/actions/workflows/build.yml/badge.svg)](https://github.com/sighanse/otterscript-vscode/actions/workflows/build.yml)

Language support for OtterScript, the scripting language of Inedo's Otter, BuildMaster and ProGet: syntax highlighting, completion, hover documentation and signature help, diagnostics with quick fixes, module navigation, snippets, and checks for Adaptive Cards in Teams webhook templates.

Not affiliated with or endorsed by [Inedo](https://inedo.com/).

[Otter](https://inedo.com/otter), [BuildMaster](https://inedo.com/buildmaster) and [ProGet](https://inedo.com/proget) are trademarks of [Inedo](https://inedo.com/).

## Background

This extension started as a learning project while implementing [custom webhook notification](https://docs.inedo.com/docs/proget/administration/proget-notifications-webhooks/proget-notifications-custom-webhook) in [ProGet](https://inedo.com/proget).

## Features

- Syntax highlighting, including namespaced operations (`ProGet::`, `Otter::`, `Windows::`)
- Hover documentation, completion and signature help for every function and operation in Inedo's Otter and BuildMaster reference, ProGet's notifier variables, and map/vector expressions
- Diagnostics for common mistakes (see [the list of checks](#turning-individual-diagnostics-off)) — also for `$` expressions in a text template's literal output, such as `$ToJson(...)` in a webhook body
- Adaptive Card checks, triggered by a literal `"type": "AdaptiveCard"` object in a template: unknown types, values a property doesn't allow (`"weight": "bold"`), elements or properties newer than the card's `"version"`, and Teams webhook mistakes such as a wrong `"contentType"` or `Action.Submit`. Based on the Adaptive Card 1.6 schema plus Teams-only elements; best-effort, not a full schema validation
- Quick fixes, plus a **Fix All Issues** command (`Ctrl+Shift+Alt+F`); fixes that would cause a new problem are left to the lightbulb
- Module navigation: Go to Definition (F12), Find All References (Shift+F12), CodeLens reference counts, Outline and breadcrumbs, and Go to Symbol in Workspace (`Ctrl+T`); completion of module names after `call`, from this file and the rest of the workspace
- Variables: completion of the ones the file uses, Go to Definition (F12) to where they're assigned, and highlighting all occurrences of a variable (`$x`, `@list`, `%map`, `${my var}`) or module, with declarations and assignments marked as writes
- Code folding via `#region` / `#endregion` and block structure
- Snippets for common patterns, including `teamscard`: a complete Teams webhook body with an Adaptive Card

## Status

Early-stage and in active development; features may change. Developed and tested mainly against **ProGet** — OtterScript is shared with Otter and BuildMaster, but their product-specific constructs are less tested. See the [CHANGELOG](https://github.com/sighanse/otterscript-vscode/blob/main/CHANGELOG.md) for release notes.

## What this extension does NOT do

- It does not execute OtterScript — diagnostics are static, best-effort pattern checks, not proof a script will run correctly; they prefer missing a problem over flagging correct code
- It does not connect to Otter, ProGet, or other Inedo services
- It does not auto-fix on save or format your code; fixes are only applied when you invoke a quick fix or **Fix All Issues**

## Getting Started

Install **OtterScript Language Extension** from the Extensions view (`Ctrl+Shift+X`), then open any `.otter` or `.oscript` file. No configuration is required.

If hover or completion doesn't appear, check that the language mode in the status bar is OtterScript.

## Settings

All features are enabled by default and can be toggled individually:

- `otterscript.completion.enable` — completion suggestions
- `otterscript.signatureHelp.enable` — signature help for functions and operations
- `otterscript.hover.enable` — hover documentation
- `otterscript.codeLens.enable` — CodeLens reference counts above module declarations
- `otterscript.workspaceSymbols.enable` — index module declarations for Go to Symbol in Workspace (`Ctrl+T`)

`otterscript.adaptiveCards.maxVersion` (default `"1.6"`) is the highest
Adaptive Card version the host that shows your cards supports. Lower it if
your cards go to an older host.

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
| `adaptivecard-invalid-value` | Card property value that isn't allowed, e.g. `"weight": "bold"` |
| `adaptivecard-version-too-low` | Card element, action or property newer than the card's `"version"` |
| `adaptivecard-version-too-high` | Card `"version"` newer than `otterscript.adaptiveCards.maxVersion` |
| `adaptivecard-templating-keyword` | Adaptive Card Templating key (`"$data"`, `"$when"`, ...) that OtterScript expands |
| `adaptivecard-content-type` | Teams message attachment without the Adaptive Card `"contentType"` |
| `adaptivecard-webhook-submit` | `Action.Submit` in a Teams message (webhooks don't support it) |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](https://github.com/sighanse/otterscript-vscode/blob/main/CONTRIBUTING.md).
Report security issues as described in [SECURITY.md](https://github.com/sighanse/otterscript-vscode/blob/main/SECURITY.md).
This project follows the [Contributor Covenant Code of Conduct](https://github.com/sighanse/otterscript-vscode/blob/main/CODE_OF_CONDUCT.md)
and is licensed under the [MIT License](https://github.com/sighanse/otterscript-vscode/blob/main/LICENSE).
