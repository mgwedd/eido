import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentStatus } from "@eido/gate"
import { describe, expect, test } from "vitest"
import { liveDraftStatus } from "./reply-draft-live"

function gate(answer: Partial<IntentStatus> | Error) {
  return {
    status: (id: string): Promise<IntentStatus> =>
      answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({
            id,
            kind: "email.draft",
            tier: "auto",
            state: "executed",
            edited_from: null,
            discarded: false,
            ...answer,
          }),
  }
}

describe("liveDraftStatus", () => {
  test.each(["proposed", "pending", "approved", "executed"] as const)(
    "a %s draft is live and its status is returned",
    async (state) => {
      expect(await liveDraftStatus(gate({ state }), "int_1")).toEqual({
        id: "int_1",
        kind: "email.draft",
        tier: "auto",
        state,
        edited_from: null,
        discarded: false,
      })
    }
  )

  test.each(["rejected", "failed"] as const)(
    "a %s draft is gone",
    async (state) => {
      expect(await liveDraftStatus(gate({ state }), "int_1")).toBeNull()
    }
  )

  test("an executed draft whose discard executed is gone", async () => {
    expect(await liveDraftStatus(gate({ discarded: true }), "int_1")).toBeNull()
  })

  test("a draft the gate no longer knows is gone", async () => {
    expect(
      await liveDraftStatus(
        gate(new GateRequestError(404, "not_found", "gone")),
        "int_1"
      )
    ).toBeNull()
  })

  test("any other gate error is thrown", async () => {
    const refused = new GateRequestError(500, "internal", "boom")
    await expect(liveDraftStatus(gate(refused), "int_1")).rejects.toBe(refused)
    const down = new GateUnavailableError("the gate is not reachable")
    await expect(liveDraftStatus(gate(down), "int_1")).rejects.toBe(down)
  })
})
