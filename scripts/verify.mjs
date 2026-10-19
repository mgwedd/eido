// `pnpm verify`: the one list of checks. CI runs this same script, so the two cannot drift.
// To add, remove or reorder a check, edit STEPS below; nothing else needs to change.
//
//   pnpm verify             limit turbo tasks to changed packages (--affected) when origin/main exists, full run in CI
//   pnpm verify --full      always run every turbo task (the CI behaviour)
//   pnpm verify --affected  force the affected subset
//
// Docs and images only (.md, .png, .jpg, .jpeg, .gif, .webp): only the steps marked `always` run.
// Output is one line per step; a failing step prints its output, its name and the command to rerun it.
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

const args = process.argv.slice(2)
const inCI = process.env.CI === "true"
const sh = (cmd) =>
  spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
const git = (cmd) => {
  const r = sh(`git ${cmd}`)
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

const files = changedFiles()
const docsOnly =
  files !== null && files.every((f) => /\.(md|png|jpe?g|gif|webp)$/.test(f))
const hasBase = !inCI && git("rev-parse --verify -q origin/main") !== null
const affected =
  args.includes("--affected") || (hasBase && !args.includes("--full"))

// always: runs even for docs-only changes. advisory: reported, never fails the run.
const STEPS = [
  {
    name: "Typecheck, lint, test (with coverage)",
    cmd: `pnpm turbo run typecheck lint test${affected ? " --affected" : ""}`,
    summary: true,
  },
  { name: "Dependency boundaries", cmd: "pnpm check:deps" },
  {
    name: "Boundary-violation fixture must fail",
    cmd: "pnpm check:deps-fixture",
  },
  { name: "Gate dependency allowlist", cmd: "pnpm check:gate-deps" },
  { name: "Lint covers TypeScript files", cmd: "pnpm check:lint-coverage" },
  {
    name: "No stray JavaScript files",
    cmd: "pnpm check:no-js && pnpm check:no-js-fixture",
    always: true,
  },
  { name: "Secret scan", cmd: "pnpm check:secrets", always: true },
  {
    name: "Turborepo boundaries (advisory)",
    cmd: "pnpm boundaries",
    advisory: true,
  },
  { name: "Formatting", cmd: "pnpm format:check", always: true },
  { name: "Version consistency", cmd: "pnpm check:versions", always: true },
]

if (docsOnly) console.log("Docs and images only: running the light checks.")
else if (affected) console.log("Turbo tasks limited to changed packages.")

function fail(step, out) {
  process.stdout.write(out)
  console.error(`\nFAILED: ${step.name}\nrerun:  ${step.cmd}`)
  console.error(
    inCI
      ? "also run locally: pnpm verify"
      : "fix it, then run pnpm verify again"
  )
  process.exit(1)
}

for (const step of STEPS) {
  if (docsOnly && !step.always) continue
  const start = Date.now()
  const r = sh(step.cmd)
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  const secs = ((Date.now() - start) / 1000).toFixed(1)
  if (step.summary && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      sh("node scripts/coverage-summary.mjs").stdout
    )
  }
  if (r.status === 0) {
    console.log(`ok   ${step.name} (${secs}s)`)
  } else if (step.advisory) {
    console.log(`warn ${step.name} (${secs}s), advisory; rerun: ${step.cmd}`)
  } else {
    fail(step, out)
  }
}
console.log("verify passed")
