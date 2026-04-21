const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  // Base ESLint recommended rules
  js.configs.recommended,

  {
    files: ["**/*.js"],

    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node
      }
    },

    rules: {
      /*
       * Refactor safety / correctness
       */

      "no-unused-vars": [
        "warn",
        {
          args: "none",
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

      /*
       * Explicitly allowed
       */

      "no-console": "off",
      "no-debugger": "off"
    }
  },
  {
    files: ["src/language-data.js"],
    rules: {
      "no-useless-escape": "off",
    }
  }
];
