import { describe, expect, test } from "vitest"
import {
  validateGateApiError,
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateAuditPageRequest,
  validateGateAuditRecordRequest,
  validateGateAuditRecordResult,
  validateGateBackupStatus,
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
  validateGatePermissionList,
  validateGatePrepareApproval,
  validateGateProposeRefusal,
  validateGateProposeResult,
  validateGateRejectReason,
  validateGateRepinPrepared,
  validateGateRepinRequest,
  validateGateRepinResult,
  validateGateFileRootsPrepared,
  validateGateFileRootsCompletion,
  validateGateFileRootsSaved,
  validateGateSession,
  validateGateThingsAreaList,
  validateGateThingsProjectList,
  validateGateThingsTagList,
  validateGateThingsTodoItem,
  validateGateThingsTodoList,
  gateAuditDisplayActor,
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

describe("permission list", () => {
  const row = { kind: "email.archive", tier: "approval", default: "auto" }
  const list = { tiers: [row], forbiddenKinds: [] }

  test("accepts defaults, optional overrides and an explicitly absent shipped default", () => {
    expect(validateGatePermissionList(list).ok).toBe(true)
    expect(
      validateGatePermissionList({
        ...list,
        tiers: [{ ...row, override: "approval" }],
      }).ok
    ).toBe(true)
    expect(
      validateGatePermissionList({
        ...list,
        tiers: [{ ...row, default: null }],
      }).ok
    ).toBe(true)
  })

  test("requires the default and refuses non-configurable tiers in configuration fields", () => {
    expect(
      validateGatePermissionList({ ...list, tiers: [without(row, "default")] })
        .ok
    ).toBe(false)
    expect(
      validateGatePermissionList({
        ...list,
        tiers: [{ ...row, default: "forbidden" }],
      }).ok
    ).toBe(false)
    expect(
      validateGatePermissionList({
        ...list,
        tiers: [{ ...row, override: "forbidden" }],
      }).ok
    ).toBe(false)
  })
})

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
      '$.entries[0].actor: must be one of "data-plane", "policy", "approver", "executor", "system", "owner", "gate"',
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

  test("rejects a 43-character approval nonce that is not base64url", () => {
    expect(
      errorsOf(
        validateGateDecisionRequest({ ...approve, nonce: `${"A".repeat(42)}=` })
      )
    ).toEqual(["$.nonce: does not match pattern ^[A-Za-z0-9_-]{43}$"])
  })

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
      '$.code: must be one of "not_found", "already_decided", "verification_failed", "invalid_request", "unauthenticated", "misdirected_request", "unsupported_media_type", "tier_changed", "forbidden", "unavailable", "busy", "handshake_failed", "auth_failed", "things_unavailable", "automation_denied"',
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
    displayActor: "auto",
    undo: "none",
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

describe("audit display actors", () => {
  test("covers stored actor types and distinguishes signed executor actions", () => {
    expect(gateAuditDisplayActor("approver")).toBe("you")
    expect(gateAuditDisplayActor("policy")).toBe("auto")
    expect(gateAuditDisplayActor("data-plane")).toBe("auto")
    expect(gateAuditDisplayActor("executor")).toBe("auto")
    expect(gateAuditDisplayActor("executor", true)).toBe("you")
    expect(gateAuditDisplayActor("system")).toBe("gate")
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
    expect(
      validateGateIntentProposal({ ...proposal, sensitivity: "sensitive" }).ok
    ).toBe(true)
  })

  test("rejects sensitivity value other than sensitive", () => {
    expect(
      errorsOf(
        validateGateIntentProposal({ ...proposal, sensitivity: "normal" })
      )
    ).toEqual(['$.sensitivity: must be one of "sensitive"'])
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
    discarded: false,
  }

  test("accepts edited_from as null or an id", () => {
    expect(validateGateIntentStatus(status).ok).toBe(true)
    expect(validateGateIntentStatus({ ...status, edited_from: "i-0" }).ok).toBe(
      true
    )
  })

  test("requires edited_from and discarded and refuses a payload, signature or nonce", () => {
    expect(
      errorsOf(validateGateIntentStatus(without(status, "edited_from")))
    ).toEqual(["$.edited_from: required"])
    expect(
      errorsOf(validateGateIntentStatus(without(status, "discarded")))
    ).toEqual(["$.discarded: required"])
    expect(
      errorsOf(validateGateIntentStatus({ ...status, discarded: "yes" }))
    ).toEqual(["$.discarded: expected boolean, got string"])
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
      '$.action: must be one of "entity.create", "entity.update", "entity.delete", "account.assign", "account.unassign", "obligation.done", "obligation.resolve", "obligation.reopen", "defaultEntity", "access.document_open", "access.inference_use", "access.content_copy", "access.instruction_change"',
    ])
  })

  test("accepts sensitive read and local AI use access actions", () => {
    for (const action of [
      "access.document_open",
      "access.inference_use",
      "access.content_copy",
      "access.instruction_change",
    ] as const) {
      expect(
        validateGateAuditRecordRequest({
          action,
          subjectHash: HASH,
          beforeHash: null,
          afterHash: null,
        }).ok
      ).toBe(true)
    }
  })

  test("rejects a hash that is not 64 characters and a missing side", () => {
    expect(
      errorsOf(validateGateAuditRecordRequest({ ...entry, subjectHash: "ab" }))
    ).toEqual([
      "$.subjectHash: needs at least 64 characters",
      "$.subjectHash: does not match pattern ^[0-9a-f]{64}$",
    ])
    expect(
      errorsOf(
        validateGateAuditRecordRequest({ ...entry, afterHash: `${HASH}0` })
      )
    ).toEqual([
      "$.afterHash: allows at most 64 characters",
      "$.afterHash: does not match pattern ^[0-9a-f]{64}$",
    ])
    expect(
      errorsOf(validateGateAuditRecordRequest(without(entry, "beforeHash")))
    ).toEqual(["$.beforeHash: required"])
  })

  test("rejects a 64-character hash that is not lowercase hex, on each of the three", () => {
    const bad = "G".repeat(64)
    expect(
      errorsOf(validateGateAuditRecordRequest({ ...entry, subjectHash: bad }))
    ).toEqual(["$.subjectHash: does not match pattern ^[0-9a-f]{64}$"])
    expect(
      errorsOf(validateGateAuditRecordRequest({ ...entry, beforeHash: bad }))
    ).toEqual(["$.beforeHash: does not match pattern ^[0-9a-f]{64}$"])
    expect(
      errorsOf(validateGateAuditRecordRequest({ ...entry, afterHash: bad }))
    ).toEqual(["$.afterHash: does not match pattern ^[0-9a-f]{64}$"])
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
    ).toEqual([
      "$.challenge: needs at least 43 characters",
      "$.challenge: does not match pattern ^[A-Za-z0-9_-]{43}$",
    ])
    expect(
      errorsOf(
        validateGateLoginOptions({
          ...options,
          challenge: `${"A".repeat(42)}.`,
        })
      )
    ).toEqual(["$.challenge: does not match pattern ^[A-Za-z0-9_-]{43}$"])
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
      validateGateCredentialStatus({
        enrolled: false,
        revoked: false,
        sessionExpiresAt: null,
      }).ok
    ).toBe(true)
    expect(
      validateGateCredentialStatus({
        enrolled: true,
        revoked: false,
        sessionExpiresAt: AT,
      }).ok
    ).toBe(true)
    expect(
      errorsOf(validateGateCredentialStatus({ enrolled: true, revoked: false }))
    ).toEqual(["$.sessionExpiresAt: required"])
    expect(
      errorsOf(
        validateGateCredentialStatus({ enrolled: true, sessionExpiresAt: null })
      )
    ).toEqual(["$.revoked: required"])
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

  test("the error codes include busy, the gate's concurrent-read refusal", () => {
    expect(
      validateGateApiError({ code: "busy", message: "the gate is busy" }).ok
    ).toBe(true)
  })

  test("the file-root errors name the folder by its request id and nothing else", () => {
    const missing = {
      code: "root_missing",
      rootId: "rental",
      message: "the file helper could not identify this folder",
    }
    expect(validateGateApiError(missing).ok).toBe(true)
    // Without the id the web app cannot say which folder; a path is never an id.
    expect(
      validateGateApiError({ code: missing.code, message: missing.message }).ok
    ).toBe(false)
    expect(
      validateGateApiError({ ...missing, rootId: "/Users/x/Rental" }).ok
    ).toBe(false)
    expect(validateGateApiError({ ...missing, code: "root_changed" }).ok).toBe(
      true
    )
    // Only the file-root errors carry a root id.
    expect(
      validateGateApiError({
        code: "invalid_request",
        rootId: "rental",
        message: "x",
      }).ok
    ).toBe(false)
  })

  test("the error codes include the Bridge failures", () => {
    for (const code of ["handshake_failed", "auth_failed"]) {
      expect(validateGateApiError({ code, message: "Bridge" }).ok).toBe(true)
    }
  })

  test("GateBackupStatus validates never_run, fresh, and stale statuses", () => {
    expect(
      validateGateBackupStatus({
        status: "never_run",
        lastSuccess: null,
      }).ok
    ).toBe(true)

    expect(
      validateGateBackupStatus({
        status: "fresh",
        lastSuccess: AT,
      }).ok
    ).toBe(true)

    expect(
      validateGateBackupStatus({
        status: "stale",
        lastSuccess: AT,
      }).ok
    ).toBe(true)

    expect(
      validateGateBackupStatus({
        status: "never_run",
        lastSuccess: AT,
      }).ok
    ).toBe(false)

    expect(
      validateGateBackupStatus({
        status: "fresh",
        lastSuccess: null,
      }).ok
    ).toBe(false)

    expect(
      validateGateBackupStatus({
        status: "unknown",
        lastSuccess: AT,
      }).ok
    ).toBe(false)
  })
})

