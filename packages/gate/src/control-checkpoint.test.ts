import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CONFIRMATION,
  confirmAtTerminal,
  controlCheckpointCli,
} from "./control-checkpoint"
import { MemoryControlStore } from "./internal/control-checkpoint"
import { attachControlCheckpoint } from "./internal/control-checkpoint"
import { openControlDb } from "./internal/control-db"
import { CONTROL_DB_FILE, CONTROL_LOCK_FILE } from "./main"

let dir: string
let store: MemoryControlStore
let out: string[]
let err: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-checkpoint-cli-"))
  store = new MemoryControlStore()
  out = []
  err = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const output = {
  out: (line: string) => out.push(line),
  err: (line: string) => err.push(line),
}

function run(args: string[], confirmed: boolean): Promise<number> {
  return controlCheckpointCli(args, { EIDO_GATE_DATA_DIR: dir }, output, {
    confirm: () => Promise.resolve(confirmed),
    store,
  })
}

/** A database holding one unsigned pin the way an install from before the checkpoint has it. */
function legacyDatabase(): void {
  const db = openControlDb(join(dir, CONTROL_DB_FILE))
  db.prepare(
    "INSERT INTO connectors (name, manifest_json, manifest_hash, pinned_at, enabled, health, consecutive_failures) VALUES ('mail', '{}', ?, ?, 1, 'healthy', 0)"
  ).run("a".repeat(64), new Date().toISOString())
  db.close()
}

describe("control-checkpoint status", () => {
  it("reports an uninitialised checkpoint and exits non-zero", async () => {
    expect(await run(["status"], false)).toBe(1)
    expect(out).toEqual(["Control checkpoint: uninitialized"])
  })

  it("reports a ready checkpoint with its identity", async () => {
    const db = openControlDb(join(dir, CONTROL_DB_FILE))
    const guard = attachControlCheckpoint(db, { store })
    guard.close()
    db.close()
    expect(await run(["status"], false)).toBe(0)
    expect(out[0]).toBe("Control checkpoint: ready")
    expect(out[1]).toMatch(
      /^Installation [0-9a-f-]{36}, epoch [0-9a-f-]{36}, generation 1, 0 signed changes kept$/
    )
  })

  it("reports a database that no longer matches", async () => {
    const db = openControlDb(join(dir, CONTROL_DB_FILE))
    attachControlCheckpoint(db, { store }).close()
    db.close()
    legacyDatabase()
    expect(await run(["status"], false)).toBe(1)
    expect(out[0]).toBe("Control checkpoint: denied")
    expect(out[1]).toBe("Reason: control_state_mismatch")
  })
})

describe("control-checkpoint recover", () => {
  it("changes nothing without the owner's confirmation", async () => {
    legacyDatabase()
    expect(await run(["recover"], false)).toBe(1)
    expect(err).toEqual([
      `Not confirmed: type ${CONFIRMATION} at the terminal to continue`,
    ])
    expect(store.value).toBeUndefined()
    const db = openControlDb(join(dir, CONTROL_DB_FILE))
    expect(
      db.prepare("SELECT enabled FROM connectors WHERE name = 'mail'").get()
    ).toEqual({ enabled: 1 })
    db.close()
  })

  it("starts a new epoch once confirmed, disabling the connector it cannot trust", async () => {
    legacyDatabase()
    expect(await run(["recover"], true)).toBe(0)
    expect(out.at(-1)).toMatch(
      /^New epoch [0-9a-f-]{36}, generation 1: 0 passkeys revoked, 1 connectors disabled\.$/
    )
    const db = openControlDb(join(dir, CONTROL_DB_FILE))
    expect(
      db.prepare("SELECT enabled FROM connectors WHERE name = 'mail'").get()
    ).toEqual({ enabled: 0 })
    db.close()
    expect(await run(["status"], false)).toBe(0)
  })

  it("refuses while a gate holds the lock", async () => {
    legacyDatabase()
    const db = openControlDb(join(dir, CONTROL_DB_FILE))
    const guard = attachControlCheckpoint(db, {
      store: new MemoryControlStore(),
      lockPath: join(dir, CONTROL_LOCK_FILE),
    })
    expect(await run(["recover"], true)).toBe(1)
    expect(err[0]).toBe(
      "Control checkpoint command failed: a gate is running against this control store"
    )
    guard.close()
    db.close()
  })
})

describe("control-checkpoint arguments", () => {
  it("rejects an unknown command", async () => {
    expect(await run(["wipe"], true)).toBe(2)
    expect(err).toEqual(["usage: control-checkpoint status | recover"])
  })

  it("needs an absolute data directory and Keychain path", async () => {
    expect(
      await controlCheckpointCli(["status"], {}, output, {
        confirm: () => Promise.resolve(true),
        store,
      })
    ).toBe(2)
    expect(
      await controlCheckpointCli(
        ["status"],
        { EIDO_GATE_DATA_DIR: dir },
        output,
        { confirm: () => Promise.resolve(true) }
      )
    ).toBe(2)
    expect(err).toEqual([
      "EIDO_GATE_DATA_DIR must be set to an absolute path",
      "EIDO_GATE_KEYCHAIN_PATH must be set to an absolute path",
    ])
  })
})

describe("the terminal confirmation", () => {
  function streams(tty: boolean): {
    input: PassThrough & { isTTY?: boolean }
    output: PassThrough & { isTTY?: boolean }
  } {
    const input: PassThrough & { isTTY?: boolean } = new PassThrough()
    const output: PassThrough & { isTTY?: boolean } = new PassThrough()
    input.isTTY = tty
    output.isTTY = tty
    output.resume()
    return { input, output }
  }

  it("refuses without a terminal, whatever is piped in", async () => {
    const piped = streams(false)
    piped.input.write(`${CONFIRMATION}\n`)
    expect(await confirmAtTerminal(piped)).toBe(false)
  })

  it("accepts the exact phrase typed at a terminal", async () => {
    const tty = streams(true)
    const answer = confirmAtTerminal(tty)
    tty.input.write(`${CONFIRMATION}\n`)
    expect(await answer).toBe(true)
  })

  it("refuses any other answer", async () => {
    const tty = streams(true)
    const answer = confirmAtTerminal(tty)
    tty.input.write("yes\n")
    expect(await answer).toBe(false)
  })
})
