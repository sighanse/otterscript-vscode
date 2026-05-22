const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  // -- Global ignores (applies to all configs)
  {
    ignores: [
      "node_modules/**",
      "*.vsix"
    ]
  },
  // Base ESLint recommended rules
  js.configs.recommended,

  {
    files: ["**/*.js"],

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    },

    rules: {
      "no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",   // Explicit opt-out for params
          varsIgnorePattern: "^_",   // Explicit opt-out for variables
          ignoreRestSiblings: true
        }
      ],

      "no-undef": "error",
      "no-redeclare": "error",
      "no-shadow": "warn",

      /*
       * Low-risk readability
       */

      "eqeqeq": ["warn", "smart"],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "comma-dangle": ["warn", "only-multiline"],
      "eol-last": ["warn", "always"],
      /*
       * Other
       */
      "curly": ["warn", "multi-line"],
      "consistent-return": "warn",
      "object-shorthand": "warn",
      "prefer-const": "warn",
      "no-var": "error",
      "no-process-exit": "error",
      "no-warning-comments": ["warn", {
        terms: ["TODO", "FIXME"],
        location: "start"
      }],
      "no-return-await": "warn",
      "require-atomic-updates": "warn",
      "prefer-promise-reject-errors": "warn",
      "no-throw-literal": "error",
      "linebreak-style": ["error", "unix"],
      "no-constant-binary-expression": "error",
      "no-unreachable": "error",
      "no-fallthrough": "error",
      "no-useless-return": "warn",
      "no-misleading-character-class": "error",
      "no-async-promise-executor": "error",
      "default-case": "warn",
      "no-else-return": "warn",
      "no-lonely-if": "warn",
      "unicode-bom": "error",
      /*
       * Explicitly allowed
       */

      "no-console": "off",
      "no-debugger": "off",
      "no-invalid-this": "off",

      "no-restricted-globals": ["error",
        { name: "window", message: "Use vscode.window instead." },
        { name: "document", message: "VS Code extensions run in Node.js, not browsers." },
        { name: "alert", message: "Use vscode.window.showInformationMessage()" },
        { name: "confirm", message: "Use vscode.window.showWarningMessage({ modal: true })" },
        { name: "prompt", message: "Use vscode.window.showInputBox()" },
        { name: "localStorage", message: "Use vscode.workspace.state or memento" },
        { name: "sessionStorage", message: "Use vscode.workspace.state or memento" }
      ],
    },
  },
  {
    files: ["src/language-data.js"],
    rules: {
      "no-useless-escape": "off",
    }
  }
];
