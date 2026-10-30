// Prints a Markdown table of per-package coverage (read from each package's
// coverage/coverage-summary.json, written by `vitest run --coverage`) for the CI job summary.
// Thresholds are enforced by vitest itself (90% on all four metrics, see each vitest.config.ts);
// this script only reports.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packages = [
  "packages/gate",
  "packages/core",
  "packages/schemas",
  "packages/ui",
  "apps/web",
  "infra",
]
const metrics = ["lines", "statements", "functions", "branches"]

const rows = packages.map((dir) => {
  const file = path.join(root, dir, "coverage", "coverage-summary.json")
  if (!existsSync(file))
    return `| ${dir} | ${metrics.map(() => "n/a").join(" | ")} |`
  const { total } = JSON.parse(readFileSync(file, "utf8"))
  const cells = metrics.map(
    (m) => `${total[m].pct}%${total[m].pct < 90 ? " (below 90%)" : ""}`
  )
  return `| ${dir} | ${cells.join(" | ")} |`
})

console.log("## Test coverage per package (gate: 90% on every metric)\n")
console.log(`| Package | ${metrics.join(" | ")} |`)
console.log(`| --- | ${metrics.map(() => "---").join(" | ")} |`)
console.log(rows.join("\n"))
