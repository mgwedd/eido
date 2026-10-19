import { describe, expect, test } from "vitest"
import {
  validateGateApiError,
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateAuditPageRequest,
  validateGateAuditRecordRequest,
  validateGateAuditRecordResult,
  validateGateConnectorHealth,
  validateGateCredentialStatus,
  validateGateDecisionRequest,
  validateGateDecisionResult,
  validateGateEditRequest,
  validateGateIntentHistory,
  validateGateIntentProposal,
  validateGateIntentStatus,
  validateGateLoginOptions,
  validateGateLoginRequest,
  validateGateMailFolderList,
  validateGateMailFolderState,
  validateGateMailMessagePage,
  validateGatePendingIntentList,
  validateGatePrepareApproval,
  validateGateProposeRefusal,
  validateGateProposeResult,
  validateGateRejectReason,
  validateGateSession,
} from "./index"
import type { ValidationResult } from "./index"

// Synthetic values only: fake ids, zero hashes, example.com.
const HASH = "ab".repeat(32)
const NONCE = "A".repeat(43)
const AT = "2030-01-02T09:00:00.000Z"

function errorsOf(result: ValidationResult<unknown>): string[] {
  if (result.ok) throw new Error("expected the sample to be rejected")
  return result.errors
}

function without(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[key]
  return copy
}

const PENDING_ITEM = {
  id: "i-1",
  kind: "email.send",
  tier: "approval",
  state: "pending",
  origin: "reactive",
  createdAt: AT,
}

describe("pending intent list", () => {
  const list = {
    intents: [PENDING_ITEM, { ...PENDING_ITEM, editedFrom: "i-0" }],
  }

  test("accepts an item with a rationale", () => {
    expect(
      validateGatePendingIntentList({
        intents: [{ ...PENDING_ITEM, rationale: "Lorem ipsum." }],
      }).ok
    ).toBe(true)
  })

  test("accepts a valid list, including an empty one", () => {
    expect(validateGatePendingIntentList(list).ok).toBe(true)
    expect(validateGatePendingIntentList({ intents: [] }).ok).toBe(true)
  })

  test("rejects an intent that is not pending", () => {
    expect(
      errorsOf(
        validateGatePendingIntentList({
          intents: [{ ...PENDING_ITEM, state: "approved" }],
        })
      )
    ).toEqual(['$.intents[0].state: must be "pending"'])
  })

  test("rejects a payload body smuggled into an item", () => {
    expect(
      errorsOf(
        validateGatePendingIntentList({
          intents: [{ ...PENDING_ITEM, payload: "{}" }],
        })
      )
    ).toEqual(["$.intents[0].payload: unknown key"])
  })

  test("rejects an auto-tier intent in the pending list", () => {
    expect(
      errorsOf(
        validateGatePendingIntentList({
          intents: [{ ...PENDING_ITEM, tier: "auto" }],
        })
      )
    ).toEqual(['$.intents[0].tier: must be "approval"'])
  })

  test("rejects a missing origin and a non-ISO createdAt", () => {
    expect(
      errorsOf(
        validateGatePendingIntentList({
          intents: [without(PENDING_ITEM, "origin")],
        })
      )
    ).toEqual(["$.intents[0].origin: required"])
    expect(
      errorsOf(
        validateGatePendingIntentList({
          intents: [{ ...PENDING_ITEM, createdAt: "2030-01-02 09:00:00.000Z" }],
        })
      )
    ).toEqual(["$.intents[0].createdAt: not an RFC 3339 date-time"])
  })
})

