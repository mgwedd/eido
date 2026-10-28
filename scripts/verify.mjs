// `pnpm verify`: one `turbo run` over every repo check. CI runs this same script, so the two cannot drift.
// Turborepo runs the tasks in parallel where independent and caches passing ones; the root tasks
// (`//#check:*`, `//#format:check`) and their inputs are defined in turbo.json.
// To add or remove a check, edit TASKS below and turbo.json; nothing else needs to change.
//
//   pnpm verify             limit tasks to changed packages (--affected) when origin/main exists, full run in CI
//   pnpm verify --full      always run every task (the CI behaviour)
//   pnpm verify --affected  force the affected subset
//
// Docs and images only (.md, .png, .jpg, .jpeg, .gif, .webp): only the `always` tasks run.
// Run one check alone with `pnpm turbo run <task>`, for example `pnpm turbo run //#check:secrets`.
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
const inCI = process.env.CI === "true"
const git = (cmd) => {
  const r = spawnSync(`git ${cmd}`, { shell: true, encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : null
}

// Changed files, or null when there is no base to compare against (then everything runs).
function changedFiles() {
  if (inCI) {
    if (process.env.GITHUB_EVENT_NAME !== "pull_request") return null
    const out = git("diff --name-only HEAD^1 HEAD")
    return out === null ? null : out.split("\n").filter(Boolean)
  }
  const base = git("merge-base origin/main HEAD")
  if (base === null) return null
  const tracked = git(`diff --name-only ${base}`) ?? ""
  const untracked = git("ls-files --others --exclude-standard") ?? ""
  return `${tracked}\n${untracked}`.split("\n").filter(Boolean)
}

// always: runs even for docs-only changes.
const TASKS = [
  { task: "typecheck" },
  { task: "lint" },
  { task: "test" },
  { task: "//#check:deps" },
  { task: "//#check:deps-fixture" },
  { task: "//#check:gate-deps" },
  { task: "//#check:lint-coverage" },
  { task: "//#check:invariants" },
  { task: "//#check:no-js", always: true },
  { task: "//#check:no-js-fixture", always: true },
  { task: "//#check:no-telemetry", always: true },
  { task: "//#check:no-telemetry-fixture", always: true },
  { task: "//#check:secrets", always: true },
  { task: "//#format:check", always: true },
  { task: "//#check:versions", always: true },
]

const files = changedFiles()
const docsOnly =
  files !== null && files.every((f) => /\.(md|png|jpe?g|gif|webp)$/.test(f))
const hasBase = !inCI && git("rev-parse --verify -q origin/main") !== null
const affected =
  args.includes("--affected") || (hasBase && !args.includes("--full"))

const tasks = TASKS.filter((t) => !docsOnly || t.always).map((t) => t.task)
// `--affected` also filters root tasks; the root package counts as changed when its own files do.
const cmd = `pnpm turbo run ${tasks.join(" ")}${affected ? " --affected" : ""}`

if (docsOnly) console.log("Docs and images only: running the light checks.")
else if (affected) console.log("Tasks limited to changed packages.")
console.log(`$ ${cmd}`)

const run = spawnSync(cmd, { shell: true, stdio: "inherit" })
if (inCI && process.env.GITHUB_STEP_SUMMARY && !docsOnly) {
  const summary = spawnSync("node", ["scripts/coverage-summary.mjs"], {
    encoding: "utf8",
  })
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.stdout ?? "")
}
if (run.status !== 0) {
  console.error(`\nFAILED. Rerun the failing task alone: pnpm turbo run <task>`)
  console.error(
    inCI
      ? "also run locally: pnpm verify"
      : "fix it, then run pnpm verify again"
  )
  process.exit(run.status ?? 1)
}
console.log("verify passed")
