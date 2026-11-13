import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pinManifest, prepareManifestPin } from "./connectors"
import type {
  ControlAuthorization,
  PreparedControlApproval,
} from "./control-approvals"
import {
  ControlStateError,
  MemoryControlStore,
  attachControlCheckpoint,
  captureControlAssertion,
  controlStatus,
  controlTransaction,
  inspectControlCheckpoint,
  parseControlRecord,
  requireControlState,
} from "./control-checkpoint"
import type { ControlCheckpoint } from "./control-checkpoint"
import { openControlDb } from "./control-db"
import {
  beginRegistration,
  registerCredential,
  revokeCredential,
} from "./credentials"
import {
  MAIL_OPS,
  WEBAUTHN,
  assertion,
  manifest,
  registration,
  testAuthenticator,
} from "./test-fixtures"
import type { TestAuthenticator } from "./test-fixtures"

// Record parsing, transaction nesting and the refusals of the checkpoint protocol itself, one
// behaviour per case. The record under test comes from a real signed change, then is damaged.

let dir: string
let store: MemoryControlStore
let db: DatabaseSync
let guard: ControlCheckpoint
let owner: TestAuthenticator

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-checkpoint-records-"))
  store = new MemoryControlStore()
  db = openControlDb(join(dir, "eido-control.db"))
  guard = attachControlCheckpoint(db, { store })
  owner = testAuthenticator()
})

afterEach(() => {
  guard.close()
  if (db.isOpen) db.close()
  rmSync(dir, { recursive: true, force: true })
})

function signed(prepared: PreparedControlApproval): ControlAuthorization {
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
  return {
    config: WEBAUTHN,
    request: {
      id: prepared.id,
      nonce: prepared.nonce,
      assertion: assertion(owner, challenge, { signCount: 1 }),
    },
  }
}

/** A real record: one enrolled passkey and one signed pin. */
function realRecord(): Record<string, unknown> {
  const begun = beginRegistration(db, "admin")
  if (!begun.ok) throw new Error("enrolment challenge refused")
  const done = registerCredential(
    db,
    WEBAUTHN,
    "admin",
    registration(owner, begun.challenge)
  )
  if (!done.ok) throw new Error("enrolment refused")
  const connector = manifest("mail", MAIL_OPS)
  pinManifest(db, connector, "owner", signed(prepareManifestPin(db, connector)))
  return JSON.parse(store.value ?? "") as Record<string, unknown>
}

function reasonOf(work: () => unknown): string | undefined {
  try {
    work()
  } catch (error) {
    return error instanceof ControlStateError ? error.reason : "other-error"
  }
  return undefined
}

describe("parsing the protected record", () => {
  it("accepts the record the gate wrote", () => {
    realRecord()
    expect(parseControlRecord(store.value ?? "")?.version).toBe(1)
  })

  it("rejects text that is not JSON", () => {
    expect(parseControlRecord("{not json")).toBeUndefined()
  })

  it("rejects a record over the size cap", () => {
    expect(parseControlRecord(" ".repeat(256 * 1024 + 1))).toBeUndefined()
  })

  it("rejects an array and an unknown version", () => {
    const record = realRecord()
    expect(parseControlRecord("[]")).toBeUndefined()
    expect(
      parseControlRecord(JSON.stringify({ ...record, version: 2 }))
    ).toBeUndefined()
  })

  it("rejects a roster that is not a list and a roster entry with the wrong shape", () => {
    const record = realRecord()
    expect(
      parseControlRecord(JSON.stringify({ ...record, roster: {} }))
    ).toBeUndefined()
    expect(
      parseControlRecord(
        JSON.stringify({
          ...record,
          roster: [{ credentialId: "a", publicKey: "b", revoked: "no" }],
        })
      )
    ).toBeUndefined()
  })

  it("rejects provenance that is not a list, an entry that is not an object, and an entry missing its assertion", () => {
    const record = realRecord()
    const entries = record["provenance"] as Record<string, unknown>[]
    const first = entries[0] ?? {}
    expect(
      parseControlRecord(JSON.stringify({ ...record, provenance: "x" }))
    ).toBeUndefined()
    expect(
      parseControlRecord(JSON.stringify({ ...record, provenance: [7] }))
    ).toBeUndefined()
    expect(
      parseControlRecord(
        JSON.stringify({
          ...record,
          provenance: [{ ...first, assertion: null }],
        })
      )
    ).toBeUndefined()
    expect(
      parseControlRecord(
        JSON.stringify({
          ...record,
          provenance: [{ ...first, signCount: "1" }],
        })
      )
    ).toBeUndefined()
  })

  it("rejects a generation that is not a positive integer and a snapshot hash that is not hex", () => {
    const record = realRecord()
    expect(
      parseControlRecord(JSON.stringify({ ...record, generation: 0 }))
    ).toBeUndefined()
    expect(
      parseControlRecord(JSON.stringify({ ...record, generation: 1.5 }))
    ).toBeUndefined()
    expect(
      parseControlRecord(JSON.stringify({ ...record, snapshotHash: "XYZ" }))
    ).toBeUndefined()
  })
})

