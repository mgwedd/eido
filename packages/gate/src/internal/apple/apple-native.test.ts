import { spawnSync } from "node:child_process"
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
