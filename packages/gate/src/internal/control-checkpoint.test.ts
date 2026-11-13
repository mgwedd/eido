import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { append, verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import {
  egressAllowlist,
  getConnectorState,
  getPinnedManifest,
  pinManifest,
  pinnedOperation,
  prepareManifestPin,
} from "./connectors"
import type {
  ControlAuthorization,
  PreparedControlApproval,
} from "./control-approvals"
import {
  ControlStateError,
  MemoryControlStore,
  attachControlCheckpoint,
  controlStatus,
  controlTransaction,
  establishControlEpoch,
  inspectControlCheckpoint,
  parseControlRecord,
} from "./control-checkpoint"
import type { ControlCheckpoint } from "./control-checkpoint"
import { openControlDb } from "./control-db"
import {
  beginRegistration,
  registerCredential,
  revokeCredential,
} from "./credentials"
import { startEgressProxy } from "./egress"
import {
  kindTier,
  loadPolicy,
  preparePolicyChange,
  setPolicyOverrides,
} from "./policy"
import type { PolicyOptions } from "./policy"
import {
  MAIL_OPS,
  OWNER,
  WEBAUTHN,
  assertion,
  loggedText,
  manifest,
  registration,
  testAuthenticator,
} from "./test-fixtures"
import type { TestAuthenticator } from "./test-fixtures"
import { InMemoryVault } from "./vault/vault"

// ADR 0005 / #200: the control database is authority only while it matches the checkpoint held
// outside it. Every scenario here is a write to the database file that the gate did not make, or a
// crash, and the expectation is that authority reads refuse.

let dir: string
let dbPath: string
let store: MemoryControlStore
let handles: DatabaseSync[]
let guards: ControlCheckpoint[]
let signCount: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-checkpoint-"))
  dbPath = join(dir, "eido-control.db")
  store = new MemoryControlStore()
  handles = []
  guards = []
  signCount = 0
})

