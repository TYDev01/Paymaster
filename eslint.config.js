// Flat-config ESLint for the TypeScript workspaces (Solidity is covered by `forge fmt`).
//
// Type-aware linting is deliberately NOT enabled: `tsc --noEmit` already runs in CI and is the
// authority on types, so turning on the type-checked rule set would duplicate that work, slow the
// lint, and mostly report what the compiler already does. ESLint here catches what the compiler does
// not — unused code, footguns like `==`, accidental `console` in library paths.
//
// `eslint-config-prettier` is applied last so formatting is entirely Prettier's job and ESLint never
// fights it over whitespace.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // frontend/ is a standalone Next project with its own eslint config (eslint-config-next) and its
    // own npm install; linting it from here would apply the backend's rules to a React codebase.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "contracts/**",
      "frontend/**",
      "**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {...globals.node},
    },
    rules: {
      // A caught error is often deliberately unused; allow it, and allow leading-underscore params
      // as the intentional-unused convention the codebase already uses.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none"},
      ],
      eqeqeq: ["error", "always", {null: "ignore"}],
      "no-console": ["warn", {allow: ["error", "warn"]}],
    },
  },
  {
    // Tests, support harnesses, and runnable examples log freely; do not hold them to the library
    // rules above.
    files: ["**/test/**", "**/*.test.ts", "**/examples/**"],
    rules: {
      "no-console": "off",
    },
  },
  prettier,
);
