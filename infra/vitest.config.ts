import { defineConfig } from "vitest/config"

// Coverage gate (issue #112): every package must stay at or above 90% on all four metrics.
// Exclusions are explicit and short, one reason each. Logic is never excluded.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "tailscale/**/*.ts",
        "stack/**/*.ts",
        "bridge/**/*.ts",
        "llama/**/*.ts",
        "host/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts", // test files are not product code
        "tailscale/bin.ts", // entry point: hands process.argv and the real tailscale CLI to main()
        "bridge/bin.ts", // entry point: hands process.argv, real launchctl, files and TCP to main()
        "stack/bin.ts", // entry point: hands process.argv and real processes, signals and files to main()
        "llama/bin.ts", // entry point: hands process.argv and real files, processes, launchctl, signals and fetch to main()
        "host/bin.ts", // entry point: hands process.argv and the real fdesetup and tailscale to main()
      ],
      reporter: ["text", "json-summary", "cobertura"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
})
