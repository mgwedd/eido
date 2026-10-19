import js from "@eslint/js"
import globals from "globals"
import eslintConfigPrettier from "eslint-config-prettier"
import turboPlugin from "eslint-plugin-turbo"
import tseslint from "typescript-eslint"

const TS_FILES = ["**/*.{ts,tsx,mts,cts}"]

/**
 * A shared ESLint configuration for the repository.
 *
 * ESLint flat config only lints .js/.mjs/.cjs by default, so the TypeScript
 * entries below must name TS files explicitly or they are never linted.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node },
  },
  // recommendedTypeChecked (not strict): type-aware rules such as no-floating-promises.
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: TS_FILES,
  })),
  {
    files: TS_FILES,
    languageOptions: {
      // projectService finds the nearest tsconfig.json for each file.
      parserOptions: { projectService: true },
    },
    rules: {
      // Each of these is already in recommendedTypeChecked; listed so the
      // guardrails the team agreed on are visible and cannot be dropped quietly.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      // Not in the recommended set.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    // Config files are plain JS and are not part of any tsconfig.
    files: ["**/*.{js,mjs,cjs,jsx}"],
    ...tseslint.configs.disableTypeChecked,
  },
  eslintConfigPrettier,
  {
    // Fail on eslint-disable comments that no longer suppress anything.
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
]
