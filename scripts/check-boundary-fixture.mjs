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
  {
    label: "relative import of the token vault (bad-vault.ts)",
    pattern:
      /error\s+gate-internals-are-private:\s+\S*packages\/core\/src\/bad-vault\.ts\b/,
  },
  {
    label: "the gate importing the data plane (bad-core-import.ts)",
    pattern:
      /error\s+gate-imports-schemas-only:\s+\S*packages\/gate\/src\/bad-core-import\.ts\b/,
  },
  {
    label:
      "the gate importing a document parser library (bad-parser-import.ts)",
    pattern:
      /error\s+gate-has-no-parsers:\s+\S*packages\/gate\/src\/bad-parser-import\.ts\b/,
  },
  {
    label: "app code importing a web test fixture (bad-fixture-import.ts)",
    pattern:
      /error\s+web-test-fixtures-are-test-only:\s+\S*apps\/web\/app\/bad-fixture-import\.ts\b/,
  },
  {
    label:
      "app code importing a web test fixture through the @/ alias (bad-fixture-alias-import.ts)",
    pattern:
      /error\s+web-test-fixtures-are-test-only:\s+\S*apps\/web\/app\/bad-fixture-alias-import\.ts\b/,
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
