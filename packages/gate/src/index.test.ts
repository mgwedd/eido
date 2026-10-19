import { afterEach, describe, expect, it, vi } from "vitest"
import * as gate from "./index"
import {
  approveIntent,
  getIntentHistory,
  getIntentStatus,
  listPendingIntents,
  prepareApproval,
  proposeIntent,
  proposeIntentFromModel,
  rejectIntent,
} from "./index"
import { payloadHash } from "./internal/canonical"
import { beginRegistration, registerCredential } from "./internal/credentials"
import { intentHistory, intentStatus, pendingIntents } from "./internal/intents"
import { kindTier } from "./internal/policy"
import {
  reloadPolicy,
  runningGate,
  startGate,
  stopGate,
} from "./internal/runtime"
import {
  BODY_MARKER,
  WEBAUTHN,
  assertion,
  auditRows,
  deviceChallenge,
  loggedText,
  registration,
  sample,
  setup,
  testAuthenticator,
} from "./internal/test-fixtures"
import type { Setup } from "./internal/test-fixtures"

// Asymmetric matchers are typed any; holding one as unknown keeps the literals typed.
const anyString: unknown = expect.any(String)

let current: Setup | undefined

function started(): Setup {
  current = setup()
  expect(startGate(current.db, current.options, WEBAUTHN)).toEqual([])
  return current
}

afterEach(() => {
  stopGate()
  current?.cleanup()
  current = undefined
  vi.restoreAllMocks()
})

describe("the public surface", () => {
  it("exports only the intent and approval API", () => {
    expect(Object.keys(gate).sort()).toEqual([
      "approveIntent",
      "getIntentHistory",
      "getIntentStatus",
      "listPendingIntents",
      "prepareApproval",
      "proposeIntent",
      "proposeIntentFromModel",
      "rejectIntent",
    ])
  })

  it("refuses calls before the gate starts", async () => {
    expect(() => listPendingIntents()).toThrow("the gate is not started")
    await expect(
      proposeIntent({ kind: "email.send", payload: {}, origin: "reactive" })
    ).rejects.toThrow("the gate is not started")
  })

  it("refuses to start with an origin that is not https://<rpId>", () => {
    const s = setup()
    current = s
    expect(() =>
      startGate(s.db, s.options, {
        rpId: WEBAUTHN.rpId,
        origin: "http://eido.example.invalid",
      })
    ).toThrow("the WebAuthn origin must be https://<rpId>")
    expect(() => listPendingIntents()).toThrow("the gate is not started")
  })

  it("starts once", () => {
    const s = started()
    expect(() => startGate(s.db, s.options, WEBAUTHN)).toThrow(
      "the gate is already started"
    )
  })
})

describe("proposeIntent", () => {
  it("computes the hash itself and ignores one the caller supplies", async () => {
    started()
    const intent = sample("email.send")
    const result = await proposeIntent({
      kind: "email.send",
      payload: { ...intent.args },
      origin: "reactive",
      ...{ payloadHash: "0".repeat(64) },
    })
    expect(result).toMatchObject({
      ok: true,
      tier: "approval",
      state: "pending",
      payloadHash: payloadHash(intent),
    })
  })

  it("passes task and context pack ids through", async () => {
    const s = started()
    const result = await proposeIntent({
      kind: "email.archive",
      payload: sample("email.archive").args,
      origin: "task",
      taskId: "task-1",
      contextPackId: "pack-1",
    })
    const id = result.ok ? result.intentId : ""
    expect(
      s.db
        .prepare("SELECT task_id, context_pack_id FROM intents WHERE id = ?")
        .get(id)
    ).toEqual({ task_id: "task-1", context_pack_id: "pack-1" })
  })
})