afterEach(() => {
  for (const guard of guards) guard.close()
  for (const handle of handles) if (handle.isOpen) handle.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Opens the database file and attaches the checkpoint, as a gate start does. */
function start(lockPath?: string): {
  db: DatabaseSync
  guard: ControlCheckpoint
} {
  const db = openControlDb(dbPath)
  handles.push(db)
  const guard = attachControlCheckpoint(db, {
    store,
    ...(lockPath === undefined ? {} : { lockPath }),
  })
  guards.push(guard)
  return { db, guard }
}

function stop(db: DatabaseSync, guard: ControlCheckpoint): void {
  guard.close()
  db.close()
}

function enrol(db: DatabaseSync, owner: TestAuthenticator): void {
  const begun = beginRegistration(db, "admin")
  if (!begun.ok) throw new Error("enrolment challenge refused")
  const result = registerCredential(
    db,
    WEBAUTHN,
    "admin",
    registration(owner, begun.challenge)
  )
  if (!result.ok) throw new Error(`enrolment refused: ${result.code}`)
}

/** The owner's device signing one prepared change; the challenge is built the way the device does. */
function sign(
  owner: TestAuthenticator,
  prepared: PreparedControlApproval
): ControlAuthorization & { assertion: ReturnType<typeof assertion> } {
  const challenge = createHash("sha256")
    .update(
      JSON.stringify([
        "eido.control.v1",
        prepared.purpose,
        prepared.target,
        prepared.id,
        prepared.payloadHash,
        prepared.nonce,
      ])
    )
    .digest("base64url")
  signCount += 1
  const signed = assertion(owner, challenge, { signCount })
  return {
    config: WEBAUTHN,
    request: { id: prepared.id, nonce: prepared.nonce, assertion: signed },
    assertion: signed,
  }
}

function pin(
  db: DatabaseSync,
  owner: TestAuthenticator,
  connector = manifest("mail", MAIL_OPS)
): void {
  pinManifest(
    db,
    connector,
    "owner",
    sign(owner, prepareManifestPin(db, connector))
  )
}

function policyOptions(): PolicyOptions {
  return {
    dataDir: dir,
    ownerAddresses: [OWNER],
    allowedRoots: ["notes"],
    storedAttendees: () => ({ ok: false }),
  }
}

const OVERRIDE = { version: 1, tiers: { "email.archive": "approval" } }

function setPolicy(db: DatabaseSync, owner: TestAuthenticator): void {
  setPolicyOverrides(
    db,
    OVERRIDE,
    "owner",
    sign(owner, preparePolicyChange(db, OVERRIDE))
  )
}

function denial(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    return error instanceof ControlStateError ? error.reason : "other-error"
  }
  return undefined
}

/** A forged pin the way a database writer would make it: a manifest row plus a matching audit row. */
function forgePin(db: DatabaseSync, name: string): void {
  const evil = manifest(name, MAIL_OPS)
  const hash = payloadHash(evil)
  db.prepare(
    "INSERT INTO connectors (name, manifest_json, manifest_hash, pinned_at, enabled, health, consecutive_failures) VALUES (?, ?, ?, ?, 1, 'healthy', 0)"
  ).run(name, JSON.stringify(evil), hash, new Date().toISOString())
  append(db, {
    actor: "owner",
    action: "connector.pinned",
    target: name,
    detailHash: hash,
  })
}

describe("an established installation", () => {
  it("initialises an empty database once and lets a signed pin and policy through, before and after restart", () => {
    const owner = testAuthenticator()
    const first = start()
    expect(first.guard.denied()).toBeUndefined()
    enrol(first.db, owner)
    pin(first.db, owner)
    setPolicy(first.db, owner)
    expect(getPinnedManifest(first.db, "mail")?.name).toBe("mail")
    expect(
      kindTier(
        first.db,
        loadPolicy(first.db, policyOptions()).policy,
        "email.archive"
      )
    ).toEqual({ tier: "approval" })
    const generation = first.guard.generation()
    stop(first.db, first.guard)

    const second = start()
    expect(second.guard.denied()).toBeUndefined()
    expect(second.guard.generation()).toBe(generation)
    expect(getPinnedManifest(second.db, "mail")?.name).toBe("mail")
    expect(
      kindTier(
        second.db,
        loadPolicy(second.db, policyOptions()).policy,
        "email.archive"
      )
    ).toEqual({ tier: "approval" })
    // A fresh signed change still works after the restart.
    const other = manifest("things", MAIL_OPS)
    pin(second.db, owner, other)
    expect(getPinnedManifest(second.db, "things")?.name).toBe("things")
    expect(second.guard.generation()).toBe((generation ?? 0) + 1)
  })

  it("advances the generation for a change and not for a refused one", () => {
    const owner = testAuthenticator()
    const { db, guard } = start()
    enrol(db, owner)
    const afterEnrol = guard.generation()
    expect(afterEnrol).toBeGreaterThan(1)
    expect(
      registerCredential(db, WEBAUTHN, "phone", registration(owner, "x"))
    ).toMatchObject({ ok: false, code: "admin_only" })
    expect(guard.generation()).toBe(afterEnrol)
  })
})

describe("forged control state in the database file", () => {
  it("refuses a forged manifest with a matching connector.pinned row, though the audit chain verifies", () => {
    const owner = testAuthenticator()
    const { db, guard } = start()
    enrol(db, owner)
    pin(db, owner)
    forgePin(db, "evil")
    expect(verifyChain(db).ok).toBe(true)
    expect(denial(() => pinnedOperation(db, "evil", "send"))).toBe(
      "control_state_mismatch"
    )
    expect(denial(() => egressAllowlist(db))).toBe("control_state_mismatch")
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe(
      "control_state_mismatch"
    )
    expect(denial(() => loadPolicy(db, policyOptions()))).toBe(
      "control_state_mismatch"
    )
    expect(controlStatus(db)).toEqual({
      enforced: true,
      denied: "control_state_mismatch",
    })
    stop(db, guard)

    const restarted = start()
    expect(restarted.guard.denied()).toBe("control_state_mismatch")
    expect(denial(() => pinnedOperation(restarted.db, "evil", "send"))).toBe(
      "control_state_mismatch"
    )
  })

  it("refuses a rewritten manifest for an already pinned connector", () => {
    const owner = testAuthenticator()
    const { db } = start()
    enrol(db, owner)
    pin(db, owner)
    db.prepare(
      "UPDATE connectors SET manifest_json = ?, manifest_hash = ? WHERE name = 'mail'"
    ).run("{}", "f".repeat(64))
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe(
      "control_state_mismatch"
    )
  })

  it("refuses a policy row replaced with another payload", () => {
    const owner = testAuthenticator()
    const { db } = start()
    enrol(db, owner)
    setPolicy(db, owner)
    const forged = { version: 1, tiers: { "email.archive": "auto" } }
    db.prepare(
      "UPDATE approved_policy SET payload_json = ?, payload_hash = ?"
    ).run(JSON.stringify(forged), payloadHash(forged))
    expect(denial(() => loadPolicy(db, policyOptions()))).toBe(
      "control_state_mismatch"
    )
  })

  it("refuses a swapped credential key and an un-revoked credential", () => {
    const owner = testAuthenticator()
    const spare = testAuthenticator()
    const { db } = start()
    enrol(db, owner)
    enrol(db, spare)
    expect(revokeCredential(db, "admin", spare.credentialId)).toEqual({
      ok: true,
    })
    expect(denial(() => getPinnedManifest(db, "mail"))).toBeUndefined()

    db.prepare(
      "UPDATE credentials SET revoked_at = NULL WHERE credential_id = ?"
    ).run(spare.credentialId)
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe(
      "control_state_mismatch"
    )
    db.prepare(
      "UPDATE credentials SET revoked_at = ? WHERE credential_id = ?"
    ).run(new Date().toISOString(), spare.credentialId)
    expect(denial(() => getPinnedManifest(db, "mail"))).toBeUndefined()

    const attacker = testAuthenticator()
    db.prepare(
      "UPDATE credentials SET public_key = ? WHERE credential_id = ?"
    ).run(attacker.publicKey, owner.credentialId)
    expect(denial(() => getPinnedManifest(db, "mail"))).toBe(
      "control_state_mismatch"
    )
  })

  it("refuses a database rolled back to an older signed pin, including after restart", () => {
    const owner = testAuthenticator()
    const first = start()
    enrol(first.db, owner)
    pin(first.db, owner)
    first.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const older = join(dir, "older.db")
    copyFileSync(dbPath, older)
    const v2 = { ...manifest("mail", MAIL_OPS), version: 2 }
    pin(first.db, owner, v2)
    stop(first.db, first.guard)
    copyFileSync(older, dbPath)

    const restarted = start()
    expect(restarted.guard.denied()).toBe("control_state_mismatch")
    expect(denial(() => getPinnedManifest(restarted.db, "mail"))).toBe(
      "control_state_mismatch"
    )
  })

  it("refuses a replayed approval and leaves the state and generation as they were", () => {
    const owner = testAuthenticator()
    const { db, guard } = start()
    enrol(db, owner)
    const mail = manifest("mail", MAIL_OPS)
    const authorization = sign(owner, prepareManifestPin(db, mail))
    pinManifest(db, mail, "owner", authorization)
    const generation = guard.generation()
    expect(() => pinManifest(db, mail, "owner", authorization)).toThrow(
      "control approval refused"
    )
    expect(guard.generation()).toBe(generation)
    expect(denial(() => getPinnedManifest(db, "mail"))).toBeUndefined()
  })

  it("refuses a control change that arrives without its signed assertion", () => {
    const owner = testAuthenticator()
    const { db, guard } = start()
    enrol(db, owner)
    const generation = guard.generation()
    const before = db.prepare("SELECT count(*) AS n FROM connectors").get()
    expect(
      denial(() =>
        controlTransaction(db, "roster", () => {
          forgePin(db, "evil")
        })
      )
    ).toBe("unsigned_control_change")
    expect(db.prepare("SELECT count(*) AS n FROM connectors").get()).toEqual(
      before
    )
    expect(guard.generation()).toBe(generation)
  })
})

describe("crash, missing and damaged checkpoints", () => {
  it("denies after a commit that the checkpoint never recorded, including after restart", () => {
    const owner = testAuthenticator()
    const first = start()
    enrol(first.db, owner)
    const before = store.value
    store.failSaves = true
    expect(denial(() => pin(first.db, owner))).toBe("checkpoint_write_failed")
    store.failSaves = false
    expect(store.value).toBe(before)
    expect(denial(() => getPinnedManifest(first.db, "mail"))).toBe(
      "checkpoint_write_failed"
    )
    stop(first.db, first.guard)

    const restarted = start()
    expect(restarted.guard.denied()).toBe("control_state_mismatch")
    expect(denial(() => getPinnedManifest(restarted.db, "mail"))).toBe(
      "control_state_mismatch"
    )
  })

  it("does not initialise a checkpoint from an existing database", () => {
    const owner = testAuthenticator()
    const first = start()
    enrol(first.db, owner)
    pin(first.db, owner)
    stop(first.db, first.guard)
    store.value = undefined

    const restarted = start()
    expect(restarted.guard.denied()).toBe("uninitialized")
    expect(store.value).toBeUndefined()
    expect(denial(() => getPinnedManifest(restarted.db, "mail"))).toBe(
      "uninitialized"
    )
  })

  it("denies on a damaged record and on an unreadable store", () => {
    const owner = testAuthenticator()
    const first = start()
    enrol(first.db, owner)
    stop(first.db, first.guard)

    store.value = '{"version":1,'
    const damaged = start()
    expect(damaged.guard.denied()).toBe("store_malformed")
    stop(damaged.db, damaged.guard)

    store.failLoads = true
    const unreadable = start()
    expect(unreadable.guard.denied()).toBe("store_unreadable")
  })

  it("denies when a stored assertion no longer verifies against the roster", () => {
    const owner = testAuthenticator()
    const first = start()
    enrol(first.db, owner)
    pin(first.db, owner)
    stop(first.db, first.guard)
    const record = parseControlRecord(store.value ?? "")
    const stored = record?.provenance[0]
    expect(stored).toBeDefined()
    // Flip one bit of the signature: the pin row is untouched, but its proof no longer holds.
    const bytes = Buffer.from(stored?.assertion.signature ?? "", "base64url")
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
    const damaged = {
      ...record,
      provenance: [
        {
          ...stored,
          assertion: {
            ...stored?.assertion,
            signature: bytes.toString("base64url"),
          },
        },
      ],
    }
    store.value = JSON.stringify(damaged)
    expect(start().guard.denied()).toBe("reverify_failed")
  })

  it("denies a second gate instance and takes a stale lock over from a dead process", () => {
    const lock = join(dir, "eido-control.lock")
    const first = start(lock)
    expect(first.guard.denied()).toBeUndefined()
    const second = start(lock)
    expect(second.guard.denied()).toBe("second_instance")
    expect(denial(() => getPinnedManifest(second.db, "mail"))).toBe(
      "second_instance"
    )
    // The denied instance releasing must not free the lock the first one holds.
    second.guard.close()
    expect(start(lock).guard.denied()).toBe("second_instance")
    first.guard.close()

    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    })
    writeFileSync(lock, "999999")
    expect(start(lock).guard.denied()).toBeUndefined()
    kill.mockRestore()
  })

  it("stops a gate whose record was moved on by another instance from overwriting it", () => {
    const owner = testAuthenticator()
    const a = start()
    enrol(a.db, owner)
    const b = start()
    expect(b.guard.denied()).toBeUndefined()
    pin(a.db, owner)
    const moved = store.value
    expect(denial(() => pin(b.db, owner, manifest("things", MAIL_OPS)))).toBe(
      "stale_generation"
    )
    expect(store.value).toBe(moved)
  })
})

