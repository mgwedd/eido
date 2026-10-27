// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GatePrepareApproval } from "@eido/schemas"
import {
  assertionOptions,
  prepareApproval,
  signApproval,
} from "@/lib/approval/sign"

const prepared: GatePrepareApproval = {
  intentId: "intent-1",
  kind: "email.send",
  origin: "reactive",
  state: "pending",
  payload: "{}",
  payloadHash: "a".repeat(64),
  nonce: "N".repeat(43),
  documentIds: [],
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

class FakeAssertionResponse {
  authenticatorData = new Uint8Array([1, 2]).buffer
  clientDataJSON = new Uint8Array([3]).buffer
  signature = new Uint8Array([4, 5]).buffer
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown = new FakeAssertionResponse()
}

function stubWebAuthn(get: () => Promise<unknown>) {
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
  const spy = vi.fn(get)
  vi.stubGlobal("navigator", { credentials: { get: spy } })
  return spy
}

function failureCode(result: { ok: boolean; error?: { code: string } }) {
  return result.ok ? "ok" : result.error?.code
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("assertionOptions", () => {
  it("requires user verification and uses the given relying-party id", async () => {
    const options = await assertionOptions(prepared, "eido.example.invalid")
    expect(options.publicKey?.userVerification).toBe("required")
    expect(options.publicKey?.rpId).toBe("eido.example.invalid")
    expect(options.publicKey?.allowCredentials).toBeUndefined()
  })
})

describe("prepareApproval", () => {
  it("posts to the nonce route and returns the parsed approval", async () => {
    const fetchMock = vi.fn(async () => json(200, prepared))
    vi.stubGlobal("fetch", fetchMock)
    const result = await prepareApproval("intent/1")
    expect(result).toEqual({ ok: true, value: prepared })
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe("/api/gate/approvals/intent%2F1/nonce")
    expect(call[1].method).toBe("POST")
  })

  it("reports the gate's error code", async () => {
    vi.stubGlobal("fetch", async () =>
      json(409, { code: "already_decided", message: "no longer pending" })
    )
    expect(await prepareApproval("intent-1")).toEqual({
      ok: false,
      error: { code: "already_decided", message: "no longer pending" },
    })
  })

  it("rejects a response that is not an approval", async () => {
    vi.stubGlobal("fetch", async () => json(200, { intentId: "x" }))
    expect(failureCode(await prepareApproval("intent-1"))).toBe(
      "invalid_response"
    )
  })

  it("rejects a success response that is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 200 }))
    expect(failureCode(await prepareApproval("intent-1"))).toBe(
      "invalid_response"
    )
  })

  it("reports an unreachable gate", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline")
    })
    expect(failureCode(await prepareApproval("intent-1"))).toBe("network")
  })

  it("reports a failure that is not a gate error body", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 502 }))
    expect(await prepareApproval("intent-1")).toEqual({
      ok: false,
      error: { code: "invalid_response", message: "The gate answered 502." },
    })
  })
})

describe("signApproval", () => {
  it("signs over the nonce of each prepared call and sends that nonce", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    const fetchMock = vi.fn(async () =>
      json(200, { intentId: "intent-1", state: "approved" })
    )
    vi.stubGlobal("fetch", fetchMock)
    const first = { ...prepared, nonce: "A".repeat(43) }
    const second = { ...prepared, nonce: "B".repeat(43) }

    await signApproval(first)
    await signApproval(second)

    for (const [index, call] of [first, second].entries()) {
      const sent = get.mock.calls[index] as unknown as [CredentialRequestOptions]
      const expected = await assertionOptions(call, window.location.hostname)
      expect(sent[0].publicKey?.challenge).toEqual(expected.publicKey?.challenge)
      expect(sent[0].publicKey?.userVerification).toBe("required")
      expect(sent[0].publicKey?.rpId).toBe(window.location.hostname)
      const init = fetchMock.mock.calls[index] as unknown as [string, RequestInit]
      expect(JSON.parse(String(init[1].body))).toEqual({
        intentId: "intent-1",
        decision: "approved",
        nonce: call.nonce,
        assertion: {
          credentialId: "CQ",
          authenticatorData: "AQI",
          clientDataJSON: "Aw",
          signature: "BAU",
        },
      })
    }
    const challenges = get.mock.calls.map(
      (c) =>
        toHex(
          (c as unknown as [CredentialRequestOptions])[0].publicKey
            ?.challenge as ArrayBuffer
        )
    )
    expect(challenges[0]).not.toBe(challenges[1])
  })

  it("posts to the decision route as JSON", async () => {
    stubWebAuthn(async () => new FakeCredential())
    const fetchMock = vi.fn(async () =>
      json(200, { intentId: "intent-1", state: "approved" })
    )
    vi.stubGlobal("fetch", fetchMock)
    const result = await signApproval(prepared)
    expect(result).toEqual({
      ok: true,
      value: { intentId: "intent-1", state: "approved" },
    })
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe("/api/gate/approvals/intent-1/decision")
    expect(call[1].headers).toEqual({ "content-type": "application/json" })
  })

  it("sends nothing when Face ID is cancelled", async () => {
    stubWebAuthn(async () => {
      throw new DOMException("cancelled", "NotAllowedError")
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(failureCode(await signApproval(prepared))).toBe("cancelled")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends nothing when the device returns no assertion", async () => {
    stubWebAuthn(async () => null)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(failureCode(await signApproval(prepared))).toBe("cancelled")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends nothing when the credential is not an assertion", async () => {
    stubWebAuthn(async () =>
      Object.assign(new FakeCredential(), { response: {} })
    )
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(failureCode(await signApproval(prepared))).toBe("cancelled")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports the gate's refusal", async () => {
    stubWebAuthn(async () => new FakeCredential())
    vi.stubGlobal("fetch", async () =>
      json(403, { code: "verification_failed", message: "refused" })
    )
    expect(failureCode(await signApproval(prepared))).toBe(
      "verification_failed"
    )
  })

  it("reports an unreachable gate", async () => {
    stubWebAuthn(async () => new FakeCredential())
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline")
    })
    expect(failureCode(await signApproval(prepared))).toBe("network")
  })

  it("reports an unreadable result", async () => {
    stubWebAuthn(async () => new FakeCredential())
    vi.stubGlobal("fetch", async () => json(200, { nope: true }))
    expect(failureCode(await signApproval(prepared))).toBe("invalid_response")
  })

  it("reports a result that is not JSON", async () => {
    stubWebAuthn(async () => new FakeCredential())
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 200 }))
    expect(failureCode(await signApproval(prepared))).toBe("invalid_response")
  })

  it("logs and stores nothing", async () => {
    stubWebAuthn(async () => new FakeCredential())
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/nonce")
        ? json(200, prepared)
        : json(200, { intentId: "intent-1", state: "approved" })
    )
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined)
    )
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    await prepareApproval("intent-1")
    await signApproval(prepared)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })
})

function toHex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex")
}