describe("intent history", () => {
  const first = { at: AT, from: null, to: "proposed", actor: "data-plane" }
  const second = { at: AT, from: "proposed", to: "pending", actor: "policy" }
  const history = {
    intentId: "i-1",
    entries: [
      first,
      second,
      {
        at: AT,
        from: "pending",
        to: "rejected",
        actor: "approver",
        reason: "edited",
      },
      {
        at: AT,
        from: "executed",
        to: "executed",
        actor: "executor",
        reason: "undone",
      },
    ],
  }

  test("accepts null for the first from, and an undo entry", () => {
    expect(validateGateIntentHistory(history).ok).toBe(true)
  })

  test("rejects a missing from (null must be explicit)", () => {
    expect(
      errorsOf(
        validateGateIntentHistory({
          intentId: "i-1",
          entries: [without(first, "from")],
        })
      )
    ).toEqual(["$.entries[0].from: required"])
  })

  test("rejects an unknown state such as expired", () => {
    expect(
      errorsOf(
        validateGateIntentHistory({
          intentId: "i-1",
          entries: [{ ...second, to: "expired" }],
        })
      )
    ).toEqual([
      '$.entries[0].to: must be one of "proposed", "pending", "approved", "rejected", "executed", "failed"',
    ])
  })

  test("rejects an actor outside the audit actor enum", () => {
    expect(
      errorsOf(
        validateGateIntentHistory({
          intentId: "i-1",
          entries: [{ ...second, actor: "you" }],
        })
      )
    ).toEqual([
      '$.entries[0].actor: must be one of "data-plane", "policy", "approver", "executor", "system"',
    ])
  })
})

describe("prepare approval", () => {
  const prepared = {
    intentId: "i-1",
    kind: "email.send",
    origin: "reactive",
    state: "pending",
    payload: '{"body":"Hi","subject":"Hi","to":["a@example.com"]}',
    payloadHash: HASH,
    nonce: NONCE,
    contextPackId: "cp-1",
    documentIds: ["d-1"],
  }

  test("accepts a valid response", () => {
    expect(validateGatePrepareApproval(prepared).ok).toBe(true)
  })

  test("rejects a nonce that is not 43 characters long", () => {
    expect(
      errorsOf(validateGatePrepareApproval({ ...prepared, nonce: "short" }))
    ).toEqual([
      "$.nonce: needs at least 43 characters",
      "$.nonce: does not match pattern ^[A-Za-z0-9_-]{43}$",
    ])
    expect(
      errorsOf(
        validateGatePrepareApproval({ ...prepared, nonce: "A".repeat(44) })
      )
    ).toEqual([
      "$.nonce: allows at most 43 characters",
      "$.nonce: does not match pattern ^[A-Za-z0-9_-]{43}$",
    ])
  })

  test("rejects a 43-character nonce that is not base64url", () => {
    expect(
      errorsOf(
        validateGatePrepareApproval({
          ...prepared,
          nonce: `${"A".repeat(42)}+`,
        })
      )
    ).toEqual(["$.nonce: does not match pattern ^[A-Za-z0-9_-]{43}$"])
  })

  test("rejects a payload hash that is not 64 characters", () => {
    expect(
      errorsOf(
        validateGatePrepareApproval({ ...prepared, payloadHash: "ab12" })
      )
    ).toEqual([
      "$.payloadHash: needs at least 64 characters",
      "$.payloadHash: does not match pattern ^[0-9a-f]{64}$",
    ])
  })

  test("rejects a 64-character payload hash that is not lowercase hex", () => {
    expect(
      errorsOf(
        validateGatePrepareApproval({
          ...prepared,
          payloadHash: "g".repeat(64),
        })
      )
    ).toEqual(["$.payloadHash: does not match pattern ^[0-9a-f]{64}$"])
    expect(
      errorsOf(
        validateGatePrepareApproval({
          ...prepared,
          payloadHash: "AB".repeat(32),
        })
      )
    ).toEqual(["$.payloadHash: does not match pattern ^[0-9a-f]{64}$"])
  })

  test("rejects a response without the payload or for a non-pending intent", () => {
    expect(
      errorsOf(validateGatePrepareApproval(without(prepared, "payload")))
    ).toEqual(["$.payload: required"])
    expect(
      errorsOf(validateGatePrepareApproval({ ...prepared, state: "approved" }))
    ).toEqual(['$.state: must be "pending"'])
  })

  test("requires the document ids, an empty list included, and holds no names", () => {
    expect(
      validateGatePrepareApproval({ ...prepared, documentIds: [] }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGatePrepareApproval(without(prepared, "documentIds")))
    ).toEqual(["$.documentIds: required"])
    expect(
      errorsOf(
        validateGatePrepareApproval({
          ...prepared,
          documentIds: [{ documentId: "d-1", name: "Quote.pdf" }],
        })
      )
    ).toEqual(["$.documentIds[0]: expected string, got object"])
  })

  test("accepts a rationale and rejects an empty one", () => {
    expect(
      validateGatePrepareApproval({ ...prepared, rationale: "Lorem ipsum." }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGatePrepareApproval({ ...prepared, rationale: "" }))
    ).toEqual(["$.rationale: needs at least 1 characters"])
  })

  test("never carries the challenge", () => {
    expect(
      errorsOf(validateGatePrepareApproval({ ...prepared, challenge: NONCE }))
    ).toEqual(["$.challenge: unknown key"])
  })
})

