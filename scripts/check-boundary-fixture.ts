// Proves the boundary rules are enforced: dependency-cruiser must FAIL on the fixture,
// and each case must fail for the right reason (right rule, right file).
import { spawnSync } from "node:child_process"

interface FixtureCase {
  label: string
  pattern: RegExp
}

// Each case: a violation line that names both the rule and the offending file.
export const CASES: FixtureCase[] = [
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

export interface FixtureVerdict {
  ok: boolean
  message: string
}

/** Judges one dependency-cruiser run over the fixture: it must fail, for every expected reason. */
export function judgeFixtureRun(
  status: number | null,
  output: string
): FixtureVerdict {
  if (status === 0) {
    return {
      ok: false,
      message:
        "FAIL: dependency-cruiser passed on the boundary-violation fixture; the boundary rules are not enforced.",
    }
  }
  const missing = CASES.filter((c) => !c.pattern.test(output))
  if (missing.length) {
    return {
      ok: false,
      message:
        "FAIL: fixture did not fail for the expected reasons:\n" +
        missing.map((c) => `  - ${c.label}`).join("\n") +
        "\n\n" +
        output,
    }
  }
  return {
    ok: true,
    message:
      "ok: fixture violates the boundary rules as expected:\n" +
      CASES.map((c) => `  - ${c.label}`).join("\n"),
  }
}

function main(): void {
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "depcruise",
      "fixtures/boundary-violation",
      "--config",
      ".dependency-cruiser.mts",
      "--no-cache",
    ],
    { encoding: "utf8" }
  )
  const verdict = judgeFixtureRun(run.status, `${run.stdout}${run.stderr}`)
  if (!verdict.ok) {
    console.error(verdict.message)
    process.exit(1)
  }
  console.log(verdict.message)
}

if (import.meta.main) main()
