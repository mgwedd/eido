import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createIntentClient, GateRequestError } from "./internal/client"
import {
  ControlStateError,
  MemoryControlStore,
  controlStatus,
} from "./internal/control-checkpoint"
import type { RetrySchedule } from "./internal/control-checkpoint"
import { runningGate } from "./internal/runtime"
import { sample, socketAddress, WEBAUTHN } from "./internal/test-fixtures"
import { InMemoryVault, KeychainLockedError } from "./internal/vault/vault"
import type { VaultKey } from "./internal/vault/vault"
import {
  GATE_LOG_FILE,
  assertOneKeychain,
  finishLockedStart,
  gateConfig,
  runGate,
} from "./main"
import type { GateConfig, RunningGate, VaultConfig } from "./main"

// #870: a gate started while the control checkpoint's Keychain is locked finishes starting,
// denies every policy read as keychain_locked, and loads its policy and push key in the same
// lifetime once the locked-store retry verifies the checkpoint.

// The profile-audit key is read once, generated, then read back.
const PROFILE_AUDIT_KEY = {
  connector: "eido-profile-audit:1",
  kind: "api_key",
  client: "none",
}

let dir: string
let gate: RunningGate | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-locked-start-"))
  const keychainPath = join(dir, "gate.keychain-db")
  writeFileSync(keychainPath, "", { mode: 0o600 })
})
afterEach(async () => {
  await gate?.close()
  gate = undefined
  rmSync(dir, { recursive: true, force: true })
})

function config(push: boolean): GateConfig {
  const base = gateConfig({
    EIDO_GATE_DATA_DIR: join(dir, "gate"),
    EIDO_GATE_SOCKET: socketAddress(dir, "gate.sock"),
    EIDO_GATE_CONTROL_SOCKET: socketAddress(dir, "control.sock"),
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
    EIDO_GATE_KEYCHAIN_PATH: join(dir, "gate.keychain-db"),
  })
  return push
    ? {
        ...base,
        push: {
          vault: { kind: "keychain", path: join(dir, "gate.keychain-db") },
          subject: "mailto:ops@example.invalid",
          windowMs: 60_000,
          nudgeThreshold: 5,
          nudgeWindowMs: 120_000,
        },
      }
    : base
}

/** A vault that records each read, and fails every read when told to. */
class CountingVault extends InMemoryVault {
  reads: VaultKey[] = []
  failReads = false
  override async get(key: VaultKey): Promise<string | undefined> {
    this.reads.push(key)
    if (this.failReads) throw new Error("Keychain is locked")
    return super.get(key)
  }
}

/** One GET over a gate socket: the status and the parsed body. */
function getOver(
  socketPath: string,
  path: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: "GET" }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        })
      })
    })
    request.on("error", reject)
    request.end()
  })
}

