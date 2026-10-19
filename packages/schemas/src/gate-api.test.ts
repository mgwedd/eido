import { describe, expect, test } from "vitest"
import {
  validateGateApiError,
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateAuditPageRequest,
  validateGateConnectorHealth,
  validateGateDecisionRequest,
  validateGateDecisionResult,
  validateGateIntentHistory,
  validateGatePendingIntentList,
  validateGatePrepareApproval,
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
          intents: [{ ...PENDING_ITEM, createdAt: "yesterday" }],
        })
      )
    ).toContain("$.intents[0].createdAt: not an RFC 3339 date-time")
  })
})

describe("intent history", () => {
  const history = {
    intentId: "i-1",
    entries: [
      { at: AT, from: null, to: "proposed", actor: "data-plane" },
      { at: AT, from: "proposed", to: "pending", actor: "policy" },
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
          entries: [without(history.entries[0] as object, "from")],
        })
      )
    ).toEqual(["$.entries[0].from: required"])
  })

  test("rejects an unknown state such as expired", () => {
    const errors = errorsOf(
      validateGateIntentHistory({
        intentId: "i-1",
        entries: [{ ...history.entries[1], to: "expired" }],
      })
    )
    expect(errors.join("\n")).toContain("must be one of")
  })

  test("rejects an actor outside the audit actor enum", () => {
    expect(
      errorsOf(
        validateGateIntentHistory({
          intentId: "i-1",
          entries: [{ ...history.entries[1], actor: "you" }],
        })
      ).join("\n")
    ).toContain("$.entries[0].actor")
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
    sources: [{ documentId: "d-1", name: "Quote.pdf" }],
  }

  test("accepts a valid response", () => {
    expect(validateGatePrepareApproval(prepared).ok).toBe(true)
  })

  test("rejects a nonce that is not 32 bytes of base64url", () => {
    expect(
      errorsOf(validateGatePrepareApproval({ ...prepared, nonce: "short" }))
    ).toEqual(["$.nonce: needs at least 43 characters"])
    expect(
      errorsOf(
        validateGatePrepareApproval({ ...prepared, nonce: "A".repeat(44) })
      )
    ).toEqual(["$.nonce: allows at most 43 characters"])
  })

  test("rejects a payload hash that is not 64 characters", () => {
    expect(
      errorsOf(
        validateGatePrepareApproval({ ...prepared, payloadHash: "ab12" })
      )
    ).toEqual(["$.payloadHash: needs at least 64 characters"])
  })

  test("rejects a response without the payload or for a non-pending intent", () => {
    expect(
      errorsOf(validateGatePrepareApproval(without(prepared, "payload")))
    ).toEqual(["$.payload: required"])
    expect(
      errorsOf(validateGatePrepareApproval({ ...prepared, state: "approved" }))
    ).toEqual(['$.state: must be "pending"'])
  })

  test("rejects a source without a name", () => {
    expect(
      errorsOf(
        validateGatePrepareApproval({
          ...prepared,
          sources: [{ documentId: "d-1" }],
        })
      )
    ).toEqual(["$.sources[0].name: required"])
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

  test("rejects an unknown decision and an oversized clientDataJSON", () => {
    expect(
      validateGateDecisionRequest({ intentId: "i-1", decision: "edited" }).ok
    ).toBe(false)
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
      ).join("\n")
    ).toContain("$.state: must be one of")
  })

  test("accepts an error with a known code and rejects an unknown code", () => {
    expect(
      validateGateApiError({
        code: "already_decided",
        message: "Already decided",
      }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGateApiError({ code: "teapot", message: "x" })).join(
        "\n"
      )
    ).toContain("$.code: must be one of")
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
  })

  test("rejects seq 0 and a short detail hash", () => {
    expect(
      errorsOf(validateGateAuditPage({ entries: [{ ...entry, seq: 0 }] }))
    ).toEqual(["$.entries[0].seq: must be at least 1"])
    expect(
      errorsOf(
        validateGateAuditPage({ entries: [{ ...entry, detailHash: "ab" }] })
      )
    ).toEqual(["$.entries[0].detailHash: needs at least 64 characters"])
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

  test("rejects a break that omits the seq, so the page cannot lose it", () => {
    expect(
      validateGateAuditChainStatus({ ok: false, reason: "seq_gap" }).ok
    ).toBe(false)
  })

  test("rejects ok true without a row count", () => {
    expect(validateGateAuditChainStatus({ ok: true }).ok).toBe(false)
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
      ).join("\n")
    ).toContain("$.connectors[0].health: must be one of")
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
