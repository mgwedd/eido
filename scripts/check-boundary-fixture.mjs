// Proves the boundary rules are enforced: dependency-cruiser must FAIL on the fixture,
// and each case must fail for the right reason (right rule, right file).
import { spawnSync } from "node:child_process"

const run = spawnSync(
  "pnpm",
  [
    "exec",
    "depcruise",
    "fixtures/boundary-violation",
    "--config",
    ".dependency-cruiser.cjs",
    "--no-cache",
  ],
  { encoding: "utf8" }
)
const output = `${run.stdout}${run.stderr}`

if (run.status === 0) {
  console.error(
    "FAIL: dependency-cruiser passed on the boundary-violation fixture; the boundary rules are not enforced."
  )
  process.exit(1)
}

// Each case: a violation line that names both the rule and the offending file.
const cases = [
  {
    label: "relative import of gate internals (bad.ts)",
    pattern:
      /error\s+gate-internals-are-private:\s+\S*packages\/core\/src\/bad\.ts\b/,
  },
  {
    label: "workspace specifier into gate internals (bad-workspace.ts)",
    pattern:
      /error\s+(?:not-to-unresolvable|gate-internals-are-private):\s+\S*packages\/core\/src\/bad-workspace\.ts\b/,
  },
]

const missing = cases.filter((c) => !c.pattern.test(output))
if (missing.length) {
  console.error(
    "FAIL: fixture did not fail for the expected reasons:\n" +
      missing.map((c) => `  - ${c.label}`).join("\n") +
      "\n\n" +
      output
  )
  process.exit(1)
}
console.log(
  "ok: fixture violates the boundary rules as expected:\n" +
    cases.map((c) => `  - ${c.label}`).join("\n")
)
