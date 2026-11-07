// Entry point for `pnpm stack:supervisor`: the real effects, the socket, and a clean stop. With
// `--start-stack` (how the login agent com.eido.stack runs it, #629) it first runs `stack boot`,
// which starts the prod stack unless a stack process already runs, and exits 1 when that fails,
// so launchd tries again after its throttle.
import { unlinkSync } from "node:fs"

import { llamaEffects } from "../llama/effects.ts"
import { main as stackMain } from "./cli.ts"
import { stackEffects } from "./effects.ts"
import { createSupervisor, supervisorSocketPath } from "./supervisor.ts"
import { serveSupervisor, writeAtomic } from "./supervisor-server.ts"

const uid = process.getuid?.()
if (process.platform === "win32" || uid === undefined) {
  console.error(
    "FAIL: the stack supervisor runs on macOS and Linux only so far (#455)"
  )
  process.exit(1)
}

const stack = stackEffects()
if (process.argv.includes("--start-stack")) {
  const code = await stackMain(["boot"], stack)
  if (code !== 0) process.exit(1)
}
const log = (line: string) => console.log(line)
const supervisor = createSupervisor({
  stack: { ...stack, out: log, err: log },
  llama: { ...llamaEffects(), out: log, err: log },
  uid,
  pid: process.pid,
  writeSettings: writeAtomic,
  log,
})
const path = supervisorSocketPath(stack)
const server = await serveSupervisor(supervisor, path, uid)
log(`supervisor listening on ${path}`)

const stop = () => {
  server.close()
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
  process.exit(0)
}
process.once("SIGTERM", stop)
process.once("SIGINT", stop)
