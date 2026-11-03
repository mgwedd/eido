// Prints a Markdown table of per-package coverage (read from each package's
// coverage/coverage-summary.json, written by `vitest run --coverage`) for the CI job summary.
// Thresholds are enforced by vitest itself (90% on all four metrics, see each vitest.config.ts);
// this script only reports.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const PACKAGES = [
  "packages/gate",
  "packages/core",
  "packages/schemas",
  "packages/ui",
  "apps/web",
  "infra",
]
const METRICS = ["lines", "statements", "functions", "branches"] as const

type Summary = { total: Record<(typeof METRICS)[number], { pct: number }> }

/** One Markdown table row; `summary` is null when the package wrote no coverage summary. */
export function coverageRow(dir: string, summary: Summary | null): string {
  if (!summary) return `| ${dir} | ${METRICS.map(() => "n/a").join(" | ")} |`
  const cells = METRICS.map(
    (m) =>
      `${summary.total[m].pct}%${summary.total[m].pct < 90 ? " (below 90%)" : ""}`
  )
  return `| ${dir} | ${cells.join(" | ")} |`
}

export function coverageTable(rows: string[]): string {
  return [
    "## Test coverage per package (gate: 90% on every metric)\n",
    `| Package | ${METRICS.join(" | ")} |`,
    `| --- | ${METRICS.map(() => "---").join(" | ")} |`,
    rows.join("\n"),
  ].join("\n")
}

function main(): void {
  const root = path.resolve(import.meta.dirname, "..")
  const rows = PACKAGES.map((dir) => {
    const file = path.join(root, dir, "coverage", "coverage-summary.json")
    return coverageRow(
      dir,
      existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as Summary)
        : null
    )
  })
  console.log(coverageTable(rows))
}

if (import.meta.main) main()