describe("decision request", () => {
  const approve = {
    intentId: "i-1",
    decision: "approved",
    nonce: NONCE,
    assertion: {
      credentialId: "Y3JlZA",
      authenticatorData: "YXV0aA",
      clientDataJSON: "Y2xpZW50",
      signature: "c2ln",
    },
  }

  test("accepts an approval and a reject, with and without a reason code", () => {
    expect(validateGateDecisionRequest(approve).ok).toBe(true)
    expect(
      validateGateDecisionRequest({ intentId: "i-1", decision: "rejected" }).ok
    ).toBe(true)
    expect(
      validateGateDecisionRequest({
        intentId: "i-1",
        decision: "rejected",
        reasonCode: "wrong_recipient",
      }).ok
    ).toBe(true)
  })

  test("rejects an approval without an assertion", () => {
    expect(
      errorsOf(validateGateDecisionRequest(without(approve, "assertion")))
    ).toEqual(["$.assertion: required"])
  })

  test("rejects an approval missing a signature or nonce", () => {
    expect(
      errorsOf(
        validateGateDecisionRequest({
          ...approve,
          assertion: without(approve.assertion, "signature"),
        })
      )
    ).toEqual(["$.assertion.signature: required"])
    expect(
      errorsOf(validateGateDecisionRequest(without(approve, "nonce")))
    ).toEqual(["$.nonce: required"])
  })

  test("rejects a reject that carries an assertion", () => {
    expect(
      errorsOf(
        validateGateDecisionRequest({
          intentId: "i-1",
          decision: "rejected",
          assertion: approve.assertion,
        })
      )
    ).toEqual(["$.assertion: unknown key"])
  })

  test("rejects a reason code outside the decided list", () => {
    expect(
      errorsOf(
        validateGateDecisionRequest({
          intentId: "i-1",
          decision: "rejected",
          reasonCode: "not_now",
        })
      )
    ).toEqual([
      '$.reasonCode: must be one of "wrong_recipient", "wrong_content", "wrong_tone", "wrong_time", "not_needed", "other"',
    ])
  })

  test("rejects an unknown decision and an oversized clientDataJSON", () => {
    expect(
      errorsOf(
        validateGateDecisionRequest({ intentId: "i-1", decision: "edited" })
      )
    ).toEqual(['$.decision: must be "rejected"'])
    expect(
      errorsOf(
        validateGateDecisionRequest({
          ...approve,
          assertion: { ...approve.assertion, clientDataJSON: "A".repeat(4097) },
        })
      )
    ).toEqual(["$.assertion.clientDataJSON: allows at most 4096 characters"])
  })
})

describe("decision result and error", () => {
  test("accepts approved and rejected results", () => {
    expect(
      validateGateDecisionResult({ intentId: "i-1", state: "approved" }).ok
    ).toBe(true)
    expect(
      validateGateDecisionResult({ intentId: "i-1", state: "rejected" }).ok
    ).toBe(true)
  })

  test("a decision result cannot claim executed (approval is not execution)", () => {
    expect(
      errorsOf(
        validateGateDecisionResult({ intentId: "i-1", state: "executed" })
      )
    ).toEqual(['$.state: must be one of "approved", "rejected"'])
  })

  test("accepts an error with a known code and rejects an unknown code", () => {
    expect(
      validateGateApiError({
        code: "already_decided",
        message: "Already decided",
      }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGateApiError({ code: "teapot", message: "x" }))
    ).toEqual([
      '$.code: must be one of "not_found", "already_decided", "verification_failed", "invalid_request", "unauthenticated", "misdirected_request", "unsupported_media_type", "tier_changed", "forbidden", "unavailable", "handshake_failed", "auth_failed"',
    ])
    expect(
      errorsOf(validateGateApiError({ code: "not_found", message: "" }))
    ).toEqual(["$.message: needs at least 1 characters"])
  })
})

