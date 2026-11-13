// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- stubs of promise-returning browser APIs */
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  checkedCancelChallenge,
  cancelRecovery,
  completeRecovery,
  delayProgress,
  formatCountdown,
  formatMaturesIn,
  formatElapsed,
  keyLines,
  recoveryKeyFileText,
  recoveryPhase,
  startRecovery,
} from "@/lib/recovery"
import {
  CANCEL_NONCE,
  bodyText,
  KEY,
  NOW,
  REPLACEMENT_KEY,
  preparedCancel,
  recoveryFixtures,
  sha256,
} from "./fixtures/recovery"

const { pending, matured, expired } = recoveryFixtures

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe("recoveryPhase", () => {
  it("is pending before maturesAt and matured from that instant", () => {
    const at = Date.parse(pending.maturesAt)
    expect(recoveryPhase(pending, at - 1)).toBe("pending")
    expect(recoveryPhase(pending, at)).toBe("matured")
  })

  it("is expired from expiresAt, and stays expired long after", () => {
    expect(recoveryPhase(expired, NOW)).toBe("expired")
    const at = Date.parse(matured.expiresAt)
    expect(recoveryPhase(matured, at - 1)).toBe("matured")
    expect(recoveryPhase(matured, at)).toBe("expired")
  })
})

describe("formatCountdown", () => {
  it("shows hours and minutes", () => {
    expect(formatCountdown(pending, NOW)).toBe("23h 41m")
  })

  it("rounds a partial minute up so it never shows 0m while time is left", () => {
    const at = Date.parse(pending.maturesAt) - 1_000
    expect(formatCountdown(pending, at)).toBe("1m")
  })

  it("drops the hours under an hour and stops at zero", () => {
    expect(
      formatCountdown(pending, Date.parse(pending.maturesAt) - 9 * 60_000)
    ).toBe("9m")
    expect(formatCountdown(matured, NOW)).toBe("0m")
  })
})

describe("formatElapsed", () => {
  it("shows hours and minutes since the start, padded", () => {
    expect(formatElapsed(pending, NOW)).toBe("00:19")
    expect(formatElapsed(matured, NOW)).toBe("25:00")
  })
})

describe("delayProgress", () => {
  it("is the share of the delay gone, clamped to 0..100", () => {
    const start = Date.parse(pending.startedAt)
    const delay = Date.parse(pending.maturesAt) - start
    expect(delayProgress(pending, start + delay / 4)).toBeCloseTo(25)
    expect(delayProgress(pending, start - 5)).toBe(0)
    expect(delayProgress(matured, NOW)).toBe(100)
  })
})

describe("keyLines and recoveryKeyFileText", () => {
  it("splits eight groups into two lines of four", () => {
    expect(keyLines(KEY)).toEqual([
      "ABCD-EFGH-JKMN-PQRS",
      "TVWX-YZ01-2345-6789",
    ])
  })

  it("writes the key and a newline, nothing else", () => {
    expect(recoveryKeyFileText(KEY)).toBe(`${KEY}\n`)
  })
})

describe("startRecovery", () => {
  afterEach(() => vi.unstubAllGlobals())

  function stub(response: () => Response | Promise<Response>) {
    const fetchStub = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async () => response())
    vi.stubGlobal("fetch", fetchStub)
    return fetchStub
  }

  it("posts the key to the start route and returns the window", async () => {
    const fetchStub = stub(() => json(200, pending))
    const result = await startRecovery(KEY)
    expect(result).toEqual({ ok: true, value: pending })
    const [url, init] = fetchStub.mock.calls[0] ?? []
    expect(url).toBe("/api/gate/passkey/recover/start")
    expect(JSON.parse(bodyText(init))).toEqual({ recoveryKey: KEY })
  })

  it("maps the gate's answers to one reason each", async () => {
    stub(() => json(403, { error: "verification_failed" }))
    expect(await startRecovery(KEY)).toEqual({ ok: false, reason: "refused" })
    stub(() => json(429, { error: "busy" }))
    expect(await startRecovery(KEY)).toEqual({
      ok: false,
      reason: "rate-limited",
    })
    stub(() => {
      throw new TypeError("network")
    })
    expect(await startRecovery(KEY)).toEqual({ ok: false, reason: "offline" })
    stub(() => json(200, { startedAt: "not a window" }))
    expect(await startRecovery(KEY)).toEqual({
      ok: false,
      reason: "unreadable",
    })
  })

  it("keeps the key out of storage, the URL and the console", async () => {
    const fetchStub = stub(() => json(200, pending))
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    const log = vi.spyOn(console, "log")
    const error = vi.spyOn(console, "error")
    await startRecovery(KEY)
    expect(setItem).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(String(fetchStub.mock.calls[0]?.[0])).not.toContain("ABCD")
    vi.restoreAllMocks()
  })
})

