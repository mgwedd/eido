import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openControlDb } from "./control-db"
import { propose } from "./intents"
import { loadPolicy } from "./policy"
import { runTool } from "./control-db-tool"
import { sample } from "./test-fixtures"

// Each tool call opens an on-disk SQLite file and runs 15 migrations, each a durable commit.
// On the windows-latest runner under load the three disk tests took 3.6-9.4 s (issue #554)
// against under 0.5 s elsewhere; 30 s is over 3x the worst measured run.
const DISK_TIMEOUT_MS = 30_000

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-tool-"))
  path = join(dir, "eido-control.db")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("the control DB test tool", () => {
  it(
    "seeds the mail connector, so a send is approval tier",
    { timeout: DISK_TIMEOUT_MS },
    () => {
      expect(runTool(["seed", path])).toBe(JSON.stringify({ seeded: path }))
      const db = openControlDb(path)
      const options = { dataDir: dir, ownerAddresses: [], allowedRoots: [] }
      const result = propose(db, loadPolicy(db, options).policy, {
        intent: sample("email.send"),
        origin: "reactive",
      })
      db.close()
      expect(result).toMatchObject({ ok: true, tier: "approval" })
    }
  )

  it("lists audit rows and intent ids", { timeout: DISK_TIMEOUT_MS }, () => {
    runTool(["seed", path])
    const view: unknown = JSON.parse(runTool(["inspect", path]))
    expect(view).toMatchObject({
      audit: [{ seq: 1, action: "connector.pinned", target: "mail" }],
      intentIds: [],
    })
  })

  it(
    "rejects a pending intent as the owner",
    { timeout: DISK_TIMEOUT_MS },
    () => {
      runTool(["seed", path])
      const db = openControlDb(path)
      const options = { dataDir: dir, ownerAddresses: [], allowedRoots: [] }
      const result = propose(db, loadPolicy(db, options).policy, {
        intent: sample("email.send"),
        origin: "reactive",
      })
      db.close()
      const id = result.ok ? result.intentId : ""
      expect(JSON.parse(runTool(["reject", path, id]))).toEqual({
        ok: true,
        intentId: id,
        state: "rejected",
      })
      expect(JSON.parse(runTool(["reject", path, id]))).toEqual({
        ok: false,
        code: "not_pending",
      })
    }
  )

  it("refuses an unknown command or a missing path", () => {
    expect(() => runTool(["drop", path])).toThrow("unknown command drop")
    expect(() => runTool(["seed"])).toThrow("usage: seed|inspect")
  })
})
