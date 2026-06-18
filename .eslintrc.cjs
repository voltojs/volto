/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    }],
  },
  ignorePatterns: ["dist/", "node_modules/", "*.js", "*.cjs"],
  overrides: [
    {
      // @volto/core: purity rules — no node:*, no implementation packages, no implicit side effects
      files: ["packages/core/src/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@volto/tools-fs",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/tools-shell",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/tools-web",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/tools-plan",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/tools-agent",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/provider-openai",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/runtime-node",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/store-memory",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/store-sqlite",
                message: "@volto/core must not import implementation packages.",
              },
              {
                name: "@volto/sdk",
                message: "@volto/core must not import implementation packages.",
              },
            ],
            patterns: [
              {
                group: ["node:*"],
                message: "@volto/core must not import Node builtins. Use port injection instead.",
              },
            ],
          },
        ],
        "no-restricted-properties": [
          "error",
          {
            object: "Date",
            property: "now",
            message: "Date.now() is forbidden in core. Use Clock port injection.",
          },
          {
            object: "Math",
            property: "random",
            message: "Math.random() is forbidden in core. Use Random port injection.",
          },
        ],
        "no-restricted-globals": [
          "error",
          {
            name: "crypto",
            message: "crypto.randomUUID() is forbidden in core. Use Id port injection.",
          },
        ],
      },
    },
    {
      // Core purity rules target shipped production code only. Test files under
      // __tests__ legitimately need Node builtins / time / randomness (e.g. the
      // barrel-purity meta-test spawns a Node subprocess via node:child_process).
      // The strict purity guard still applies to src/**/*.ts and src/testing/**.
      files: ["packages/core/src/__tests__/**/*.ts"],
      rules: {
        "no-restricted-imports": "off",
        "no-restricted-properties": "off",
        "no-restricted-globals": "off",
      },
    },
  ],
};