describe("connector re-pin", () => {
  const prepared = {
    id: "ctl-1",
    purpose: "manifest.pin",
    target: "drive",
    payload: '{"name":"drive"}',
    payloadHash: HASH,
    nonce: NONCE,
    challenge: NONCE,
  }
  const assertion = {
    credentialId: "Y3JlZA",
    authenticatorData: "YXV0aA",
    clientDataJSON: "Y2xpZW50",
    signature: "c2ln",
  }

  test("a prepared card is bound to the manifest.pin purpose", () => {
    expect(validateGateRepinPrepared(prepared).ok).toBe(true)
    expect(
      validateGateRepinPrepared({ ...prepared, purpose: "intent.approve" }).ok
    ).toBe(false)
  })

  test("a prepared card refuses a malformed hash, nonce or challenge", () => {
    expect(
      validateGateRepinPrepared({ ...prepared, payloadHash: "abc" }).ok
    ).toBe(false)
    expect(
      validateGateRepinPrepared({ ...prepared, nonce: `${"A".repeat(42)}=` }).ok
    ).toBe(false)
    expect(
      validateGateRepinPrepared({ ...prepared, challenge: "short" }).ok
    ).toBe(false)
  })

  test("a request needs the id, nonce and assertion and no other key", () => {
    const request = { id: "ctl-1", nonce: NONCE, assertion }
    expect(validateGateRepinRequest(request).ok).toBe(true)
    expect(
      errorsOf(validateGateRepinRequest(without(request, "assertion")))
    ).toEqual(["$.assertion: required"])
    expect(
      errorsOf(validateGateRepinRequest({ ...request, manifest: {} }))
    ).toEqual(["$.manifest: unknown key"])
  })

  test("a result names the connector and the pinned manifest hash", () => {
    expect(
      validateGateRepinResult({ connector: "drive", manifestHash: HASH }).ok
    ).toBe(true)
    expect(validateGateRepinResult({ connector: "drive" }).ok).toBe(false)
  })
})

