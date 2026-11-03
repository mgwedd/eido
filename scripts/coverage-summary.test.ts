import { describe, expect, test } from "vitest"
import { coverageRow, coverageTable } from "./coverage-summary.ts"

const total = (pct: number) => ({
  lines: { pct },
  statements: { pct },
  functions: { pct },
  branches: { pct },
})

describe("coverage summary", () => {
  test("renders percentages and flags those below 90", () => {
    expect(coverageRow("packages/gate", { total: total(95.5) })).toBe(
      "| packages/gate | 95.5% | 95.5% | 95.5% | 95.5% |"
    )
    expect(coverageRow("infra", { total: total(80) })).toContain(
      "80% (below 90%)"
    )
  })

  test("renders n/a when a package wrote no summary", () => {
    expect(coverageRow("scripts", null)).toBe(
      "| scripts | n/a | n/a | n/a | n/a |"
    )
  })

  test("renders a Markdown table", () => {
    expect(coverageTable(["| a | 1 |"])).toBe(
      [
        "## Test coverage per package (gate: 90% on every metric)\n",
        "| Package | lines | statements | functions | branches |",
        "| --- | --- | --- | --- | --- |",
        "| a | 1 |",
      ].join("\n")
    )
  })
})
