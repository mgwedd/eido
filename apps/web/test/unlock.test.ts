// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch and navigator.credentials.get return promises, so their stubs are async functions with nothing to await */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  checkEnvironment,
  expiredUnlockUrl,
  loadCredentialStatus,
  safeNext,
  unlock,
} from "@/lib/auth/unlock"

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const options = {
  challenge: "A".repeat(43),
  rpId: "eido.example.invalid",
  expiresAt: "2026-10-27T10:00:00.000Z",
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

function route(handlers: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    const handler = handlers[url]
    if (handler === undefined) throw new Error(`unexpected ${url}`)
    return handler()
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("safeNext", () => {
  it.each([
    [undefined, "/"],
    ["/", "/"],
    ["/queue?filter=email", "/queue?filter=email"],
    ["https://evil.example.invalid/", "/"],
    ["//evil.example.invalid/", "/"],
    ["/\\evil.example.invalid", "/"],
    ["queue", "/"],
    ["/unlock", "/"],
    ["/unlock?next=/queue", "/"],
    ["/unlocked-things", "/unlocked-things"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected)
  })
})

describe("checkEnvironment", () => {
  it("needs WebAuthn before anything else", () => {
    expect(checkEnvironment("eido.tail1234.ts.net", false)).toBe("unsupported")
  })
  it("accepts the tailnet host", () => {
    expect(checkEnvironment("eido.tail1234.ts.net", true)).toBe("ok")
  })
  it("rejects any other host", () => {
    expect(checkEnvironment("192.168.1.5", true)).toBe("wrong-origin")
    expect(checkEnvironment("ts.net.evil.example.invalid", true)).toBe(
      "wrong-origin"
    )
  })
})

describe("loadCredentialStatus", () => {
  it("returns the parsed status", async () => {
    route({
      "/api/gate/passkey/status": () =>
        json(200, { enrolled: true, sessionExpiresAt: null }),
    })
    expect(await loadCredentialStatus()).toEqual({
      ok: true,
      status: { enrolled: true, sessionExpiresAt: null },
    })
  })

  it("reports an unreachable gate", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline")
    })
    expect(await loadCredentialStatus()).toEqual({
      ok: false,
      reason: "offline",
    })
  })

  it("rejects a body that is not a status", async () => {
    route({ "/api/gate/passkey/status": () => json(200, { enrolled: "yes" }) })
    expect(await loadCredentialStatus()).toEqual({
      ok: false,
      reason: "invalid_response",
    })
  })

  it("rejects a failure status and a body that is not JSON", async () => {
    route({ "/api/gate/passkey/status": () => json(500, {}) })
    expect((await loadCredentialStatus()).ok).toBe(false)
    route({
      "/api/gate/passkey/status": () => new Response("<html>", { status: 200 }),
    })
    expect(await loadCredentialStatus()).toEqual({
      ok: false,
      reason: "invalid_response",
    })
  })
})

describe("unlock", () => {
  const session = { expiresAt: "2026-10-27T22:00:00.000Z" }

  it("signs the gate's challenge with user verification and posts the assertion", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    const fetchMock = route({
      "/api/gate/auth/login/options": () => json(200, options),
      "/api/gate/auth/login": () => json(200, session),
    })
    expect(await unlock()).toEqual({ ok: true })

    const sent = get.mock.calls[0] as unknown as [CredentialRequestOptions]
    expect(sent[0].publicKey?.userVerification).toBe("required")
    expect(sent[0].publicKey?.rpId).toBe("eido.example.invalid")
    expect(
      Buffer.from(sent[0].publicKey?.challenge as ArrayBuffer).toString("hex")
    ).toBe("00".repeat(32))

    const login = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(login[1].body as string)).toEqual({
      assertion: {
        credentialId: "CQ",
        authenticatorData: "AQI",
        clientDataJSON: "Aw",
        signature: "BAU",
      },
    })
  })

  it("asks for a fresh challenge on every attempt", async () => {
    stubWebAuthn(async () => new FakeCredential())
    const fetchMock = route({
      "/api/gate/auth/login/options": () => json(200, options),
      "/api/gate/auth/login": () => json(200, session),
    })
    await unlock()
    await unlock()
    const optionCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/gate/auth/login/options"
    )
    expect(optionCalls).toHaveLength(2)
  })

  it("posts nothing when Face ID is cancelled", async () => {
    stubWebAuthn(async () => {
      throw new DOMException("cancelled", "NotAllowedError")
    })
    const fetchMock = route({
      "/api/gate/auth/login/options": () => json(200, options),
    })
    expect(await unlock()).toEqual({
      ok: false,
      reason: "cancelled",
      message: "",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("posts nothing when the device returns no assertion", async () => {
    stubWebAuthn(async () => null)
    const fetchMock = route({
      "/api/gate/auth/login/options": () => json(200, options),
    })
    expect((await unlock()).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports an unreachable gate before and after Face ID", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline")
    })
    expect(await unlock()).toMatchObject({ ok: false, reason: "offline" })

    stubWebAuthn(async () => new FakeCredential())
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/options")) return json(200, options)
      throw new TypeError("offline")
    })
    expect(await unlock()).toMatchObject({ ok: false, reason: "offline" })
  })

  it("shows the gate's own message when it refuses the login", async () => {
    stubWebAuthn(async () => new FakeCredential())
    route({
      "/api/gate/auth/login/options": () => json(200, options),
      "/api/gate/auth/login": () =>
        json(401, { code: "verification_failed", message: "Passkey refused." }),
    })
    expect(await unlock()).toEqual({
      ok: false,
      reason: "rejected",
      message: "Passkey refused.",
    })
  })

  it("rejects options and sessions it cannot read", async () => {
    route({ "/api/gate/auth/login/options": () => json(200, { nope: 1 }) })
    expect(await unlock()).toMatchObject({ ok: false, reason: "rejected" })

    stubWebAuthn(async () => new FakeCredential())
    route({
      "/api/gate/auth/login/options": () => json(200, options),
      "/api/gate/auth/login": () => json(200, { nope: 1 }),
    })
    expect(await unlock()).toMatchObject({ ok: false, reason: "rejected" })
  })

  it("names the status when the refusal is not a gate error body", async () => {
    route({
      "/api/gate/auth/login/options": () =>
        new Response("<html>", { status: 502 }),
    })
    expect(await unlock()).toEqual({
      ok: false,
      reason: "rejected",
      message: "The gate answered 502.",
    })
  })

  it("logs and stores nothing", async () => {
    stubWebAuthn(async () => new FakeCredential())
    route({
      "/api/gate/auth/login/options": () => json(200, options),
      "/api/gate/auth/login": () => json(200, session),
    })
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => undefined)
    )
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    await unlock()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe("expiredUnlockUrl", () => {
  it("carries the page the user was on, encoded, and the expired flag", () => {
    expect(expiredUnlockUrl("/queue?intent=a&b=1")).toBe(
      "/unlock?next=%2Fqueue%3Fintent%3Da%26b%3D1&expired=1"
    )
  })

  it("never carries an off-site address", () => {
    expect(expiredUnlockUrl("//evil.example.invalid")).toBe(
      "/unlock?next=%2F&expired=1"
    )
  })
})
