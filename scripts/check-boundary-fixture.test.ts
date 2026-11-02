import { describe, expect, test } from "vitest"
import { CASES, judgeFixtureRun } from "./check-boundary-fixture.ts"

// One violation line per case, in the format dependency-cruiser prints.
const LINES = [
  "error gate-internals-are-private: packages/core/src/bad.ts → packages/gate/src/internal/x.ts",
  "error not-to-unresolvable: packages/core/src/bad-workspace.ts → @eido/gate/internal",
  "error gate-internals-are-private: packages/core/src/bad-vault.ts → packages/gate/src/internal/vault/v.ts",
  "error gate-imports-schemas-only: packages/gate/src/bad-core-import.ts → packages/core/src/index.ts",
  "error gate-has-no-parsers: packages/gate/src/bad-parser-import.ts → node_modules/pdfjs-dist",
  "error web-test-fixtures-are-test-only: apps/web/app/bad-fixture-import.ts → apps/web/test/f.ts",
  "error web-test-fixtures-are-test-only: apps/web/app/bad-fixture-alias-import.ts → apps/web/test/f.ts",
]

describe("judgeFixtureRun", () => {
  test("has one sample line per case", () => {
    expect(LINES).toHaveLength(CASES.length)
  })

  test("passes when the run failed for every expected rule and file", () => {
    const verdict = judgeFixtureRun(1, LINES.join("\n"))
    expect(verdict.ok).toBe(true)
    expect(verdict.message).toContain("bad-vault.ts")
  })

  test("fails when dependency-cruiser passes on the fixture", () => {
    const verdict = judgeFixtureRun(0, "")
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain("boundary rules are not enforced")
  })

  test.each(CASES.map((c, i) => [c.label, i] as const))(
    "fails when the case is missing: %s",
    (label, index) => {
      const output = LINES.filter((_, i) => i !== index).join("\n")
      const verdict = judgeFixtureRun(1, output)
      expect(verdict.ok).toBe(false)
      expect(verdict.message).toContain(label)
    }
  )

  test("fails when the right rule fires on the wrong file", () => {
    const wrongFile = LINES.map((l) => l.replace("bad-vault.ts", "other.ts"))
    expect(judgeFixtureRun(1, wrongFile.join("\n")).ok).toBe(false)
  })

  test("fails when the right file fires under the wrong rule", () => {
    const wrongRule = LINES.map((l) =>
      l.replace("gate-has-no-parsers", "no-orphans")
    )
    expect(judgeFixtureRun(1, wrongRule.join("\n")).ok).toBe(false)
  })

  test("a failure with no output at all fails every case", () => {
    const verdict = judgeFixtureRun(2, "")
    expect(verdict.ok).toBe(false)
    for (const c of CASES) expect(verdict.message).toContain(c.label)
  })
})
