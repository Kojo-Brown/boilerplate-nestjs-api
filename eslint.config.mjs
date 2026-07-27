import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // `_`-prefixed bindings are the codebase's explicit "intentionally
      // discarded" marker — used when destructuring keys out of a factory result.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // NestJS relies on parameter decorators and `emitDecoratorMetadata`; the
      // base rule cannot see that constructor parameter properties are used.
      "no-unused-private-class-members": "off",
    },
  },
  {
    // Test files legitimately reach into internals to exercise them in isolation.
    files: ["**/*.spec.ts", "src/test-utils/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
);
