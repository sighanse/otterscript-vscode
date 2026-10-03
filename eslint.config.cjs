const js = require("@eslint/js");
const globals = require("globals");
const jsdoc = require("eslint-plugin-jsdoc");

/** Every file ESLint lints in this repo. */
const ALL_JS = ["**/*.{js,cjs,mjs}"];

module.exports = [
  // -- Global ignores (applies to all configs)
  {
    ignores: [
      "node_modules/**",
      // VS Code builds downloaded by the integration tests
      ".vscode-test/**",
      "*.vsix",
      // The bundle `npm run build` writes
      "dist/**"
    ]
  },

  // -- Applies to every linted file (no `files` filter)
  {
    linterOptions: {
      // Fail on `// eslint-disable*` comments that no longer suppress anything.
      reportUnusedDisableDirectives: "error"
    }
  },

  // Base ESLint recommended rules (covers no-undef, no-redeclare,
  // no-unreachable, no-fallthrough, no-debugger, ... -- not repeated below)
  js.configs.recommended,

  // -- Module systems: CommonJS everywhere except .mjs (e.g. .vscode-test.mjs).
  //    ecmaVersion "latest" also provides the built-in ES globals.
  {
    files: ["**/*.{js,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node
    }
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node
    }
  },

  {
    files: ALL_JS,

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
      "no-shadow": "warn",

      /*
       * Likely bugs (beyond recommended)
       */
      "array-callback-return": "error",        // e.g. a .map() callback that forgets to return
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      // A `const`/`let` used above its declaration only works while the use
      // runs later (e.g. inside a callback); calling it earlier would throw.
      // Function declarations are hoisted, so they may appear in any order.
      "no-use-before-define": ["error", { functions: false, classes: false, variables: true }],

      /*
       * Low-risk readability
       */
      "eqeqeq": ["warn", "smart"],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "curly": ["warn", "multi-line"],
      "consistent-return": "warn",
      "object-shorthand": "warn",
      "prefer-const": "warn",
      "no-var": "error",
      "no-else-return": "warn",
      "no-lonely-if": "warn",
      "no-useless-return": "warn",
      "default-case": "warn",
      "default-case-last": "warn",
      // Line endings and final newline are enforced by .gitattributes plus the
      // mixed-line-ending / end-of-file-fixer pre-commit hooks; ESLint's own
      // formatting rules are deprecated, so none are configured here.

      /*
       * Other
       */
      "no-process-exit": "error",
      "no-warning-comments": ["warn", {
        terms: ["TODO", "FIXME"],
        location: "start"
      }],
      "require-atomic-updates": "warn",
      "prefer-promise-reject-errors": "warn",
      "no-throw-literal": "error",
      "unicode-bom": "error",

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

  // -- JSDoc: every function declaration documented, with @param / @returns
  //    that match the code. Types are TypeScript-flavored and type-checked by
  //    `npm run check:js`, so this checks presence and shape, not types.
  {
    ...jsdoc.configs["flat/recommended-typescript-flavor-error"],
    files: ALL_JS,
  },
  {
    files: ALL_JS,
    settings: {
      jsdoc: {
        // This repo's file headers use @fileoverview (the plugin prefers @file).
        tagNamePreference: { file: "fileoverview" }
      }
    },
    rules: {
      // Style only -- not enforced:
      "jsdoc/require-param-description": "off",   // many params are self-explanatory
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-property-description": "off",
      "jsdoc/tag-lines": "off",                   // blank-line layout inside a block
      "jsdoc/reject-any-type": "off",             // tests cast deliberately via {any}
      "jsdoc/no-defaults": "off"                  // `[name=default]` is understood by tsc
    }
  },
  {
    // Test helpers and callbacks: the doc they have must be correct, but a
    // block (or @returns) is not required on every small helper.
    files: ["test/**/*.js"],
    rules: {
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-returns": "off"
    }
  },

  {
    // Integration tests run under mocha inside VS Code (see .vscode-test.mjs).
    files: ["test/integration/**/*.js"],
    languageOptions: {
      globals: globals.mocha
    }
  },
  {
    files: ["src/language-data.js"],
    rules: {
      "no-useless-escape": "off",
    }
  },
  {
    // scanner.js is the pure, dependency-free text layer -- keep it vscode-free
    // (see its @fileoverview and test/jsconfig.json). Enforce, don't just document.
    files: ["src/scanner.js"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.name='require'][arguments.0.value='vscode']",
        message: "scanner.js must stay vscode-free; put vscode-dependent code in document-index.js, helpers.js or providers/.",
      }],
    }
  }
];
