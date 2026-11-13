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
      // Type-import discipline (AGENTS.md §3): tools-*/memories-* consume
      // core CONTRACT TYPES only; a value import would couple them to the
      // implementation. consistent-type-imports is what makes "import type
      // everywhere" mechanically checkable instead of review-enforced.
      files: [
        "packages/memories/*/src/**/*.ts",
        "packages/tools/*/src/**/*.ts",
        "packages/stores/*/src/**/*.ts",
      ],
      rules: {
        "@typescript-eslint/consistent-type-imports": "error",
      },
    },
    {
      // @voltojs/core: purity rules — no node:*, no implementation packages, no implicit side effects
      files: ["packages/core/src/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@voltojs/tools-fs",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/tools-shell",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/tools-web",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/tools-plan",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/tools-agent",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/provider-openai",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/runtime-node",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/store-memory",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/store-sqlite",
                message: "@voltojs/core must not import implementation packages.",
              },
              {
                name: "@voltojs/sdk",
                message: "@voltojs/core must not import implementation packages.",
              },
            ],
            patterns: [
              {
                group: ["node:*"],
                message: "@voltojs/core must not import Node builtins. Use port injection instead.",
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