describe("status and inspection", () => {
  it("reports an unattached database as not enforced", () => {
    const bare = openControlDb(join(dir, "bare.db"))
    try {
      expect(controlStatus(bare)).toEqual({ enforced: false })
    } finally {
      bare.close()
    }
  })

  it("reports a verified database as enforced and not denied, and a mismatch with its reason", () => {
    realRecord()
    expect(controlStatus(db)).toEqual({ enforced: true, denied: undefined })
    db.exec("UPDATE connectors SET manifest_hash = 'forged'")
    expect(controlStatus(db)).toEqual({
      enforced: true,
      denied: "control_state_mismatch",
    })
  })

  it("inspection reports an unreadable store", () => {
    store.failLoads = true
    expect(inspectControlCheckpoint(db, store)).toEqual({
      state: "denied",
      reason: "store_unreadable",
    })
  })

  it("inspection reports a malformed record", () => {
    store.value = "{}"
    expect(inspectControlCheckpoint(db, store)).toEqual({
      state: "denied",
      reason: "store_malformed",
    })
  })

  it("inspection reports a record whose stored signature no longer verifies", () => {
    const record = realRecord()
    const entries = record["provenance"] as {
      assertion: { signature: string }
    }[]
    const first = entries[0]
    if (first === undefined) throw new Error("no provenance")
    first.assertion.signature = Buffer.alloc(64).toString("base64url")
    store.value = JSON.stringify(record)
    expect(inspectControlCheckpoint(db, store)).toMatchObject({
      state: "denied",
      reason: "reverify_failed",
    })
  })
})

describe("reverifying stored assertions", () => {
  function withProvenance(change: (entry: Record<string, unknown>) => void) {
    const record = realRecord()
    const entries = record["provenance"] as Record<string, unknown>[]
    const first = entries[0]
    if (first === undefined) throw new Error("no provenance")
    change(first)
    store.value = JSON.stringify(record)
  }

  it("inspection reports a signature from a passkey that is not on the roster", () => {
    withProvenance((entry) => {
      entry["credentialId"] = "not-enrolled"
    })
    expect(inspectControlCheckpoint(db, store)).toMatchObject({
      reason: "reverify_failed",
    })
  })

  it("inspection reports stored assertion bytes that are not valid base64url", () => {
    withProvenance((entry) => {
      entry["assertion"] = {
        authenticatorData: "***",
        clientDataJSON: "***",
        signature: "***",
      }
    })
    expect(inspectControlCheckpoint(db, store)).toMatchObject({
      reason: "reverify_failed",
    })
  })

  it("inspection reports a sign count that differs from the signed authenticator data", () => {
    withProvenance((entry) => {
      entry["signCount"] = 99
    })
    expect(inspectControlCheckpoint(db, store)).toMatchObject({
      reason: "reverify_failed",
    })
  })
})

describe("reads inside a caller's transaction", () => {
  it("verifies without opening or committing a transaction of its own", () => {
    realRecord()
    db.exec("BEGIN")
    try {
      expect(() => requireControlState(db)).not.toThrow()
      expect(db.isTransaction).toBe(true)
    } finally {
      db.exec("ROLLBACK")
    }
  })
})