class FakeAttestationResponse {
  clientDataJSON = new Uint8Array([2]).buffer
  getAuthenticatorData = () => new Uint8Array([1]).buffer
  getPublicKey = () => new Uint8Array([4]).buffer
  getPublicKeyAlgorithm = () => -7
}
class FakeAssertionResponse {
  clientDataJSON = new Uint8Array([5]).buffer
  authenticatorData = new Uint8Array([6]).buffer
  signature = new Uint8Array([7]).buffer
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown
  constructor(response: unknown) {
    this.response = response
  }
}

const OPTIONS = {
  challenge: "A".repeat(43),
  rpId: "eido.tail1234.ts.net",
  expiresAt: "2030-01-15T12:10:00.000Z",
}

function stubWebAuthn(opts: {
  create?: () => Promise<unknown>
  get?: () => Promise<unknown>
}) {
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
  vi.stubGlobal("AuthenticatorAttestationResponse", FakeAttestationResponse)
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
  const create = vi.fn(
    opts.create ??
      (async () => new FakeCredential(new FakeAttestationResponse()))
  )
  const get = vi.fn(
    opts.get ?? (async () => new FakeCredential(new FakeAssertionResponse()))
  )
  vi.stubGlobal("navigator", { credentials: { create, get } })
  return { create, get }
}