describe("supervised recovery", () => {
  it("revokes and disables everything signed under the old state, then accepts fresh signed changes", () => {
    const owner = testAuthenticator()
    const first = start()
    enrol(first.db, owner)
    pin(first.db, owner)
    setPolicy(first.db, owner)
    stop(first.db, first.guard)
    store.value = undefined

    const db = openControlDb(dbPath)
    handles.push(db)
    const result = establishControlEpoch(db, { store })
    expect(result).toMatchObject({
      generation: 1,
      revokedCredentials: 1,
      disabledConnectors: 1,
    })
    db.close()

    const restarted = start()
    expect(restarted.guard.denied()).toBeUndefined()
    // Nothing signed before the epoch is trusted: the pin is disabled and the policy is not anchored.
    expect(getPinnedManifest(restarted.db, "mail")).toBeUndefined()
    expect(getConnectorState(restarted.db, "mail")?.enabled).toBe(false)
    expect(() => loadPolicy(restarted.db, policyOptions())).toThrow(
      "approved policy is not anchored"
    )
    // The old passkey is revoked, so it cannot sign the re-pin.
    const old = manifest("mail", MAIL_OPS)
    expect(() =>
      pinManifest(
        restarted.db,
        old,
        "owner",
        sign(owner, prepareManifestPin(restarted.db, old))
      )
    ).toThrow("control approval refused")

    const fresh = testAuthenticator()
    enrol(restarted.db, fresh)
    pin(restarted.db, fresh, old)
    expect(getPinnedManifest(restarted.db, "mail")?.name).toBe("mail")
    stop(restarted.db, restarted.guard)

    const again = start()
    expect(again.guard.denied()).toBeUndefined()
    expect(getPinnedManifest(again.db, "mail")?.name).toBe("mail")
  })

  it("refuses recovery while a gate holds the lock, and reports state without changing it", () => {
    const lock = join(dir, "eido-control.lock")
    const running = start(lock)
    expect(() =>
      establishControlEpoch(running.db, { store, lockPath: lock })
    ).toThrow("a gate is running against this control store")
    expect(inspectControlCheckpoint(running.db, store)).toMatchObject({
      state: "ready",
    })
    store.value = undefined
    expect(inspectControlCheckpoint(running.db, store)).toEqual({
      state: "uninitialized",
    })
  })
})

