// docs/injection-eval.md is one run's results, regenerated whole on a clean checkout of main
// (packages/core/src/eval/injection-cli.ts). A feature branch that commits it conflicts with
// every other branch that does, and mixes rows from different runs. So a pull request may
// change it only on its own: the report alone, nothing else.
import { spawnSync } from "node:child_process"

export const REPORT = "docs/injection-eval.md"

/** An error message when `files` mixes the report with other changes, else null. */
export function judgeChangedFiles(files: readonly string[]): string | null {
  if (!files.includes(REPORT)) return null
  const others = files.filter((f) => f !== REPORT)
  if (others.length === 0) return null
  return (
    `${REPORT} is regenerated on main and lands in a pull request of its own.\n` +
    `Restore it with: git checkout origin/main -- ${REPORT}\n` +
    `and put your eval numbers in the pull request body. Other changed files: ${others.join(", ")}`
  )
}

function git(args: string[]): string | null {
  const r = spawnSync("git", args, { encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : null
}

/** Changed files, the same way scripts/verify.ts finds them; null when there is no base. */
export function changedFiles(
  env: Readonly<Record<string, string | undefined>>,
  run: (args: string[]) => string | null = git
): string[] | null {
  if (env["CI"] === "true") {
    if (env["GITHUB_EVENT_NAME"] !== "pull_request") return null
    const out = run(["diff", "--name-only", "HEAD^1", "HEAD"])
    return out === null ? null : out.split("\n").filter(Boolean)
  }
  const base = run(["merge-base", "origin/main", "HEAD"])
  if (base === null) return null
  const out = run(["diff", "--name-only", base])
  return out === null ? null : out.split("\n").filter(Boolean)
}

function main(): void {
  const files = changedFiles(process.env)
  const error = files === null ? null : judgeChangedFiles(files)
  if (error !== null) {
    console.error(`FAIL: ${error}`)
    process.exit(1)
  }
  console.log(`${REPORT}: ok`)
}

if (import.meta.main) main()
