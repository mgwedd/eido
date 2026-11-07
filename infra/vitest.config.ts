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
        "backup/**/*.ts",
        "bridge/**/*.ts",
        "llama/**/*.ts",
        "host/**/*.ts",
        "ts-hooks.ts",
      ],
      exclude: [
        "**/*.test.ts", // test files are not product code
        "tailscale/bin.ts", // entry point: hands process.argv and the real tailscale CLI to main()
        "bridge/bin.ts", // entry point: hands process.argv, real launchctl, files and TCP to main()
        "stack/bin.ts", // entry point: hands process.argv and real processes, signals and files to main()
        "stack/supervisor-main.ts", // entry point: hands the real effects and the socket to the supervisor
        "backup/test-support.ts", // helpers for the backup tests
        "stack/test-support.ts", // the fake machine for the stack CLI and supervisor tests
        "llama/test-support.ts", // the fake machine for the llama CLI and supervisor tests
        "backup/bin.ts", // entry point: hands process.argv, the restic binary and the clock to main()
        "llama/effects.ts", // real files, processes, launchctl, signals and fetch for the CLI and the supervisor; no logic
        "stack/effects.ts", // real processes, signals, files, clock and fetch for the CLI and the supervisor; no logic
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