function stubRoutes(routes: Record<string, () => Response>) {
  const fetchStub = vi.fn<
    (url: string, init?: RequestInit) => Promise<Response>
  >(async (url) => {
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected ${url}`)
    return route()
  })
  vi.stubGlobal("fetch", fetchStub)
  return fetchStub
}

describe("completeRecovery", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("creates the passkey and returns the replacement key", async () => {
    const { create } = stubWebAuthn({})
    const fetchStub = stubRoutes({
      "/api/gate/passkey/recover/options": () => json(200, OPTIONS),
      "/api/gate/passkey/recover/complete": () =>
        json(200, {
          expiresAt: "2030-01-16T00:00:00.000Z",
          recoveryKey: REPLACEMENT_KEY,
        }),
    })
    const result = await completeRecovery(KEY, "eido.tail1234.ts.net")
    expect(result).toEqual({ ok: true, value: REPLACEMENT_KEY })
    expect(create).toHaveBeenCalledOnce()
    const completeBody = JSON.parse(bodyText(fetchStub.mock.calls[1]?.[1])) as {
      recoveryKey: string
      registration: { credentialId: string }
    }
    expect(completeBody.recoveryKey).toBe(KEY)
    expect(completeBody.registration.credentialId).toBe("CQ")
  })

  it("is refused without touching the authenticator when the gate refuses the key", async () => {
    const { create } = stubWebAuthn({})
    stubRoutes({
      "/api/gate/passkey/recover/options": () =>
        json(403, { error: "verification_failed" }),
    })
    expect(await completeRecovery(KEY, "eido.tail1234.ts.net")).toEqual({
      ok: false,
      reason: "refused",
    })
    expect(create).not.toHaveBeenCalled()
  })

  it("reports a cancelled prompt and posts nothing", async () => {
    stubWebAuthn({
      create: async () => {
        throw new DOMException("denied", "NotAllowedError")
      },
    })
    const fetchStub = stubRoutes({
      "/api/gate/passkey/recover/options": () => json(200, OPTIONS),
    })
    expect(await completeRecovery(KEY, "eido.tail1234.ts.net")).toEqual({
      ok: false,
      reason: "cancelled",
    })
    expect(fetchStub).toHaveBeenCalledOnce()
  })

  it("reports a refused completion, such as a recovery that is not ready", async () => {
    stubWebAuthn({})
    stubRoutes({
      "/api/gate/passkey/recover/options": () => json(200, OPTIONS),
      "/api/gate/passkey/recover/complete": () =>
        json(403, { error: "verification_failed" }),
    })
    expect(await completeRecovery(KEY, "eido.tail1234.ts.net")).toEqual({
      ok: false,
      reason: "refused",
    })
  })
})

const prepared = preparedCancel
const NONCE = CANCEL_NONCE

describe("checkedCancelChallenge", () => {
  it("returns the challenge bytes when the payload, hash and challenge agree", async () => {
    const good = prepared()
    const bytes = await checkedCancelChallenge(good)
    expect(Buffer.from(bytes ?? []).toString("base64url")).toBe(good.challenge)
  })

  it("refuses a payload that is not the cancel of a recovery", async () => {
    const payload = '{"action":"intent.approve","recoveryId":"rec-1"}'
    expect(
      await checkedCancelChallenge(
        prepared({ payload, payloadHash: sha256(payload).toString("hex") })
      )
    ).toBeUndefined()
  })

  it("refuses a hash that is not the payload's hash", async () => {
    expect(
      await checkedCancelChallenge(
        prepared({ payloadHash: sha256("something else").toString("hex") })
      )
    ).toBeUndefined()
  })

  it("refuses a challenge built over a different nonce", async () => {
    const other = prepared({ nonce: "m".repeat(43) })
    expect(
      await checkedCancelChallenge({
        ...other,
        challenge: prepared().challenge,
      })
    ).toBeUndefined()
  })

  it("refuses a payload that is not JSON", async () => {
    expect(
      await checkedCancelChallenge(prepared({ payload: "not json" }))
    ).toBeUndefined()
  })
})

describe("cancelRecovery", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("signs the checked challenge and returns the replacement key", async () => {
    const { get } = stubWebAuthn({})
    const fetchStub = stubRoutes({
      "/api/gate/passkey/recover/cancel/prepare": () => json(200, prepared()),
      "/api/gate/passkey/recover/cancel": () =>
        json(200, { recoveryKey: REPLACEMENT_KEY }),
    })
    expect(await cancelRecovery("eido.tail1234.ts.net")).toEqual({
      ok: true,
      value: REPLACEMENT_KEY,
    })
    const options = get.mock.calls[0] as unknown as [
      { publicKey: { challenge: ArrayBuffer; rpId: string } },
    ]
    expect(
      Buffer.from(options[0].publicKey.challenge).toString("base64url")
    ).toBe(prepared().challenge)
    expect(options[0].publicKey.rpId).toBe("eido.tail1234.ts.net")
    const body = JSON.parse(bodyText(fetchStub.mock.calls[1]?.[1])) as {
      approval: { id: string; nonce: string; assertion: { signature: string } }
    }
    expect(body.approval.id).toBe("cancel-1")
    expect(body.approval.nonce).toBe(NONCE)
    expect(body.approval.assertion.signature).toBe("Bw")
  })

  it("does not ask for the passkey when the gate's card is not a recovery cancel", async () => {
    const { get } = stubWebAuthn({})
    stubRoutes({
      "/api/gate/passkey/recover/cancel/prepare": () =>
        json(200, prepared({ challenge: "x".repeat(43) })),
    })
    expect(await cancelRecovery("eido.tail1234.ts.net")).toEqual({
      ok: false,
      reason: "unreadable",
    })
    expect(get).not.toHaveBeenCalled()
  })

  it("reports nothing pending on a 404 and a cancelled prompt as cancelled", async () => {
    stubWebAuthn({})
    stubRoutes({
      "/api/gate/passkey/recover/cancel/prepare": () =>
        json(404, { error: "not_found" }),
    })
    expect(await cancelRecovery("eido.tail1234.ts.net")).toEqual({
      ok: false,
      reason: "not-pending",
    })
    stubWebAuthn({
      get: async () => {
        throw new DOMException("denied", "NotAllowedError")
      },
    })
    stubRoutes({
      "/api/gate/passkey/recover/cancel/prepare": () => json(200, prepared()),
    })
    expect(await cancelRecovery("eido.tail1234.ts.net")).toEqual({
      ok: false,
      reason: "cancelled",
    })
  })
})

describe("formatMaturesIn", () => {
  it("rounds down to whole hours while an hour or more is left", () => {
    expect(formatMaturesIn(pending, NOW)).toBe("23h")
  })

  it("counts minutes, rounded up, in the last hour", () => {
    const at = Date.parse(pending.maturesAt) - 41 * 60_000 + 1
    expect(formatMaturesIn(pending, at)).toBe("41m")
  })
})
