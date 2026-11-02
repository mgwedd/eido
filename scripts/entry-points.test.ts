import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

// The scripts run directly under Node's type stripping (`node scripts/x.ts`), so a non-erasable
// construct would break them at run time even when the tests, which go through vite, still pass.
const root = join(import.meta.dirname, "..")
const run = (script: string, args: string[] = []) =>
  spawnSync(process.execPath, [join("scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
  })

describe("entry points under node type stripping", () => {
  test.each([
    ["check-no-js.ts", ["--self-test"], "ok: self-test"],
    ["check-no-telemetry.ts", ["--self-test"], "ok: self-test"],
    ["check-gate-deps.ts", [], "ok: gate dependencies"],
    ["check-exact-versions.ts", [], "ok: "],
    ["check-invariant-tests.ts", [], "ok: found all"],
    ["coverage-summary.ts", [], "## Test coverage per package"],
  ])("%s %j runs and succeeds", (script, args, expected) => {
    const result = run(script, args)
    expect(result.stderr).not.toContain("SyntaxError")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(expected)
  })
})
