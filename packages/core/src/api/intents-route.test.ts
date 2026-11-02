import { GateUnavailableError } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import type { GateProposeResult } from "@eido/schemas"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { MockedFunction } from "vitest"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"
import type { GateIntentProposal } from "@eido/schemas"

const PROPOSAL: GateIntentProposal = {
  intent: {
    kind: "email.archive",
    connector: "gmail",
    args: { messageIds: ["message-1"] },
  },
  origin: "reactive",
}
const RESULT: GateProposeResult = {
  id: "intent-1",
  tier: "approval",
  state: "pending",
}

let db: ReturnType<typeof openIndex>
let handle: ApiHandler
let propose: MockedFunction<IntentClient["propose"]>

beforeEach(() => {
  db = openIndex(":memory:")
  propose = vi.fn(() => Promise.resolve(RESULT))
  handle = createApiHandler({
    profile: createProfileStore(db, { audit: () => Promise.resolve() }),
    allowedHosts: ["core.test"],
    propose,
  })
})

afterEach(() => db.close())

function call(
  body: unknown,
  handler: ApiHandler = handle,
  method = "POST"
): Promise<Response> {
  return handler(
    new Request("http://core.test/intents", {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    })
  )
}

describe("POST /intents", () => {
  test("validates the proposal and intent, then forwards it to the gate", async () => {
    const response = await call(PROPOSAL)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(RESULT)
    expect(propose).toHaveBeenCalledWith(PROPOSAL)
  })

  test.each([
    ["an invalid proposal", { intent: {}, origin: "reactive", extra: true }],
    ["an invalid intent", { intent: { kind: "unknown" }, origin: "reactive" }],
    ["a non-reactive origin", { ...PROPOSAL, origin: "task" }],
  ])("rejects %s without calling the gate", async (_label, body) => {
    const response = await call(body)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: "invalid" } })
    expect(propose).not.toHaveBeenCalled()
  })

  test("answers only POST", async () => {
    const response = await call(undefined, handle, "GET")
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect(propose).not.toHaveBeenCalled()
  })

  test("is not served when no gate proposal client is configured", async () => {
    const bare = createApiHandler({
      profile: createProfileStore(db, { audit: () => Promise.resolve() }),
      allowedHosts: ["core.test"],
    })
    const response = await call(PROPOSAL, bare)
    expect(response.status).toBe(404)
  })

  test("sanitizes gate unavailability", async () => {
    propose.mockRejectedValue(new GateUnavailableError("socket /private/gate"))
    const response = await call(PROPOSAL)
    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).toBe(
      JSON.stringify({
        error: { code: "gate_unavailable", message: "gate unavailable" },
      })
    )
    expect(text).not.toContain("/private/gate")
  })
})