/** The gate log lines, parsed. */
function logLines(): unknown[] {
  return readFileSync(join(dir, "gate", GATE_LOG_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
}

/** The gate's own lifecycle events, without the per-request lines. */
function events(): unknown[] {
  return logLines()
    .map((line) =>
      typeof line === "object" && line !== null && "event" in line
        ? line.event
        : undefined
    )
    .filter(
      (event) => typeof event !== "string" || !event.startsWith("request")
    )
}

function deniedReason(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    if (error instanceof ControlStateError) return error.reason
    throw error
  }
  throw new Error("expected a control-state denial")
}

async function startLocked(push: boolean) {
  const store = new MemoryControlStore()
  store.locked = true
  const vault = new CountingVault()
  const retries: (() => void)[] = []
  const schedule: RetrySchedule = (run) => {
    retries.push(run)
    return () => undefined
  }
  gate = await runGate(
    config(push),
    undefined,
    () => vault,
    () => store,
    undefined,
    schedule
  )
  const client = createIntentClient({
    socketPath: config(push).socketPath,
  })
  const propose = () =>
    client.propose({ intent: sample("email.draft"), origin: "reactive" })
  const unlock = () => {
    store.locked = false
    const run = retries.shift()
    if (run === undefined) throw new Error("no retry was scheduled")
    run()
  }
  return { store, vault, propose, unlock, client }
}

describe("runGate with the control checkpoint locked (#870)", () => {
  it("finishes starting, denies policy reads and reads no secret", async () => {
    const { vault, propose, client } = await startLocked(true)
    expect(deniedReason(() => runningGate().policy)).toBe("keychain_locked")
    const refused = await propose().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused).toBeInstanceOf(GateRequestError)
    expect(refused).toMatchObject({ status: 500, code: "unavailable" })
    // A route that reads no policy still answers.
    expect(await client.listPending()).toEqual([])
    expect(vault.reads).toEqual([])
    expect(events()).toEqual(["control_checkpoint_denied", "started"])
  })

  it("reports the deny reason on the control socket while locked and none once the retry verifies (#916)", async () => {
    const { unlock } = await startLocked(false)
    const control = config(false).controlSocketPath
    expect(await getOver(control, "/audit/control")).toEqual({
      status: 200,
      body: { enforced: true, denied: "keychain_locked" },
    })
    // The data plane is never given the checkpoint status.
    expect(
      (await getOver(config(false).socketPath, "/audit/control")).status
    ).toBe(404)
    unlock()
    expect(await getOver(control, "/audit/control")).toEqual({
      status: 200,
      body: { enforced: true, denied: null },
    })
  })

  it("loads the policy and the push key once the retry verifies, in the same lifetime", async () => {
    const { vault, propose, unlock } = await startLocked(true)
    unlock()
    expect(runningGate().policy.allowedRoots).toEqual([])
    // No connector is pinned, so the policy refuses the kind instead of the gate failing.
    expect(await propose()).toMatchObject({
      tier: "forbidden",
      reason: "no_operation",
    })
    await vi.waitFor(() => {
      expect(vault.reads).toEqual([
        PROFILE_AUDIT_KEY,
        PROFILE_AUDIT_KEY,
        { connector: "eido-web-push", kind: "api_key", client: "write" },
      ])
    })
    expect(events()).toEqual([
      "control_checkpoint_denied",
      "started",
      "control_checkpoint_verified",
      "policy_loaded",
    ])
  })

  it("logs secrets that still cannot be read and keeps serving policy reads", async () => {
    const { vault, propose, unlock } = await startLocked(true)
    vault.failReads = true
    unlock()
    await vi.waitFor(() => {
      expect(events().slice(2)).toEqual([
        "control_checkpoint_verified",
        "policy_loaded",
        "profile_audit_unavailable",
        "push_unavailable",
      ])
    })
    expect(await propose()).toMatchObject({ tier: "forbidden" })
  })

  it("stays denied when the unlocked store does not verify", async () => {
    const { store, unlock, propose } = await startLocked(false)
    store.value = "not a record"
    unlock()
    expect(deniedReason(() => runningGate().policy)).toBe("store_malformed")
    await expect(propose()).rejects.toMatchObject({ status: 500 })
    expect(events()).toEqual([
      "control_checkpoint_denied",
      "started",
      "control_checkpoint_denied",
    ])
  })

  it("still refuses to start for any other denial", async () => {
    const store = new MemoryControlStore()
    store.failLoads = true
    await expect(
      runGate(
        config(false),
        undefined,
        () => new InMemoryVault(),
        () => store
      )
    ).rejects.toMatchObject({ reason: "store_unreadable" })
    expect(() => runningGate()).toThrow("the gate is not started")
  })
})

describe("finishLockedStart (#870)", () => {
  const steps = (pending: boolean) => ({
    pending: () => pending,
    resume: vi.fn((): string[] => []),
    prepare: vi.fn(() => Promise.resolve()),
    log: vi.fn(),
  })

  it("does nothing for a gate that already has its policy", () => {
    const s = steps(false)
    finishLockedStart(s)
    expect(s.resume).not.toHaveBeenCalled()
    expect(s.prepare).not.toHaveBeenCalled()
    expect(s.log).not.toHaveBeenCalled()
  })

  it("logs the overlay error count of the resumed policy, then prepares the secrets", () => {
    const s = steps(true)
    s.resume.mockImplementation(() => [
      "overlay entry 1 is invalid",
      "overlay entry 2 is invalid",
    ])
    finishLockedStart(s)
    expect(s.log.mock.calls).toEqual([["policy_loaded", { overlayErrors: 2 }]])
    expect(s.prepare).toHaveBeenCalledOnce()
  })

  it("logs a failed load and leaves push alone", () => {
    const s = steps(true)
    s.resume.mockImplementation(() => {
      throw new Error("permissions.default.json is invalid")
    })
    finishLockedStart(s)
    expect(s.prepare).not.toHaveBeenCalled()
    expect(s.log.mock.calls).toEqual([["policy_load_failed"]])
  })
})

/** A vault whose reads fail as a locked keychain's do, while `locked` is set. */
class LockingVault extends InMemoryVault {
  locked = true
  override async get(key: VaultKey): Promise<string | undefined> {
    if (this.locked) throw new KeychainLockedError()
    return super.get(key)
  }
}

function lockRows(): string[] {
  return runningGate()
    .db.prepare(
      "SELECT action FROM audit_log WHERE action LIKE 'control.keychain%' ORDER BY seq"
    )
    .all()
    .map((row) => String(row["action"]))
}

