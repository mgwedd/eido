// Proves rule 1 is enforced: dependency-cruiser must FAIL on the fixture.
import { spawnSync } from "node:child_process"

const run = spawnSync(
  "pnpm",
  [
    "exec",
    "depcruise",
    "fixtures/boundary-violation",
    "--config",
    ".dependency-cruiser.cjs",
    "--no-cache",
  ],
  { encoding: "utf8" }
)

if (run.status === 0) {
  console.error(
    "FAIL: dependency-cruiser passed on the boundary-violation fixture; rule 1 is not enforced."
  )
  process.exit(1)
}
if (!`${run.stdout}${run.stderr}`.includes("gate-internals-are-private")) {
  console.error(
    "FAIL: fixture failed for the wrong reason:\n" + run.stdout + run.stderr
  )
  process.exit(1)
}
console.log("ok: fixture violates gate-internals-are-private as expected")
