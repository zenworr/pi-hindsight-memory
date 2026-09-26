import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["*.js", "scripts/checks/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { process: "readonly" } },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-warning-comments": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "eqeqeq": ["error", "always", { null: "ignore" }]
    }
  },
  {
    files: ["test/**/*.ts"],
    // Partial SDK and HTTP mocks intentionally omit runtime members and return immediate promises.
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: "test" }]
      }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off"
    }
  },
  {
    files: ["src/common/**/*.ts", "src/canonical/**/*.ts", "src/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: "/(?:importer|extension|hindsight)/", message: "Keep parsing and shared code independent of orchestration and service clients." }] }]
    }
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-magic-numbers": ["error", {
        ignore: [-1, 0, 1],
        ignoreArrayIndexes: true,
        ignoreNumericLiteralTypes: true,
        ignoreTypeIndexes: true,
        enforceConst: true
      }]
    }
  }
);