describe("audit page", () => {
  const entry = {
    seq: 7,
    ts: AT,
    actor: "executor",
    action: "intent.transition",
    target: "i-1",
    detailHash: HASH,
  }

  test("accepts a page with a cursor, and a last page without one", () => {
    expect(validateGateAuditPage({ entries: [entry], nextBefore: 7 }).ok).toBe(
      true
    )
    expect(validateGateAuditPage({ entries: [] }).ok).toBe(true)
  })

  test("rejects a row carrying a body field or prev_hash", () => {
    expect(
      errorsOf(validateGateAuditPage({ entries: [{ ...entry, detail: "x" }] }))
    ).toEqual(["$.entries[0].detail: unknown key"])
    expect(
      errorsOf(
        validateGateAuditPage({ entries: [{ ...entry, prev_hash: HASH }] })
      )
    ).toEqual(["$.entries[0].prev_hash: unknown key"])
  })

  test("rejects seq 0 and a short detail hash", () => {
    expect(
      errorsOf(validateGateAuditPage({ entries: [{ ...entry, seq: 0 }] }))
    ).toEqual(["$.entries[0].seq: must be at least 1"])
    expect(
      errorsOf(
        validateGateAuditPage({ entries: [{ ...entry, detailHash: "ab" }] })
      )
    ).toEqual([
      "$.entries[0].detailHash: needs at least 64 characters",
      "$.entries[0].detailHash: does not match pattern ^[0-9a-f]{64}$",
    ])
  })

  test("rejects a 64-character detail hash that is not lowercase hex", () => {
    expect(
      errorsOf(
        validateGateAuditPage({
          entries: [{ ...entry, detailHash: "z".repeat(64) }],
        })
      )
    ).toEqual([
      "$.entries[0].detailHash: does not match pattern ^[0-9a-f]{64}$",
    ])
  })

  test("rejects more than 50 rows in a page", () => {
    expect(
      errorsOf(validateGateAuditPage({ entries: Array(51).fill(entry) }))
    ).toEqual(["$.entries: allows at most 50 items"])
  })

  test("request accepts no cursor and a bounded limit; rejects limit 51", () => {
    expect(validateGateAuditPageRequest({}).ok).toBe(true)
    expect(validateGateAuditPageRequest({ before: 50, limit: 50 }).ok).toBe(
      true
    )
    expect(errorsOf(validateGateAuditPageRequest({ limit: 51 }))).toEqual([
      "$.limit: must be at most 50",
    ])
  })
})

describe("audit chain status", () => {
  test("accepts ok with a row count, including an empty log", () => {
    expect(validateGateAuditChainStatus({ ok: true, rows: 0 }).ok).toBe(true)
  })

  test("accepts a break with seq and each reason from verifyChain", () => {
    for (const reason of [
      "prev_hash_mismatch",
      "seq_gap",
      "bad_genesis",
      "head_mismatch",
    ]) {
      expect(
        validateGateAuditChainStatus({ ok: false, brokenAtSeq: 3, reason }).ok
      ).toBe(true)
    }
  })

  test("accepts seq 0, which verifyChain reports for head_mismatch on an empty log", () => {
    expect(
      validateGateAuditChainStatus({
        ok: false,
        brokenAtSeq: 0,
        reason: "head_mismatch",
      }).ok
    ).toBe(true)
  })

  test("rejects a break that omits the seq, so the page cannot lose it", () => {
    expect(
      errorsOf(validateGateAuditChainStatus({ ok: false, reason: "seq_gap" }))
    ).toEqual(["$.brokenAtSeq: required"])
  })

  test("rejects ok true without a row count", () => {
    expect(errorsOf(validateGateAuditChainStatus({ ok: true }))).toEqual([
      "$.rows: required",
    ])
  })
})

