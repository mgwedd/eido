// Entry point for `pnpm stack:supervisor`: the real effects, the socket, and a clean stop.
import { unlinkSync } from "node:fs"

import { llamaEffects } from "../llama/effects.ts"
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
const log = (line: string) => console.log(line)
const supervisor = createSupervisor({
  stack: { ...stack, out: log, err: log },
  llama: { ...llamaEffects(), out: log, err: log },
  uid,
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
