// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- stubs of promise-returning browser APIs */
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  creationOptions,
  enrol,
  enrolUrl,
  loadPasskeyCreatedAt,
  safeEnrolNext,
  toRegistration,
} from "@/lib/enrol"

class FakeAttestationResponse {
  clientDataJSON = new Uint8Array([251, 255]).buffer
  getAuthenticatorData = () => new Uint8Array([1, 2, 3]).buffer
  getPublicKey = (): ArrayBuffer | null => new Uint8Array([250, 0]).buffer
  getPublicKeyAlgorithm = () => -7
}
class FakeCredential {
  rawId = new Uint8Array([255, 254, 253]).buffer
  response: unknown = new FakeAttestationResponse()
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const OPTIONS = {
  challenge: `-_8${"A".repeat(40)}`, // bytes fb ff 00 ...
  rpId: "eido.tail1234.ts.net",
  expiresAt: "2026-10-27T10:00:00.000Z",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(opts: {
  create?: () => Promise<unknown>
  routes?: Record<string, () => Response>
}) {
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
  vi.stubGlobal("AuthenticatorAttestationResponse", FakeAttestationResponse)
  const create = vi.fn(opts.create ?? (async () => new FakeCredential()))
  vi.stubGlobal("navigator", { credentials: { create } })
  const routes: Record<string, () => Response> = {
    "/api/gate/passkey/enroll/options": () => json(200, OPTIONS),
    "/api/gate/passkey/enroll": () =>
      json(200, { expiresAt: "2026-10-27T22:00:00Z" }),
    ...opts.routes,
  }
  const fetchStub = vi.fn(async (url: string) => {
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected ${url}`)
    return route()
  })
  vi.stubGlobal("fetch", fetchStub)
  return { create, fetchStub }
}

describe("creationOptions", () => {
  const userId = new Uint8Array(16)
  const { publicKey } = creationOptions(OPTIONS, "eido.tail1234.ts.net", userId)

  it("binds the passkey to the given host", () => {
    expect(publicKey?.rp.id).toBe("eido.tail1234.ts.net")
  })

  it("accepts ES256 only", () => {
    expect(publicKey?.pubKeyCredParams).toEqual([
      { type: "public-key", alg: -7 },
    ])
  })

  it("asks for a user-verified resident platform passkey with no attestation", () => {
    expect(publicKey?.authenticatorSelection).toEqual({
      authenticatorAttachment: "platform",
      residentKey: "required",
      userVerification: "required",
    })
    expect(publicKey?.attestation).toBe("none")
  })

  it("decodes the gate's base64url challenge", () => {
    expect(
      [...new Uint8Array(publicKey?.challenge as ArrayBuffer)].slice(0, 3)
    ).toEqual([0xfb, 0xff, 0x00])
  })
})

describe("toRegistration", () => {
  it("encodes every binary field as unpadded base64url", () => {
    setup({})
    expect(toRegistration(new FakeCredential() as never)).toEqual({
      credentialId: "__79",
      clientDataJSON: "-_8",
      authenticatorData: "AQID",
      publicKey: "-gA",
      publicKeyAlgorithm: -7,
    })
  })

  it("is undefined when the authenticator gives no public key", () => {
    setup({})
    const credential = new FakeCredential()
    const response = new FakeAttestationResponse()
    response.getPublicKey = () => null
    credential.response = response
    expect(toRegistration(credential as never)).toBeUndefined()
  })
})

describe("safeEnrolNext and enrolUrl", () => {
  it("falls back to Today for unsafe or self-referencing targets", () => {
    expect(safeEnrolNext("https://evil.example")).toBe("/")
    expect(safeEnrolNext("//evil.example")).toBe("/")
    expect(safeEnrolNext("/enroll?next=/queue")).toBe("/")
    expect(safeEnrolNext("/unlock")).toBe("/")
    expect(safeEnrolNext("/queue?x=1")).toBe("/queue?x=1")
  })

  it("carries next only when it is not Today", () => {
    expect(enrolUrl("/")).toBe("/enroll")
    expect(enrolUrl("/queue?x=1")).toBe("/enroll?next=%2Fqueue%3Fx%3D1")
  })
})

describe("enrol", () => {
  it("returns the recovery key the gate sends with the first enrolment", async () => {
    setup({
      routes: {
        "/api/gate/passkey/enroll": () =>
          json(200, {
            expiresAt: "2026-10-27T22:00:00Z",
            recoveryKey: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789",
          }),
      },
    })
    expect(await enrol("ABCD-EFGH", "eido.tail1234.ts.net")).toEqual({
      ok: true,
      recoveryKey: "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789",
    })
  })

  it("posts the code and registration after creating the passkey", async () => {
    const { create, fetchStub } = setup({})
    const result = await enrol("ABCD-EFGH", "eido.tail1234.ts.net")
    expect(result).toEqual({ ok: true })
    expect(create).toHaveBeenCalledOnce()
    const calls = fetchStub.mock.calls as unknown as [
      string,
      { body: string },
    ][]
    expect(calls.map((c) => c[0])).toEqual([
      "/api/gate/passkey/enroll/options",
      "/api/gate/passkey/enroll",
    ])
    expect(JSON.parse(calls[0]?.[1].body ?? "")).toEqual({ code: "ABCD-EFGH" })
    expect(JSON.parse(calls[1]?.[1].body ?? "")).toEqual({
      code: "ABCD-EFGH",
      registration: {
        credentialId: "__79",
        clientDataJSON: "-_8",
        authenticatorData: "AQID",
        publicKey: "-gA",
        publicKeyAlgorithm: -7,
      },
    })
  })

  it("shows the gate's refusal of the code and never reaches the passkey prompt", async () => {
    const { create } = setup({
      routes: {
        "/api/gate/passkey/enroll/options": () =>
          json(403, {
            code: "verification_failed",
            message: "the enrolment was refused",
          }),
      },
    })
    expect(await enrol("X", "h")).toEqual({
      ok: false,
      reason: "rejected",
      message: "the enrolment was refused",
    })
    expect(create).not.toHaveBeenCalled()
  })

  it("reports a cancelled passkey prompt and posts nothing", async () => {
    const { fetchStub } = setup({
      create: async () => {
        throw new DOMException("cancelled", "NotAllowedError")
      },
    })
    expect(await enrol("X", "h")).toMatchObject({
      ok: false,
      reason: "cancelled",
    })
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it("shows the gate's refusal of the registration without retrying", async () => {
    const { fetchStub } = setup({
      routes: {
        "/api/gate/passkey/enroll": () =>
          json(403, { code: "verification_failed", message: "refused" }),
      },
    })
    expect(await enrol("X", "h")).toMatchObject({
      reason: "rejected",
      message: "refused",
    })
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })

  it("reports an unreachable gate", async () => {
    setup({})
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network")
      })
    )
    expect(await enrol("X", "h")).toMatchObject({
      ok: false,
      reason: "offline",
    })
  })

  it("refuses an unreadable gate answer", async () => {
    setup({
      routes: { "/api/gate/passkey/enroll/options": () => json(200, { a: 1 }) },
    })
    expect(await enrol("X", "h")).toMatchObject({
      reason: "rejected",
      message: "The gate sent an answer Eido could not read.",
    })
  })

  it("keeps the code, challenge and registration out of console and storage", async () => {
    setup({})
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method)
    )
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    await enrol("SECRETCODE", "eido.tail1234.ts.net")
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    vi.restoreAllMocks()
  })
})

describe("loadPasskeyCreatedAt", () => {
  it("returns the current, unrevoked passkey's creation time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(200, {
          passkeys: [
            {
              fingerprint: "a".repeat(64),
              createdAt: "2026-01-01T00:00:00.000Z",
              revokedAt: null,
              current: false,
            },
            {
              fingerprint: "b".repeat(64),
              createdAt: "2026-02-02T00:00:00.000Z",
              revokedAt: null,
              current: true,
            },
          ],
        })
      )
    )
    expect(await loadPasskeyCreatedAt()).toBe("2026-02-02T00:00:00.000Z")
  })

  it("is null without a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { code: "unauthorized", message: "no" }))
    )
    expect(await loadPasskeyCreatedAt()).toBeNull()
  })
})