describe("connector health", () => {
  const item = { name: "gmail", health: "open", consecutiveFailures: 3 }

  test("accepts items with and without the optional fields", () => {
    expect(
      validateGateConnectorHealth({
        connectors: [
          item,
          { ...item, lastError: "handshake failed", nextAttemptAt: AT },
        ],
      }).ok
    ).toBe(true)
  })

  test("rejects an unknown health state and a negative failure count", () => {
    expect(
      errorsOf(
        validateGateConnectorHealth({
          connectors: [{ ...item, health: "down" }],
        })
      )
    ).toEqual([
      '$.connectors[0].health: must be one of "healthy", "degraded", "open"',
    ])
    expect(
      errorsOf(
        validateGateConnectorHealth({
          connectors: [{ ...item, consecutiveFailures: -1 }],
        })
      )
    ).toEqual(["$.connectors[0].consecutiveFailures: must be at least 0"])
  })

  test("rejects a field outside the contract such as a token", () => {
    expect(
      errorsOf(
        validateGateConnectorHealth({ connectors: [{ ...item, token: "x" }] })
      )
    ).toEqual(["$.connectors[0].token: unknown key"])
  })
})

describe("intent proposal", () => {
  const proposal = {
    intent: { kind: "email.send", args: { anything: "the gate checks it" } },
    origin: "reactive",
  }

  test("accepts a rationale and rejects one over 2000 characters", () => {
    expect(
      validateGateIntentProposal({ ...proposal, rationale: "Lorem ipsum." }).ok
    ).toBe(true)
    expect(
      errorsOf(
        validateGateIntentProposal({ ...proposal, rationale: "a".repeat(2001) })
      )
    ).toEqual(["$.rationale: allows at most 2000 characters"])
  })

  test("accepts a bare proposal and one with a task and sources", () => {
    expect(validateGateIntentProposal(proposal).ok).toBe(true)
    expect(
      validateGateIntentProposal({
        ...proposal,
        taskId: "t-1",
        sources: { contextPackId: "p-1", documentIds: ["d-1"] },
      }).ok
    ).toBe(true)
  })

  test("rejects a missing origin, an intent that is not an object and a caller hash", () => {
    expect(
      errorsOf(validateGateIntentProposal(without(proposal, "origin")))
    ).toEqual(["$.origin: required"])
    expect(
      errorsOf(validateGateIntentProposal({ ...proposal, intent: "send it" }))
    ).toEqual(["$.intent: expected object, got string"])
    expect(
      errorsOf(validateGateIntentProposal({ ...proposal, payloadHash: HASH }))
    ).toEqual(["$.payloadHash: unknown key"])
  })

  test("rejects sources without document ids", () => {
    expect(
      errorsOf(
        validateGateIntentProposal({
          ...proposal,
          sources: { contextPackId: "p-1" },
        })
      )
    ).toEqual(["$.sources.documentIds: required"])
  })
})

describe("intent status", () => {
  const status = {
    id: "i-1",
    kind: "email.send",
    tier: "approval",
    state: "pending",
    edited_from: null,
  }

  test("accepts edited_from as null or an id", () => {
    expect(validateGateIntentStatus(status).ok).toBe(true)
    expect(validateGateIntentStatus({ ...status, edited_from: "i-0" }).ok).toBe(
      true
    )
  })

  test("requires edited_from and refuses a payload, signature or nonce", () => {
    expect(
      errorsOf(validateGateIntentStatus(without(status, "edited_from")))
    ).toEqual(["$.edited_from: required"])
    expect(
      errorsOf(
        validateGateIntentStatus({
          ...status,
          payload_json: "{}",
          signature: "s",
          nonce: NONCE,
        })
      )
    ).toEqual([
      "$.payload_json: unknown key",
      "$.signature: unknown key",
      "$.nonce: unknown key",
    ])
  })
})

