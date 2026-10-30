import { defineConfig } from "vitest/config"

// Coverage gate (issue #112): every package must stay at or above 90% on all four metrics.
// Exclusions are explicit and short, one reason each. Logic is never excluded.
export default defineConfig({
  test: {
    // Gate tests start local servers and generate ephemeral TLS certificates. Keep
    // Windows CI from running many such files at once on its small runner.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.{ts,tsx}", // test files are not product code
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