describe("what the protected record keeps", () => {
  it("retains the complete assertion and ceremony data of each signed change, and logs none of it", () => {
    const owner = testAuthenticator()
    const { db } = start()
    enrol(db, owner)
    const mail = manifest("mail", MAIL_OPS)
    const prepared = prepareManifestPin(db, mail)
    const authorization = sign(owner, prepared)
    pinManifest(db, mail, "owner", authorization)
    const record = parseControlRecord(store.value ?? "")
    const kept = record?.provenance.find((p) => p.target === "mail")
    const signed = authorization.assertion
    expect(kept).toMatchObject({
      approvalId: prepared.id,
      purpose: "manifest.pin",
      target: "mail",
      payloadHash: prepared.payloadHash,
      nonce: prepared.nonce,
      credentialId: owner.credentialId,
      signCount: 1,
      assertion: {
        authenticatorData: signed.authenticatorData,
        clientDataJSON: signed.clientDataJSON,
        signature: signed.signature,
      },
    })
    expect(record?.roster).toEqual([
      {
        credentialId: owner.credentialId,
        publicKey: owner.publicKey,
        revoked: false,
      },
    ])
    const logged = loggedText(db)
    expect(logged).not.toContain(signed.signature)
    expect(logged).not.toContain(signed.authenticatorData)
    expect(logged).not.toContain(owner.publicKey)
  })

  it("replaces an older assertion for the same target with the newer one", () => {
    const owner = testAuthenticator()
    const { db } = start()
    enrol(db, owner)
    pin(db, owner)
    pin(db, owner, { ...manifest("mail", MAIL_OPS), version: 2 })
    const record = parseControlRecord(store.value ?? "")
    expect(
      record?.provenance
        .filter((p) => p.target === "mail")
        .map((p) => p.signCount)
    ).toEqual([2])
  })
})

describe("the read egress proxy", () => {
  it("answers 503 instead of routing while the control state is unverified", async () => {
    const owner = testAuthenticator()
    const { db } = start()
    enrol(db, owner)
    pin(db, owner, {
      ...manifest("mail", MAIL_OPS),
      egress: {
        hosts: [
          { host: "api.example.com", methods: ["GET"], pathPrefixes: ["/v1"] },
        ],
      },
    })
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("body"))
    const proxy = await startEgressProxy({
      db,
      vault: new InMemoryVault(),
      fetch: upstream,
    })
    try {
      forgePin(db, "evil")
      const response = await fetch(proxy.baseUrl, {
        headers: {
          "x-eido-connector": "mail",
          "x-eido-target": "https://api.example.com/v1/messages/one",
        },
      })
      expect(response.status).toBe(503)
      expect(upstream).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })
})