describe("propose result and refusal", () => {
  test("accepts a stored result with or without a reason", () => {
    expect(
      validateGateProposeResult({ id: "i-1", tier: "auto", state: "approved" })
        .ok
    ).toBe(true)
    expect(
      validateGateProposeResult({
        id: "i-1",
        tier: "forbidden",
        state: "rejected",
        reason: "connector_disabled",
      }).ok
    ).toBe(true)
  })

  test("rejects an unknown tier", () => {
    expect(
      errorsOf(
        validateGateProposeResult({
          id: "i-1",
          tier: "manual",
          state: "pending",
        })
      )
    ).toEqual(['$.tier: must be one of "auto", "approval", "forbidden"'])
  })

  test("a refusal needs at least one error and the invalid_payload code", () => {
    expect(
      validateGateProposeRefusal({
        code: "invalid_payload",
        errors: ["$.args.body: required"],
      }).ok
    ).toBe(true)
    expect(
      errorsOf(
        validateGateProposeRefusal({ code: "invalid_payload", errors: [] })
      )
    ).toEqual(["$.errors: needs at least 1 items"])
    expect(
      errorsOf(validateGateProposeRefusal({ code: "forbidden", errors: ["x"] }))
    ).toEqual(['$.code: must be "invalid_payload"'])
  })
})

describe("audit record request and result", () => {
  const entry = {
    action: "entity.update",
    subjectHash: HASH,
    beforeHash: HASH,
    afterHash: "cd".repeat(32),
  }

  test("accepts a hash-only entry, with null for a missing side", () => {
    expect(validateGateAuditRecordRequest(entry).ok).toBe(true)
    expect(
      validateGateAuditRecordRequest({
        ...entry,
        action: "entity.create",
        beforeHash: null,
      }).ok
    ).toBe(true)
  })

  test("rejects a clear-text field next to the hashes", () => {
    expect(
      errorsOf(validateGateAuditRecordRequest({ ...entry, name: "Acme" }))
    ).toEqual(["$.name: unknown key"])
  })

  test("rejects an action outside the profile actions", () => {
    expect(
      errorsOf(
        validateGateAuditRecordRequest({ ...entry, action: "email.send" })
      )
    ).toEqual([
      '$.action: must be one of "entity.create", "entity.update", "entity.delete", "account.assign", "account.unassign"',
    ])
  })

  test("rejects a hash that is not 64 characters and a missing side", () => {
    expect(
      errorsOf(validateGateAuditRecordRequest({ ...entry, subjectHash: "ab" }))
    ).toEqual(["$.subjectHash: needs at least 64 characters"])
    expect(
      errorsOf(
        validateGateAuditRecordRequest({ ...entry, afterHash: `${HASH}0` })
      )
    ).toEqual(["$.afterHash: allows at most 64 characters"])
    expect(
      errorsOf(validateGateAuditRecordRequest(without(entry, "beforeHash")))
    ).toEqual(["$.beforeHash: required"])
  })

  test("a result is a positive seq", () => {
    expect(validateGateAuditRecordResult({ seq: 1 }).ok).toBe(true)
    expect(errorsOf(validateGateAuditRecordResult({ seq: 0 }))).toEqual([
      "$.seq: must be at least 1",
    ])
  })
})

describe("reject reason", () => {
  test("is one of the six decided codes", () => {
    for (const code of [
      "wrong_recipient",
      "wrong_content",
      "wrong_tone",
      "wrong_time",
      "not_needed",
      "other",
    ]) {
      expect(validateGateRejectReason(code).ok).toBe(true)
    }
    expect(errorsOf(validateGateRejectReason("spam"))).toHaveLength(1)
  })
})

