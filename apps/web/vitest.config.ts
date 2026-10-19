import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Coverage gate (issue #112): every package must stay at or above 90% on all four metrics.
// Exclusions are explicit and short, one reason each. Logic is never excluded.
export default defineConfig({
  // tsconfig keeps jsx: preserve for Next, so tell the test transform to compile JSX itself.
  oxc: { jsx: { runtime: "automatic" } },
  // Mirror the "@/*" path alias from tsconfig.json.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    coverage: {
      provider: "v8",
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.{ts,tsx}", // test files are not product code
        "app/**/layout.tsx", // Next route glue: wires providers and metadata, no logic
        "app/**/loading.tsx", // Next route glue: static fallback markup, no logic
        "app/**/error.tsx", // Next route glue: static error boundary markup, no logic
        "app/**/manifest.ts", // Next route glue: static PWA manifest object, no logic
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
})
