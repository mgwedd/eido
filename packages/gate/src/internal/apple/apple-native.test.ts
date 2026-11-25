import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "vitest"
import { validateGateAppleResponse } from "@eido/schemas"

const path = process.env["EIDO_EVENTKIT_HELPER"]
test.skipIf(process.platform !== "darwin" || path === undefined)(
  "native Helper rejects an unknown operation before accessing EventKit",
  () => {
    if (path === undefined) throw new Error("native Helper path required")
    const child = spawnSync(path, [], {
      input: JSON.stringify({
        operation: "delete_event",
        args: { id: "synthetic-only" },
      }),
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(0)
    const parsed: unknown = JSON.parse(child.stdout)
    expect(validateGateAppleResponse(parsed)).toEqual({
      ok: true,
      value: { ok: false, code: "invalid_request" },
    })
    expect(child.stderr).toBe("")
  }
)

// A gate-like parent starts the Helper as the runner does (own process group, private
// pipes). Its stdin comes from this test, so the Helper is still busy reading when the
// parent is SIGKILLed: without the Helper's parent watch it would block there forever.
const GATE = `
const { spawn } = require("node:child_process")
const helper = spawn(process.argv[1], [], {
  cwd: "/",
  detached: true,
  env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  stdio: [3, "ignore", "ignore"],
})
process.stdout.write(String(helper.pid) + "\\n")
setInterval(() => {}, 60_000)
`
/** How long the Helper may outlive a SIGKILLed gate. */
const ORPHAN_BOUND_MS = 2_000

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(process.platform !== "darwin" || path === undefined)(
  "native Helper exits when the gate that started it is SIGKILLed",
  async () => {
    if (path === undefined) throw new Error("native Helper path required")
    const gate = spawn(process.execPath, ["-e", GATE, path], {
      stdio: ["ignore", "pipe", "ignore", "pipe"],
    })
    let pid: number | undefined
    try {
      if (gate.stdout === null) throw new Error("gate stdout is piped")
      const event: unknown[] = await once(gate.stdout, "data")
      pid = Number(String(event[0]).trim())
      expect(alive(pid)).toBe(true)
      const exited = once(gate, "exit")
      gate.kill("SIGKILL")
      await exited
      const deadline = Date.now() + ORPHAN_BOUND_MS
      while (alive(pid) && Date.now() < deadline) await delay(25)
      expect(alive(pid)).toBe(false)
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL")
      gate.kill("SIGKILL")
      gate.stdio[3]?.destroy()
    }
  }
)