describe("phone sign-in", () => {
  const assertion = {
    credentialId: "Y3JlZA",
    authenticatorData: "YXV0aA",
    clientDataJSON: "Y2xpZW50",
    signature: "c2ln",
  }

  test("login options carry a 43-character challenge, the rp id and the expiry", () => {
    const options = {
      challenge: NONCE,
      rpId: "eido.example.invalid",
      expiresAt: AT,
    }
    expect(validateGateLoginOptions(options).ok).toBe(true)
    expect(
      errorsOf(validateGateLoginOptions({ ...options, challenge: "short" }))
    ).toEqual(["$.challenge: needs at least 43 characters"])
    expect(
      errorsOf(
        validateGateLoginOptions({ ...options, allowCredentials: ["Y3JlZA"] })
      )
    ).toEqual(["$.allowCredentials: unknown key"])
  })

  test("a login request is an assertion and nothing else", () => {
    expect(validateGateLoginRequest({ assertion }).ok).toBe(true)
    expect(
      errorsOf(
        validateGateLoginRequest({ assertion: without(assertion, "signature") })
      )
    ).toEqual(["$.assertion.signature: required"])
    expect(
      errorsOf(validateGateLoginRequest({ assertion, intentId: "i-1" }))
    ).toEqual(["$.intentId: unknown key"])
  })

  test("a session says when it ends and carries no token", () => {
    expect(validateGateSession({ expiresAt: AT }).ok).toBe(true)
    expect(
      errorsOf(validateGateSession({ expiresAt: AT, token: NONCE }))
    ).toEqual(["$.token: unknown key"])
  })

  test("credential status needs an explicit null when there is no session", () => {
    expect(
      validateGateCredentialStatus({ enrolled: false, sessionExpiresAt: null })
        .ok
    ).toBe(true)
    expect(
      validateGateCredentialStatus({ enrolled: true, sessionExpiresAt: AT }).ok
    ).toBe(true)
    expect(errorsOf(validateGateCredentialStatus({ enrolled: true }))).toEqual([
      "$.sessionExpiresAt: required",
    ])
  })
})

describe("edit request", () => {
  test("is the whole edited intent as an object", () => {
    expect(
      validateGateEditRequest({ intent: { kind: "email.send", args: {} } }).ok
    ).toBe(true)
    expect(errorsOf(validateGateEditRequest({ intent: "x" }))).toEqual([
      "$.intent: expected object, got string",
    ])
    expect(
      errorsOf(
        validateGateEditRequest({
          intent: { kind: "email.send", args: {} },
          nonce: NONCE,
        })
      )
    ).toEqual(["$.nonce: unknown key"])
  })
})

describe("Proton mail read routes", () => {
  test("a folder list holds non-empty names", () => {
    expect(
      validateGateMailFolderList({ folders: ["INBOX", "Folders/a"] }).ok
    ).toBe(true)
    expect(errorsOf(validateGateMailFolderList({ folders: [""] }))).toEqual([
      "$.folders[0]: needs at least 1 characters",
    ])
  })

  test("a folder state has a string UIDVALIDITY and a positive UIDNEXT", () => {
    expect(
      validateGateMailFolderState({ uidValidity: "1700000000", uidNext: 1 }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGateMailFolderState({ uidValidity: 17, uidNext: 1 }))
    ).toEqual(["$.uidValidity: expected string, got number"])
    expect(
      errorsOf(validateGateMailFolderState({ uidValidity: "1", uidNext: 0 }))
    ).toEqual(["$.uidNext: must be at least 1"])
  })

  test("a message page carries raw base64 and the skipped UIDs", () => {
    expect(
      validateGateMailMessagePage({
        messages: [{ uid: 4, raw: "U3ViamVjdDogeA0KDQo=" }],
        skipped: [5],
      }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGateMailMessagePage({ messages: [{ uid: 0, raw: "" }] }))
    ).toEqual(["$.skipped: required", "$.messages[0].uid: must be at least 1"])
    expect(
      errorsOf(
        validateGateMailMessagePage({
          messages: [{ uid: 1, raw: "", subject: "x" }],
          skipped: [],
        })
      )
    ).toEqual(["$.messages[0].subject: unknown key"])
  })

  test("the error codes include the Bridge failures", () => {
    for (const code of ["handshake_failed", "auth_failed"]) {
      expect(validateGateApiError({ code, message: "Bridge" }).ok).toBe(true)
    }
  })
})