describe("the intent proposal port", () => {
  it("accepts a valid intent and returns its id and status, recording origin and sources", async () => {
    const s = started()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const intent = sample("email.send")
    const sources = { contextPackId: "pack-1", documentIds: ["doc-1", "doc-2"] }
    const result = await proposeIntentFromModel({
      intent,
      origin: "proactive",
      sources,
    })
    expect(result).toEqual({
      ok: true,
      intentId: anyString,
      status: "pending",
    })
    const id = result.ok ? result.intentId : ""
    expect(getIntentStatus(id)).toEqual({ state: "pending", tier: "approval" })
    const proposed = auditRows(s.db).find(
      (r) => r.action === "intent.proposed" && r.target === id
    )
    expect(proposed?.detail_hash).toBe(
      payloadHash({
        from: null,
        to: "proposed",
        reason: null,
        payload_hash: payloadHash(intent),
        origin: "proactive",
        context_pack_id: "pack-1",
        document_ids: ["doc-1", "doc-2"],
      })
    )
    expect(loggedText(s.db)).not.toContain(BODY_MARKER)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns a code and field path for a schema-invalid intent", async () => {
    started()
    const result = await proposeIntentFromModel({
      intent: {
        kind: "email.send",
        args: { to: ["someone@example.com"], subject: "Hello" },
      },
      origin: "reactive",
      sources: { contextPackId: "pack-1", documentIds: [] },
    })
    expect(result).toEqual({
      ok: false,
      code: "invalid_payload",
      path: "$.args.body",
      reason: "required",
    })
  })

  it("returns the reason alone when there is no field path", async () => {
    started()
    const result = await proposeIntentFromModel({
      intent: sample("file.delete", { root: "secrets" }),
      origin: "reactive",
      sources: { contextPackId: "pack-1", documentIds: [] },
    })
    expect(result).toEqual({
      ok: false,
      code: "forbidden",
      reason: "root_not_allowed",
    })
  })
})

describe("the read endpoints", () => {
  it("return the same data as the gate's own tables", async () => {
    const s = started()
    const pending = await proposeIntent({
      kind: "email.send",
      payload: sample("email.send").args,
      origin: "reactive",
    })
    await proposeIntent({
      kind: "email.archive",
      payload: sample("email.archive").args,
      origin: "reactive",
    })
    const id = pending.ok ? pending.intentId : ""
    expect(listPendingIntents()).toEqual(pendingIntents(s.db))
    expect(listPendingIntents().map((p) => p.id)).toEqual([id])
    expect(getIntentStatus(id)).toEqual(intentStatus(s.db, id))
    expect(getIntentHistory(id)).toEqual(intentHistory(s.db, id))
    expect(getIntentHistory(id).map((e) => e.to)).toEqual([
      "proposed",
      "pending",
    ])
    expect(getIntentStatus("nope")).toBeUndefined()
  })
})

describe("reloading the policy", () => {
  it("applies a changed overlay and keeps the current policy when the overlay is rejected", () => {
    const s = started()
    s.writeOverlay({ version: 1, tiers: { "email.archive": "approval" } })
    expect(reloadPolicy()).toEqual([])
    expect(kindTier(s.db, runningGate().policy, "email.archive")).toEqual({
      tier: "approval",
    })
    s.writeOverlay({ version: 1, tiers: { "email.archive": "forbidden" } })
    expect(reloadPolicy()).toHaveLength(1)
    expect(kindTier(s.db, runningGate().policy, "email.archive")).toEqual({
      tier: "approval",
    })
  })
})

describe("the approval API", () => {
  async function pendingSend(): Promise<string> {
    const result = await proposeIntent({
      kind: "email.send",
      payload: sample("email.send").args,
      origin: "reactive",
    })
    if (!result.ok) throw new Error("fixture send refused")
    return result.intentId
  }

  it("prepares, approves and refuses a replay through the running gate", async () => {
    const s = started()
    const auth = testAuthenticator()
    const begun = beginRegistration(s.db, "admin")
    if (!begun.ok) throw new Error("enrolment challenge refused")
    expect(
      registerCredential(
        s.db,
        WEBAUTHN,
        "admin",
        registration(auth, begun.challenge)
      )
    ).toEqual({ ok: true, credentialId: auth.credentialId })

    const id = await pendingSend()
    const prepared = prepareApproval(id)
    if (!prepared.ok) throw new Error("prepare refused")
    const request = {
      intentId: id,
      nonce: prepared.nonce,
      assertion: assertion(
        auth,
        deviceChallenge(prepared.payloadHash, id, prepared.nonce)
      ),
    }
    expect(approveIntent(request)).toEqual({
      ok: true,
      intentId: id,
      state: "approved",
    })
    expect(getIntentStatus(id)?.state).toBe("approved")
    expect(approveIntent(request)).toEqual({
      ok: false,
      error: "approval_refused",
    })
  })

  it("rejects a pending intent with a reason code", async () => {
    started()
    const id = await pendingSend()
    expect(rejectIntent(id, "wrong_recipient")).toEqual({
      ok: true,
      intentId: id,
      state: "rejected",
    })
    expect(getIntentHistory(id).at(-1)?.reason).toBe("wrong_recipient")
    expect(prepareApproval(id)).toEqual({ ok: false, code: "not_pending" })
  })
})
