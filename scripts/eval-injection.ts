import { spawnSync } from "node:child_process"
import { join } from "node:path"

export type Spawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: "inherit" }
) => { status: number | null }

export function runEvalInjection(
  args: readonly string[] = [],
  spawn: Spawner = spawnSync
): number {
  const root = join(import.meta.dirname, "..")
  const result = spawn(
    "pnpm",
    ["--filter", "@eido/core", "eval-injection", "--", ...args],
    {
      cwd: root,
      stdio: "inherit",
    }
  )
  return result.status ?? 1
}

function main(): void {
  const code = runEvalInjection(process.argv.slice(2))
  process.exit(code)
}

if (import.meta.main) main()