describe("allowed folders signing", () => {
  const roots = {
    roots: [
      {
        id: "notes",
        root: {
          path: "/Users/owner.example/Notes",
          dev: "1000004",
          ino: "2a",
          trashDir: ".eido-trash",
        },
      },
    ],
  }
  const prepared = {
    id: "ctl-1",
    purpose: "policy.set",
    target: "file-roots",
    payloadHash: HASH,
    nonce: NONCE,
    challenge: NONCE,
    roots,
  }
  const assertion = {
    credentialId: "Y3JlZA",
    authenticatorData: "YXV0aA",
    clientDataJSON: "Y2xpZW50",
    signature: "c2ln",
  }

  test("a prepared list is bound to policy.set on file-roots", () => {
    expect(validateGateFileRootsPrepared(prepared).ok).toBe(true)
    expect(
      errorsOf(
        validateGateFileRootsPrepared({ ...prepared, purpose: "manifest.pin" })
      )
    ).toEqual(['$.purpose: must be "policy.set"'])
    expect(
      validateGateFileRootsPrepared({ ...prepared, target: "drive" }).ok
    ).toBe(false)
  })

  test("a prepared list refuses a malformed hash, nonce, challenge or root", () => {
    expect(
      validateGateFileRootsPrepared({ ...prepared, payloadHash: "abc" }).ok
    ).toBe(false)
    expect(
      validateGateFileRootsPrepared({
        ...prepared,
        nonce: `${"A".repeat(42)}=`,
      }).ok
    ).toBe(false)
    expect(
      validateGateFileRootsPrepared({ ...prepared, challenge: "short" }).ok
    ).toBe(false)
    expect(
      validateGateFileRootsPrepared({
        ...prepared,
        roots: { roots: [{ id: "Notes", root: roots.roots[0]?.root }] },
      }).ok
    ).toBe(false)
    expect(
      errorsOf(validateGateFileRootsPrepared(without(prepared, "roots")))
    ).toEqual(["$.roots: required"])
  })

  test("a completion carries the roots and the signed authorization", () => {
    const completion = {
      roots,
      authorization: { id: "ctl-1", nonce: NONCE, assertion },
    }
    expect(validateGateFileRootsCompletion(completion).ok).toBe(true)
    expect(
      errorsOf(
        validateGateFileRootsCompletion({
          roots,
          authorization: { id: "ctl-1", nonce: NONCE },
        })
      )
    ).toEqual(["$.authorization.assertion: required"])
    expect(
      errorsOf(validateGateFileRootsCompletion({ ...completion, extra: 1 }))
    ).toEqual(["$.extra: unknown key"])
  })

  test("a saved result is only saved: true", () => {
    expect(validateGateFileRootsSaved({ saved: true }).ok).toBe(true)
    expect(validateGateFileRootsSaved({ saved: false }).ok).toBe(false)
  })
})

describe("Things gate schemas", () => {
  const item = {
    id: "item-1",
    name: "Clean desk",
    status: "open",
    notes: "Dust monitor",
    tags: ["Home"],
    area: "Personal",
    project: null,
    dueDate: "2026-11-10",
    activationDate: null,
    modificationDate: "2026-11-03",
    creationDate: "2026-11-01",
  }

  test("validates a to-do item and list", () => {
    expect(validateGateThingsTodoItem(item).ok).toBe(true)
    expect(validateGateThingsTodoList({ items: [item] }).ok).toBe(true)
    expect(validateGateThingsTodoItem({ ...item, status: "unknown" }).ok).toBe(
      false
    )
  })

  test("validates project, area and tag lists", () => {
    const project = {
      id: "proj-1",
      name: "Q4 Goals",
      area: "Work",
      status: "open",
      headings: ["Launch", "Wrap up"],
      todoCount: 5,
    }
    expect(validateGateThingsProjectList({ projects: [project] }).ok).toBe(true)
    expect(
      validateGateThingsAreaList({ areas: [{ id: "area-1", name: "Work" }] }).ok
    ).toBe(true)
    expect(validateGateThingsTagList({ tags: ["Urgent", "Later"] }).ok).toBe(
      true
    )
  })
})
