import type { IntentClient, IntentProposal } from "@eido/gate"
import { describe, expect, test, vi } from "vitest"
import { proposeConfirm } from "./propose-confirm"
import type { ConfirmCandidate } from "./types"

describe("proposeConfirm", () => {
  const candidate: ConfirmCandidate = {
    docId: "0f".repeat(32),
    extractionId: 42,
    field: "amount",
    raw: "$4,800.00",
    parsed: { amount_minor: 480000, currency: "USD" },
    reason: "low_confidence",
    confidence: 0.71,
    threshold: 0.85,
    span: { start: 10, end: 19 },
    injectionSuspected: false,
    injectionReasons: [],
  }

  test("proposes a valid confirm.field intent", async () => {
    let captured: IntentProposal | undefined
    const gate: Pick<IntentClient, "propose"> = {
      propose: vi.fn((proposal: IntentProposal) => {
        captured = proposal
        return Promise.resolve({
          id: "intent-123",
          tier: "approval" as const,
          state: "pending" as const,
        })
      }),
    }

    const intentId = await proposeConfirm(gate, candidate, {
      documentTitle: "1099-NEC Form",
      documentSource: "scan",
      offsets: [
        { offset: 0, line: 1, page: 1 },
        { offset: 10, line: 2, page: 1, messageId: "msg-1" },
      ],
    })

    expect(intentId).toBe("intent-123")
    expect(captured).toBeDefined()
    expect(captured?.origin).toBe("reactive")
    expect(captured?.intent).toEqual({
      kind: "confirm.field",
      args: {
        extractionId: "42",
        field: "amount",
        value: {
          raw: "$4,800.00",
          typed: { amount_minor: 480000, currency: "USD" },
        },
        source: {
          docSha256: "0f".repeat(32),
          messageId: "msg-1",
          page: 1,
          line: 2,
          start: 10,
          end: 19,
        },
        confidence: 0.71,
        threshold: 0.85,
        documentTitle: "1099-NEC Form",
        documentSource: "scan",
      },
    })
  })

  test("attaches injection reasons when injection is suspected", async () => {
    let captured: IntentProposal | undefined
    const gate: Pick<IntentClient, "propose"> = {
      propose: vi.fn((proposal: IntentProposal) => {
        captured = proposal
        return Promise.resolve({
          id: "intent-456",
          tier: "approval" as const,
          state: "pending" as const,
        })
      }),
    }

    const flaggedCandidate: ConfirmCandidate = {
      ...candidate,
      injectionSuspected: true,
      injectionReasons: ["hidden-characters"],
    }

    await proposeConfirm(gate, flaggedCandidate)
    expect(captured?.injection).toEqual({
      reasons: ["hidden-characters"],
    })
  })

  test("throws if gate rejects the proposal", async () => {
    const gate: Pick<IntentClient, "propose"> = {
      propose: vi.fn(() =>
        Promise.resolve({
          id: "intent-789",
          tier: "forbidden" as const,
          state: "rejected" as const,
          reason: "policy_violation",
        })
      ),
    }

    await expect(proposeConfirm(gate, candidate)).rejects.toThrow(
      /policy_violation/
    )
  })
})