describe("runGate when a secret read finds the keychain locked (#878)", () => {
  async function startVerifiedThenLocked() {
    const store = new MemoryControlStore()
    const vault = new LockingVault()
    const retries: { run: () => void; delayMs: number }[] = []
    const schedule: RetrySchedule = (run, delayMs) => {
      retries.push({ run, delayMs })
      return () => undefined
    }
    // The checkpoint store is readable, so the gate starts verified; the profile-audit key read
    // at start is the first secret read, and it finds the keychain locked.
    gate = await runGate(
      config(false),
      undefined,
      () => vault,
      () => store,
      undefined,
      schedule
    )
    const client = createIntentClient({ socketPath: config(false).socketPath })
    const propose = () =>
      client.propose({ intent: sample("email.draft"), origin: "reactive" })
    return { store, vault, retries, propose }
  }

  it("moves the running gate into keychain_locked, schedules the retry and reports it", async () => {
    const { store, retries, propose } = await startVerifiedThenLocked()
    const record = store.value
    expect(record).toBeDefined()
    expect(retries.map((retry) => retry.delayMs)).toEqual([5_000])
    expect(controlStatus(runningGate().db)).toEqual({
      enforced: true,
      denied: "keychain_locked",
    })
    expect(logLines()).toContainEqual(
      expect.objectContaining({
        event: "control_checkpoint_denied",
        reason: "keychain_locked",
      })
    )
    expect(events()).toEqual([
      "control_checkpoint_denied",
      "profile_audit_unavailable",
      "started",
    ])
    await expect(propose()).rejects.toMatchObject({
      status: 500,
      code: "unavailable",
    })
    // No control change: the checkpoint record is the one the gate started with.
    expect(store.value).toBe(record)
    expect(lockRows()).toEqual(["control.keychain_locked"])
  })

  it("leaves keychain_locked on the retry once the keychain unlocks, with one row each way", async () => {
    const { vault, retries, propose } = await startVerifiedThenLocked()
    const first = retries.shift()
    if (first === undefined) throw new Error("no retry was scheduled")
    // The checkpoint store is readable, so the retry verifies on its first run.
    vault.locked = false
    first.run()
    expect(controlStatus(runningGate().db)).toEqual({ enforced: true })
    expect(events().slice(-1)).toEqual(["control_checkpoint_verified"])
    expect(await propose()).toMatchObject({
      tier: "forbidden",
      reason: "no_operation",
    })
    expect(lockRows()).toEqual([
      "control.keychain_locked",
      "control.keychain_lock_cleared",
    ])
  })
})

describe("vaults on a keychain other than the control checkpoint's (#919)", () => {
  // gateConfig gives every vault the checkpoint's keychain; only a hand-built config differs.
  const other: VaultConfig = {
    kind: "keychain",
    path: "/synthetic/other.keychain-db",
  }
  const onOther: Record<string, (base: GateConfig) => GateConfig> = {
    vault: (base) => ({ ...base, vault: other }),
    profileAudit: (base) => ({
      ...base,
      profileAudit: { vault: other, epoch: "1" },
    }),
    push: (base) => ({
      ...base,
      push: {
        vault: other,
        subject: "mailto:ops@example.invalid",
        windowMs: 60_000,
        nudgeThreshold: 5,
        nudgeWindowMs: 120_000,
      },
    }),
    bridge: (base) => ({
      ...base,
      bridge: {
        config: {
          host: "127.0.0.1",
          imapPort: 1143,
          smtpPort: 1025,
          tls: "none",
          username: "assistant@example.invalid",
          searchFolders: ["INBOX"],
        },
        vault: other,
      },
    }),
    gmail: (base) => ({
      ...base,
      gmail: { vault: other, clientId: "client.example.invalid" },
    }),
    egress: (base) => ({
      ...base,
      egress: {
        vault: other,
        port: 0,
        clientIds: { "gmail-read": "client.example.invalid" },
      },
    }),
  }

  it.each(Object.keys(onOther))("refuses %s on another keychain", (field) => {
    const build = onOther[field]
    if (build === undefined) throw new Error(`no config for ${field}`)
    expect(() => {
      assertOneKeychain(build(config(false)))
    }).toThrow("every gate vault must use the control checkpoint's keychain")
  })

  it("accepts every vault on the checkpoint's keychain, and a file vault beside it", () => {
    expect(() => {
      assertOneKeychain(config(true))
    }).not.toThrow()
    const push = config(true).push
    if (push === undefined) throw new Error("no push config")
    const file: VaultConfig = {
      kind: "file",
      path: join(dir, "push.json"),
      devFlag: true,
    }
    expect(() => {
      assertOneKeychain({ ...config(false), push: { ...push, vault: file } })
    }).not.toThrow()
  })

  it("accepts any keychain when no checkpoint is enforced", () => {
    const unenforced: GateConfig = { ...config(false), vault: other }
    delete unenforced.controlCheckpoint
    expect(() => {
      assertOneKeychain(unenforced)
    }).not.toThrow()
  })

  it("stops runGate before it opens a vault, the store or the data directory", async () => {
    const vaults = vi.fn(() => new InMemoryVault())
    const stores = vi.fn(() => new MemoryControlStore())
    const build = onOther["push"]
    if (build === undefined) throw new Error("no push config")
    await expect(
      runGate(build(config(false)), undefined, vaults, stores)
    ).rejects.toThrow(
      "every gate vault must use the control checkpoint's keychain"
    )
    expect(vaults).not.toHaveBeenCalled()
    expect(stores).not.toHaveBeenCalled()
    expect(existsSync(join(dir, "gate"))).toBe(false)
  })
})
