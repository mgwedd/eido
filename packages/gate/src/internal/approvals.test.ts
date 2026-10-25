import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import {
  checkApproval,
  commitApproval,
  issueNonce,
  reject,
  signCountAccepted,
  verifyApproval,
} from "./approvals"
import type { ApprovalRequest, VerifiedApproval } from "./approvals"
import { verifyChain } from "./audit"

import { openControlDb } from "./control-db"
import {
  beginRegistration,
  registerCredential,
  revokeCredential,
} from "./credentials"
import { intentHistory, intentStatus, propose } from "./intents"
import { loadPolicy } from "./policy"
import type { Policy } from "./policy"
import {
  BODY_MARKER,
  MAIL_OPS,
  OWNER,
  WEBAUTHN,
  assertion,
  auditRows,
  deviceChallenge,
  loggedText,
  manifest,
  registration,
  sample,
  setup,
  testAuthenticator,
  signedPin,
} from "./test-fixtures"
import type { CeremonyOptions, Setup, TestAuthenticator } from "./test-fixtures"

let current: Setup | undefined
const cleanups: (() => void)[] = []

afterEach(() => {
  current?.cleanup()
  current = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function enrol(
  db: DatabaseSync,
  auth = testAuthenticator()
): TestAuthenticator {
  const begun = beginRegistration(db, "admin")
  if (!begun.ok) throw new Error("enrolment challenge refused")
  const result = registerCredential(
    db,
    WEBAUTHN,
    "admin",
    registration(auth, begun.challenge)
  )
  if (!result.ok) throw new Error(`enrolment refused: ${result.code}`)
  return auth
}

type World = { db: DatabaseSync; policy: Policy; auth: TestAuthenticator }

function world(): World {
  current = setup()
  return { db: current.db, policy: current.policy, auth: enrol(current.db) }
}

/** Proposes an approval-tier send; it lands pending with a current nonce. */
function pendingSend(
  w: Pick<World, "db" | "policy">,
  subject = "Hello"
): string {
  const result = propose(w.db, w.policy, {
    intent: sample("email.send", { subject }),
    origin: "reactive",
  })
  if (!result.ok || result.state !== "pending") {
    throw new Error("fixture send did not land pending")
  }
  return result.intentId
}

type Prepared = { intentId: string; nonce: string; payloadHash: string }

function prepare(db: DatabaseSync, intentId: string): Prepared {
  const prepared = issueNonce(db, intentId)
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`)
  return prepared
}

/** What the device posts after signing the card it was shown. */
function signed(
  auth: TestAuthenticator,
  prepared: Prepared,
  options: CeremonyOptions = {}
): ApprovalRequest {
  return {
    intentId: prepared.intentId,
    nonce: prepared.nonce,
    assertion: assertion(
      auth,
      deviceChallenge(prepared.payloadHash, prepared.intentId, prepared.nonce),
      options
    ),
  }
}

const REFUSED = { ok: false, error: "approval_refused" }

function approvalRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT intent_id, bundle_hash, decision, signature, credential_id, sign_count, nonce, reason_code FROM approvals ORDER BY rowid"
    )
    .all()
}

function actions(db: DatabaseSync, target: string): string[] {
  return auditRows(db)
    .filter((row) => row.target === target)
    .map((row) => row.action)
}

function storedSignCount(db: DatabaseSync, credentialId: string): number {
  return Number(
    db
      .prepare("SELECT sign_count FROM credentials WHERE credential_id = ?")
      .get(credentialId)?.["sign_count"]
  )
}

function chainHolds(db: DatabaseSync): void {
  expect(verifyChain(db).ok).toBe(true)
}

describe("issuePending", () => {
  it("gives an approval-tier intent a current nonce of 32 random bytes", () => {
    const w = world()
    const id = pendingSend(w)
    const row = w.db
      .prepare("SELECT current_nonce FROM intents WHERE id = ?")
      .get(id)
    const nonce = String(row?.["current_nonce"])
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(nonce, "base64url")).toHaveLength(32)
  })

  it("gives an auto-tier intent no nonce", () => {
    const w = world()
    const result = propose(w.db, w.policy, {
      intent: sample("email.draft"),
      origin: "reactive",
    })
    if (!result.ok) throw new Error("fixture draft refused")
    const row = w.db
      .prepare("SELECT current_nonce FROM intents WHERE id = ?")
      .get(result.intentId)
    expect(row?.["current_nonce"]).toBeNull()
  })
})

describe("a valid approval", () => {
  it("moves pending to approved exactly once and writes one approvals row", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    const request = signed(w.auth, prepared, { signCount: 7 })

    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual({
      ok: true,
      intentId: id,
      state: "approved",
    })
    expect(intentStatus(w.db, id)?.state).toBe("approved")
    expect(approvalRows(w.db)).toEqual([
      {
        intent_id: id,
        bundle_hash: prepared.payloadHash,
        decision: "approved",
        signature: request.assertion.signature,
        credential_id: w.auth.credentialId,
        sign_count: 7,
        nonce: prepared.nonce,
        reason_code: null,
      },
    ])
    expect(storedSignCount(w.db, w.auth.credentialId)).toBe(7)
    const approvedSteps = intentHistory(w.db, id).filter(
      (entry) => entry.to === "approved"
    )
    expect(approvedSteps).toEqual([
      expect.objectContaining({ from: "pending", actor: "approver" }),
    ])
    chainHolds(w.db)
  })

  it("accepts a counter that stays at zero, for authenticators that do not count", () => {
    const w = world()
    for (const subject of ["One", "Two"]) {
      const request = signed(w.auth, prepare(w.db, pendingSend(w, subject)))
      expect(verifyApproval(w.db, WEBAUTHN, request).ok).toBe(true)
    }
    expect(storedSignCount(w.db, w.auth.credentialId)).toBe(0)
  })
})

describe("replay", () => {
  it("invariant: approval replay and a second assertion are refused", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    const first = signed(w.auth, prepared, { signCount: 1 })
    expect(verifyApproval(w.db, WEBAUTHN, first).ok).toBe(true)

    expect(verifyApproval(w.db, WEBAUTHN, first)).toEqual(REFUSED)
    const second = signed(w.auth, prepared, { signCount: 2 })
    expect(verifyApproval(w.db, WEBAUTHN, second)).toEqual(REFUSED)

    expect(approvalRows(w.db)).toHaveLength(1)
    expect(storedSignCount(w.db, w.auth.credentialId)).toBe(1)
    expect(actions(w.db, id).filter((a) => a.startsWith("approval."))).toEqual([
      "approval.refused.nonce_used",
      "approval.refused.nonce_used",
    ])
    chainHolds(w.db)
  })
})

describe("nonce reuse", () => {
  it("invariant: a nonce from another intent is refused", () => {
    const w = world()
    const a = prepare(w.db, pendingSend(w, "A"))
    const b = pendingSend(w, "B")
    const bPrepared = prepare(w.db, b)
    // The device signs B's payload but presents A's nonce.
    const request = signed(w.auth, { ...bPrepared, nonce: a.nonce })

    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(intentStatus(w.db, b)?.state).toBe("pending")
    expect(actions(w.db, b)).toContain("approval.refused.foreign_nonce")
    chainHolds(w.db)
  })

  it("invariant: a nonce the gate never issued is refused", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    const request = signed(w.auth, { ...prepared, nonce: "x".repeat(43) })
    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(actions(w.db, id)).toContain("approval.refused.unknown_nonce")
  })

  it("invariant: a nonce after it was used is refused", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    expect(verifyApproval(w.db, WEBAUTHN, signed(w.auth, prepared)).ok).toBe(
      true
    )
    const used = w.db
      .prepare("SELECT used_at FROM approval_nonces WHERE nonce = ?")
      .get(prepared.nonce)
    expect(used?.["used_at"]).toEqual(expect.any(String))
    expect(verifyApproval(w.db, WEBAUTHN, signed(w.auth, prepared))).toEqual(
      REFUSED
    )
    expect(actions(w.db, id)).toContain("approval.refused.nonce_used")
  })
})

describe("issueNonce", () => {
  it("invariant: a superseded nonce is refused", () => {
    const w = world()
    const id = pendingSend(w)
    const first = prepare(w.db, id)
    const second = prepare(w.db, id)
    expect(second.nonce).not.toBe(first.nonce)
    const current = w.db
      .prepare("SELECT current_nonce FROM intents WHERE id = ?")
      .get(id)
    expect(current?.["current_nonce"]).toBe(second.nonce)

    expect(verifyApproval(w.db, WEBAUTHN, signed(w.auth, first))).toEqual(
      REFUSED
    )
    expect(intentStatus(w.db, id)?.state).toBe("pending")
    expect(actions(w.db, id)).toContain("approval.refused.stale_nonce")

    expect(verifyApproval(w.db, WEBAUTHN, signed(w.auth, second)).ok).toBe(true)
    chainHolds(w.db)
  })

  it("returns the stored canonical payload and its hash", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = issueNonce(w.db, id)
    const row = w.db
      .prepare("SELECT payload_json, payload_hash FROM intents WHERE id = ?")
      .get(id)
    expect(prepared).toMatchObject({
      ok: true,
      intentId: id,
      payload: row?.["payload_json"],
      payloadHash: row?.["payload_hash"],
    })
  })

  it("gives a non-pending intent no nonce", () => {
    const w = world()
    const approved = propose(w.db, w.policy, {
      intent: sample("email.draft"),
      origin: "reactive",
    })
    if (!approved.ok) throw new Error("fixture draft refused")
    expect(issueNonce(w.db, approved.intentId)).toEqual({
      ok: false,
      code: "not_pending",
    })
    expect(issueNonce(w.db, "no-such-intent")).toEqual({
      ok: false,
      code: "not_found",
    })
    const issued = w.db
      .prepare("SELECT count(*) AS n FROM approval_nonces WHERE intent_id = ?")
      .get(approved.intentId)
    expect(issued?.["n"]).toBe(0)
  })
})

describe("an approval over a changed payload", () => {
  function editStoredPayload(
    db: DatabaseSync,
    id: string,
    rehash: boolean
  ): void {
    const row = db
      .prepare("SELECT payload_json FROM intents WHERE id = ?")
      .get(id)
    const edited = String(row?.["payload_json"]).replace("Hello", "Wire funds")
    db.prepare("UPDATE intents SET payload_json = ? WHERE id = ?").run(
      edited,
      id
    )
    if (rehash) {
      const hash = createHash("sha256").update(edited, "utf8").digest("hex")
      db.prepare("UPDATE intents SET payload_hash = ? WHERE id = ?").run(
        hash,
        id
      )
    }
  }

  it.each([
    ["the payload alone was altered", false],
    ["the payload and its stored hash were altered together", true],
  ])(
    "invariant: approval is rejected with an alert when %s",
    (_name, rehash) => {
      const w = world()
      const id = pendingSend(w)
      const prepared = prepare(w.db, id)
      const request = signed(w.auth, prepared)
      editStoredPayload(w.db, id, rehash)

      expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
      expect(intentStatus(w.db, id)?.state).toBe("rejected")
      expect(actions(w.db, id)).toContain("alert.approval_mismatch")
      expect(approvalRows(w.db)).toEqual([
        expect.objectContaining({
          intent_id: id,
          decision: "rejected",
          signature: null,
          reason_code: "approval_mismatch",
        }),
      ])
      expect(intentHistory(w.db, id).at(-1)).toMatchObject({
        from: "pending",
        to: "rejected",
        actor: "system",
        reason: "approval_mismatch",
      })
      chainHolds(w.db)
    }
  )

  it("is rejected when the stored hash no longer matches the stored payload", () => {
    const w = world()
    const id = pendingSend(w)
    const request = signed(w.auth, prepare(w.db, id))
    w.db
      .prepare("UPDATE intents SET payload_hash = ? WHERE id = ?")
      .run("e".repeat(64), id)
    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(intentStatus(w.db, id)?.state).toBe("rejected")
    expect(actions(w.db, id)).toContain("alert.approval_mismatch")
  })

  it("is rejected when the device signed a different payload hash", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    const request = signed(w.auth, { ...prepared, payloadHash: "f".repeat(64) })
    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(intentStatus(w.db, id)?.state).toBe("rejected")
    expect(actions(w.db, id)).toContain("alert.approval_mismatch")
  })
})

describe("ceremony and signature checks", () => {
  it.each<[string, CeremonyOptions, string]>([
    [
      "a wrong origin",
      { origin: "https://evil.example.invalid" },
      "wrong_origin",
    ],
    ["a cross-origin call", { crossOrigin: true }, "wrong_origin"],
    ["a wrong RP id hash", { rpId: "evil.example.invalid" }, "wrong_rp_id"],
    ["a missing user-verified flag", { flags: 0x01 }, "user_not_verified"],
    ["a missing user-present flag", { flags: 0x04 }, "user_not_present"],
    [
      "a registration-type client data",
      { type: "webauthn.create" },
      "wrong_type",
    ],
  ])(
    "invariant: wrong origin or RP id is refused (%s)",
    (_name, options, reason) => {
      const w = world()
      const id = pendingSend(w)
      const request = signed(w.auth, prepare(w.db, id), options)
      expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
      expect(intentStatus(w.db, id)?.state).toBe("pending")
      expect(actions(w.db, id)).toEqual(
        expect.arrayContaining([`approval.refused.${reason}`])
      )
      expect(approvalRows(w.db)).toEqual([])
      chainHolds(w.db)
    }
  )

  it("refuses a signature from another key", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    const impostor = {
      ...testAuthenticator(),
      credentialId: w.auth.credentialId,
    }
    expect(verifyApproval(w.db, WEBAUTHN, signed(impostor, prepared))).toEqual(
      REFUSED
    )
    expect(actions(w.db, id)).toContain("approval.refused.bad_signature")
    expect(intentStatus(w.db, id)?.state).toBe("pending")
  })

  it("refuses a signature made over another assertion", () => {
    const w = world()
    const id = pendingSend(w)
    const earlier = signed(w.auth, prepare(w.db, id), { signCount: 1 })
    const current = signed(w.auth, prepare(w.db, id), { signCount: 9 })
    const forged = {
      ...current,
      assertion: {
        ...current.assertion,
        signature: earlier.assertion.signature,
      },
    }
    expect(verifyApproval(w.db, WEBAUTHN, forged)).toEqual(REFUSED)
    expect(actions(w.db, id)).toContain("approval.refused.bad_signature")
  })

  it.each([
    ["equal", 5],
    ["lower", 3],
    ["reset to zero", 0],
  ])("refuses a sign count %s to the stored one", (_name, next) => {
    const w = world()
    const first = signed(w.auth, prepare(w.db, pendingSend(w, "One")), {
      signCount: 5,
    })
    expect(verifyApproval(w.db, WEBAUTHN, first).ok).toBe(true)
    const id = pendingSend(w, "Two")
    const request = signed(w.auth, prepare(w.db, id), { signCount: next })
    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(actions(w.db, id)).toContain("approval.refused.sign_count")
    expect(intentStatus(w.db, id)?.state).toBe("pending")
    expect(storedSignCount(w.db, w.auth.credentialId)).toBe(5)
  })

  it("refuses an assertion from a credential that was never enrolled", () => {
    const w = world()
    const id = pendingSend(w)
    const request = signed(testAuthenticator(), prepare(w.db, id))
    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(actions(w.db, id)).toContain("approval.refused.unknown_credential")
  })

  it("refuses an assertion whose fields are not base64url or not parseable", () => {
    const w = world()
    const id = pendingSend(w)
    const request = signed(w.auth, prepare(w.db, id))
    const broken = [
      { ...request.assertion, signature: "not base64url!" },
      {
        ...request.assertion,
        clientDataJSON: Buffer.from("{").toString("base64url"),
      },
      { ...request.assertion, authenticatorData: "AAAA" },
    ]
    for (const assertionFields of broken) {
      expect(
        verifyApproval(w.db, WEBAUTHN, {
          ...request,
          assertion: assertionFields,
        })
      ).toEqual(REFUSED)
    }
    expect(
      actions(w.db, id).filter((a) => a === "approval.refused.malformed")
    ).toHaveLength(3)
    expect(intentStatus(w.db, id)?.state).toBe("pending")
  })

  it("refuses an unknown intent", () => {
    const w = world()
    const prepared = prepare(w.db, pendingSend(w))
    const request = signed(w.auth, { ...prepared, intentId: "no-such-intent" })
    expect(verifyApproval(w.db, WEBAUTHN, request)).toEqual(REFUSED)
    expect(actions(w.db, "no-such-intent")).toEqual([
      "approval.refused.unknown_intent",
    ])
  })

  it("refuses an intent that is no longer pending", () => {
    const w = world()
    const id = pendingSend(w)
    const prepared = prepare(w.db, id)
    expect(reject(w.db, id).ok).toBe(true)
    expect(verifyApproval(w.db, WEBAUTHN, signed(w.auth, prepared))).toEqual(
      REFUSED
    )
    expect(actions(w.db, id)).toContain("approval.refused.not_pending")
  })
})

describe("signCountAccepted", () => {
  it.each([
    [0, 0, true],
    [0, 1, true],
    [4, 5, true],
    [5, 5, false],
    [5, 0, false],
    [5, 4, false],
  ])("stored %i, received %i: %s", (stored, received, accepted) => {
    expect(signCountAccepted(stored, received)).toBe(accepted)
  })
})

describe("revoked credentials", () => {
  it("refuses an assertion from a revoked credential", () => {
    const w = world()
    const id = pendingSend(w)
    expect(revokeCredential(w.db, "admin", w.auth.credentialId)).toEqual({
      ok: true,
    })
    expect(
      verifyApproval(w.db, WEBAUTHN, signed(w.auth, prepare(w.db, id)))
    ).toEqual(REFUSED)
    expect(actions(w.db, id)).toContain("approval.refused.revoked_credential")
    expect(intentStatus(w.db, id)?.state).toBe("pending")
    chainHolds(w.db)
  })

  it("keeps a credential working when revocation is attempted from the phone-facing API", () => {
    const w = world()
    expect(revokeCredential(w.db, "phone", w.auth.credentialId)).toEqual({
      ok: false,
      code: "admin_only",
    })
    const id = pendingSend(w)
    expect(
      verifyApproval(w.db, WEBAUTHN, signed(w.auth, prepare(w.db, id))).ok
    ).toBe(true)
  })
})

describe("concurrent verification", () => {
  function sharedFile(): { a: DatabaseSync; b: DatabaseSync; policy: Policy } {
    const dir = mkdtempSync(join(tmpdir(), "eido-approvals-"))
    const path = join(dir, "eido-control.db")
    const a = openControlDb(path)
    const b = openControlDb(path)
    cleanups.push(() => {
      a.close()
      b.close()
      rmSync(dir, { recursive: true, force: true })
    })
    signedPin(a, manifest("mail", MAIL_OPS), "owner")
    const policy = loadPolicy(a, {
      dataDir: dir,
      ownerAddresses: [OWNER],
      allowedRoots: [],
    }).policy
    return { a, b, policy }
  }

  function passing(
    db: DatabaseSync,
    request: ApprovalRequest
  ): VerifiedApproval {
    const checked = checkApproval(db, WEBAUTHN, request)
    if (!checked.ok) throw new Error(`check refused: ${checked.reason}`)
    return checked.approval
  }

  it("lets exactly one of two verifications of one intent approve it", () => {
    const { a, b, policy } = sharedFile()
    const auth = enrol(a)
    const id = pendingSend({ db: a, policy })
    const prepared = prepare(a, id)
    // Both verifiers pass every check before either commits, as two racing requests would.
    const first = passing(a, signed(auth, prepared, { signCount: 1 }))
    const second = passing(b, signed(auth, prepared, { signCount: 2 }))

    expect([commitApproval(a, first), commitApproval(b, second)]).toEqual([
      true,
      false,
    ])
    expect(intentStatus(b, id)?.state).toBe("approved")
    expect(approvalRows(b)).toEqual([
      expect.objectContaining({ sign_count: 1 }),
    ])
    expect(
      intentHistory(b, id).filter((entry) => entry.to === "approved")
    ).toHaveLength(1)
    chainHolds(b)
  })

  it("lets only one of two assertions carrying the same counter advance the credential", () => {
    const { a, b, policy } = sharedFile()
    const auth = enrol(a)
    const one = prepare(a, pendingSend({ db: a, policy }, "One"))
    const two = prepare(a, pendingSend({ db: a, policy }, "Two"))
    const first = passing(a, signed(auth, one, { signCount: 3 }))
    const second = passing(b, signed(auth, two, { signCount: 3 }))

    expect([commitApproval(a, first), commitApproval(b, second)]).toEqual([
      true,
      false,
    ])
    expect(intentStatus(b, two.intentId)?.state).toBe("pending")
    expect(approvalRows(b)).toHaveLength(1)
  })

  it("audits the losing verification", () => {
    const { a, b, policy } = sharedFile()
    const auth = enrol(a)
    const id = pendingSend({ db: a, policy })
    const prepared = prepare(a, id)
    const loser = signed(auth, prepared, { signCount: 2 })
    const early = passing(a, signed(auth, prepared, { signCount: 1 }))
    // b checks and commits through verifyApproval after a's commit lands between them.
    expect(checkApproval(b, WEBAUTHN, loser).ok).toBe(true)
    expect(commitApproval(a, early)).toBe(true)
    expect(verifyApproval(b, WEBAUTHN, loser)).toEqual(REFUSED)
    expect(intentStatus(b, id)?.state).toBe("approved")
  })
})

describe("reject", () => {
  it.each([
    ["with a reason code", "wrong_recipient" as const],
    ["without a reason code", undefined],
  ])(
    "moves pending to rejected %s, stores the code and audits it",
    (_name, code) => {
      const w = world()
      const id = pendingSend(w)
      expect(reject(w.db, id, code)).toEqual({
        ok: true,
        intentId: id,
        state: "rejected",
      })
      expect(intentStatus(w.db, id)?.state).toBe("rejected")
      expect(approvalRows(w.db)).toEqual([
        expect.objectContaining({
          intent_id: id,
          decision: "rejected",
          signature: null,
          nonce: null,
          reason_code: code ?? null,
        }),
      ])
      const last = intentHistory(w.db, id).at(-1)
      expect(last).toMatchObject({
        from: "pending",
        to: "rejected",
        actor: "approver",
      })
      expect(last?.reason).toBe(code)
      chainHolds(w.db)
    }
  )

  it("refuses a non-pending or unknown intent and audits the refusal", () => {
    const w = world()
    const id = pendingSend(w)
    expect(reject(w.db, id).ok).toBe(true)
    expect(reject(w.db, id)).toEqual({ ok: false, code: "not_pending" })
    expect(reject(w.db, "no-such-intent")).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(actions(w.db, id)).toContain("approval.reject_refused.not_pending")
    expect(actions(w.db, "no-such-intent")).toEqual([
      "approval.reject_refused.not_found",
    ])
    expect(approvalRows(w.db)).toHaveLength(1)
  })
})

describe("the audit log", () => {
  it("records every outcome with hashes only, and the chain verifies", () => {
    const w = world()
    const approvedId = pendingSend(w, "Approved")
    const approved = prepare(w.db, approvedId)
    const approvedRequest = signed(w.auth, approved, { signCount: 1 })
    verifyApproval(w.db, WEBAUTHN, approvedRequest)
    verifyApproval(w.db, WEBAUTHN, approvedRequest) // replay

    const staleId = pendingSend(w, "Stale")
    const stale = prepare(w.db, staleId)
    prepare(w.db, staleId)
    verifyApproval(w.db, WEBAUTHN, signed(w.auth, stale, { signCount: 2 }))
    verifyApproval(
      w.db,
      WEBAUTHN,
      signed(w.auth, prepare(w.db, staleId), {
        signCount: 2,
        origin: "https://evil.example.invalid",
      })
    )

    const mismatchId = pendingSend(w, "Mismatch")
    verifyApproval(
      w.db,
      WEBAUTHN,
      signed(
        w.auth,
        { ...prepare(w.db, mismatchId), payloadHash: "0".repeat(64) },
        {
          signCount: 3,
        }
      )
    )

    const rejectedId = pendingSend(w, "Rejected")
    reject(w.db, rejectedId, "wrong_time")

    revokeCredential(w.db, "admin", w.auth.credentialId)
    verifyApproval(
      w.db,
      WEBAUTHN,
      signed(w.auth, prepare(w.db, staleId), { signCount: 4 })
    )

    const all = auditRows(w.db).map((row) => row.action)
    expect(all).toEqual(
      expect.arrayContaining([
        "approval.refused.nonce_used",
        "approval.refused.stale_nonce",
        "approval.refused.wrong_origin",
        "alert.approval_mismatch",
        "approval.refused.revoked_credential",
        "credential.revoked",
      ])
    )
    expect(intentStatus(w.db, approvedId)?.state).toBe("approved")
    expect(intentStatus(w.db, mismatchId)?.state).toBe("rejected")
    expect(intentStatus(w.db, rejectedId)?.state).toBe("rejected")
    chainHolds(w.db)

    const logged = loggedText(w.db)
    expect(logged).not.toContain(BODY_MARKER)
    expect(logged).not.toContain(approved.nonce)
    expect(logged).not.toContain(stale.nonce)
    expect(logged).not.toContain(approvedRequest.assertion.signature)
    expect(logged).not.toContain(w.auth.credentialId)
  })
})
