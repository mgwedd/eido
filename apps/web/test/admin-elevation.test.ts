// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch and passkey stubs return promises */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadElevation,
  remaining,
  stepUp,
  validateElevation,
} from "@/lib/admin/elevation"
import { FAKE_ASSERTION, FakeCredential, stubPasskey } from "./admin-webauthn"

const UNTIL = "2026-11-07T10:05:00.000Z"
const options = {
  challenge: "C".repeat(43),
  rpId: "eido.example.invalid",
  expiresAt: "2026-11-07T10:01:00.000Z",
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("validateElevation", () => {
  it("accepts an ISO time or null", () => {
    expect(validateElevation({ expiresAt: UNTIL })).toEqual({
      ok: true,
      value: { expiresAt: UNTIL },
    })
    expect(validateElevation({ expiresAt: null })).toEqual({
      ok: true,
      value: { expiresAt: null },
    })
  })

  it("rejects anything else", () => {
    expect(validateElevation({ expiresAt: "soon" }).ok).toBe(false)
    expect(validateElevation({ expiresAt: 5 }).ok).toBe(false)
    expect(validateElevation({}).ok).toBe(false)
    expect(validateElevation(null).ok).toBe(false)
  })
})

describe("loadElevation", () => {
  it("reads GET /auth/step-up", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(200, { expiresAt: UNTIL })
    )
    vi.stubGlobal("fetch", fetchMock)
    expect(await loadElevation()).toEqual({
      kind: "ok",
      status: 200,
      value: { expiresAt: UNTIL },
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/gate/auth/step-up")
  })
})

describe("stepUp", () => {
  it("takes the gate's challenge, asks the passkey with user verification, and posts the assertion", async () => {
    const get = stubPasskey(async () => new FakeCredential())
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/options")
        ? json(200, options)
        : json(200, { expiresAt: UNTIL })
    )
    vi.stubGlobal("fetch", fetchMock)
    expect(await stepUp()).toEqual({
      kind: "ok",
      status: 200,
      value: { expiresAt: UNTIL },
    })
    const request = get.mock.calls[0] as unknown as [CredentialRequestOptions]
    expect(request[0].publicKey?.rpId).toBe("eido.example.invalid")
    expect(request[0].publicKey?.userVerification).toBe("required")
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["/api/gate/auth/step-up/options", "POST"],
      ["/api/gate/auth/step-up", "POST"],
    ])
    expect(
      JSON.parse(
        typeof calls[1]?.[1].body === "string" ? calls[1]?.[1].body : ""
      )
    ).toEqual({
      assertion: FAKE_ASSERTION,
    })
  })

  it("stops at the options when the gate refuses them", async () => {
    const get = stubPasskey(async () => new FakeCredential())
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, {}))
    )
    expect(await stepUp()).toEqual({ kind: "expired" })
    expect(get).not.toHaveBeenCalled()
  })

  it("is cancelled when the passkey prompt fails or returns no credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, options))
    )
    stubPasskey(async () =>
      Promise.reject(new DOMException("no", "NotAllowedError"))
    )
    expect(await stepUp()).toEqual({ kind: "cancelled" })
    stubPasskey(async () => null)
    expect(await stepUp()).toEqual({ kind: "cancelled" })
  })
})

describe("remaining", () => {
  const at = Date.parse(UNTIL)
  it("shows minutes and two-digit seconds", () => {
    expect(remaining(UNTIL, at - 252_000)).toBe("4:12")
    expect(remaining(UNTIL, at - 5_000)).toBe("0:05")
  })
  it("rounds a part second up and never goes below 0:00", () => {
    expect(remaining(UNTIL, at - 500)).toBe("0:01")
    expect(remaining(UNTIL, at + 10_000)).toBe("0:00")
  })
})
