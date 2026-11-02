import { defineConfig } from "vitest/config"

// Coverage gate (issue #112): every package must stay at or above 90% on all four metrics.
// Exclusions are explicit and short, one reason each. Logic is never excluded.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["tailscale/**/*.ts", "stack/**/*.ts"],
      exclude: [
        "**/*.test.ts", // test files are not product code
        "tailscale/bin.ts", // entry point: hands process.argv and the real tailscale CLI to main()
        "stack/bin.ts", // entry point: hands process.argv and real processes, signals and files to main()
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
