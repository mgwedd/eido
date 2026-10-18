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
  ...tseslint.configs.recommended.map((cfg) => ({ ...cfg, files: TS_FILES })),
  eslintConfigPrettier,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
]