describe("the transaction protocol", () => {
  it("lets a nested control change join the outer transaction", () => {
    realRecord()
    const before = guard.generation()
    const out = controlTransaction(db, "roster", () =>
      controlTransaction(db, "roster", () => "inner")
    )
    expect(out).toBe("inner")
    expect(guard.generation()).toBe(before)
  })

  it("refuses a control change started inside someone else's transaction", () => {
    realRecord()
    db.exec("BEGIN")
    try {
      expect(reasonOf(() => controlTransaction(db, "roster", () => 1))).toBe(
        "unsupported_transaction"
      )
    } finally {
      db.exec("ROLLBACK")
    }
  })

  it("refuses a signed change that carries no assertion and rolls it back", () => {
    realRecord()
    const before = guard.generation()
    expect(
      reasonOf(() =>
        controlTransaction(db, "signed", () =>
          db.exec("UPDATE connectors SET manifest_hash = 'forged'")
        )
      )
    ).toBe("unsigned_control_change")
    expect(
      db.prepare("SELECT manifest_hash FROM connectors").get()
    ).not.toMatchObject({
      manifest_hash: "forged",
    })
    expect(guard.generation()).toBe(before)
  })

  it("refuses a roster change made inside a signed change", () => {
    realRecord()
    expect(
      reasonOf(() =>
        controlTransaction(db, "signed", () =>
          db.exec(
            "UPDATE credentials SET revoked_at = '2026-01-01T00:00:00.000Z'"
          )
        )
      )
    ).toBe("unsigned_control_change")
  })

  it("refuses a pin or policy change made inside a roster change", () => {
    realRecord()
    expect(
      reasonOf(() =>
        controlTransaction(db, "roster", () =>
          db.exec("UPDATE connectors SET manifest_hash = 'forged'")
        )
      )
    ).toBe("unsigned_control_change")
  })

  it("leaves the generation alone when a signed change turns out to change nothing", () => {
    realRecord()
    const before = guard.generation()
    expect(controlTransaction(db, "signed", () => "noop")).toBe("noop")
    expect(guard.generation()).toBe(before)
  })

  it("refuses a change when the protected record moved on under this gate", () => {
    realRecord()
    store.value = (store.value ?? "") + " "
    expect(reasonOf(() => controlTransaction(db, "roster", () => 1))).toBe(
      "stale_generation"
    )
  })

  it("denies when the store cannot be read at the start of a change", () => {
    realRecord()
    store.failLoads = true
    expect(reasonOf(() => controlTransaction(db, "roster", () => 1))).toBe(
      "store_unreadable"
    )
    store.failLoads = false
    expect(guard.denied()).toBe("store_unreadable")
  })

  it("refuses a change while the guard is denied", () => {
    realRecord()
    store.failLoads = true
    reasonOf(() => requireControlState(db))
    store.failLoads = false
    db.exec("UPDATE connectors SET manifest_hash = 'forged'")
    expect(reasonOf(() => controlTransaction(db, "roster", () => 1))).toBe(
      "control_state_mismatch"
    )
  })

  it("denies after the database commits but the protected record cannot be written", () => {
    realRecord()
    store.failSaves = true
    expect(
      reasonOf(() => revokeCredential(db, "admin", owner.credentialId))
    ).toBe("checkpoint_write_failed")
    expect(guard.denied()).toBe("checkpoint_write_failed")
  })

  it("refuses to capture an assertion whose audit row does not exist", () => {
    realRecord()
    expect(
      reasonOf(() =>
        controlTransaction(db, "signed", () =>
          captureControlAssertion(db, {
            approvalId: "a",
            purpose: "manifest.pin",
            target: "mail",
            payloadHash: "h",
            nonce: "n",
            approvalRefHash: "r",
            credentialId: "c",
            signCount: 1,
            auditSeq: 999_999,
            assertion: {
              authenticatorData: "",
              clientDataJSON: "",
              signature: "",
            },
          })
        )
      )
    ).toBe("unsigned_control_change")
  })

  it("ignores a captured assertion outside a control transaction", () => {
    realRecord()
    const before = guard.generation()
    captureControlAssertion(db, {
      approvalId: "a",
      purpose: "manifest.pin",
      target: "mail",
      payloadHash: "h",
      nonce: "n",
      approvalRefHash: "r",
      credentialId: "c",
      signCount: 1,
      auditSeq: 1,
      assertion: { authenticatorData: "", clientDataJSON: "", signature: "" },
    })
    expect(guard.generation()).toBe(before)
  })
})

describe("the single-instance lock", () => {
  it("propagates a lock-file error that is not a second instance", () => {
    const other = openControlDb(join(dir, "other.db"))
    try {
      expect(() =>
        attachControlCheckpoint(other, {
          store: new MemoryControlStore(),
          lockPath: join(dir, "missing-directory", "eido-control.lock"),
        })
      ).toThrow()
    } finally {
      other.close()
    }
  })
})
