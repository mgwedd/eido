// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch and passkey stubs return promises */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GateControlPrepared } from "@eido/schemas"
import {
  checkPrepared,
  controlChallenge,
  prepareControl,
  submitControl,
} from "@/lib/admin/control"
import { anyJson } from "@/lib/admin/gate"
import { FAKE_ASSERTION, FakeCredential, stubPasskey } from "./admin-webauthn"

// Hash and challenge computed with Python hashlib over the same canonical text and array.
const prepared: GateControlPrepared = {
  id: "ctl-1",
  purpose: "policy.set",
  target: "connector_secret:simplefin",
  payload: '{"action":"connector.secret.set","connector":"simplefin"}',
  payloadHash:
    "77c08de78f174f8bb87501c9659b222c630f6ec60b774406528ca0fdd7f65909",
  nonce: "N".repeat(43),
  challenge: "AtMzkdGP2kSLzVWR8mYHXk0_9BXCnXhFCJSifIos54M",
}
const expected = {
  target: "connector_secret:simplefin",
  payload: { connector: "simplefin", action: "connector.secret.set" },
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("controlChallenge", () => {
  it("hashes the control ceremony array as the gate does", async () => {
    expect(await controlChallenge(prepared)).toBe(prepared.challenge)
  })
})

describe("checkPrepared", () => {
  it("accepts the change the page asked for, whatever its key order", async () => {
    expect(await checkPrepared(prepared, expected)).toBe(true)
  })

  it("refuses a payload that does not hash to payloadHash", async () => {
    expect(
      await checkPrepared(
        {
          ...prepared,
          payload: '{"action":"connector.secret.set","connector":"gmail"}',
        },
        expected
      )
    ).toBe(false)
  })

  it("refuses another target", async () => {
    expect(
      await checkPrepared(prepared, {
        ...expected,
        target: "connector_secret:gmail",
      })
    ).toBe(false)
  })

  it("refuses a payload other than the one asked for", async () => {
    expect(
      await checkPrepared(prepared, {
        ...expected,
        payload: { action: "connector.pin.set", connector: "simplefin" },
      })
    ).toBe(false)
  })

  it("refuses a challenge that is not over these values", async () => {
    expect(
      await checkPrepared({ ...prepared, challenge: "A".repeat(43) }, expected)
    ).toBe(false)
  })

  it("refuses a payload that is not JSON", async () => {
    // SHA-256 of the 8 bytes "not json", from Python hashlib.
    expect(
      await checkPrepared(
        {
          ...prepared,
          payload: "not json",
          payloadHash:
            "7ccfa1fbf3940e6f0c0375d87c0f9235a50514e14cb427bdfaf5077987b26ccf",
        },
        expected
      )
    ).toBe(false)
  })
})

describe("prepareControl", () => {
  it("posts the prepare body and returns the checked change", async () => {
    const fetchMock = vi.fn(async () => json(200, prepared))
    vi.stubGlobal("fetch", fetchMock)
    expect(
      await prepareControl({
        preparePath: "/admin/secrets/simplefin/prepare",
        ...expected,
      })
    ).toEqual({ kind: "ok", status: 200, value: prepared })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("/api/gate/admin/secrets/simplefin/prepare")
    expect(init.body).toBe("{}")
  })

  it("is a mismatch when the gate prepared something else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, prepared))
    )
    expect(
      await prepareControl({
        preparePath: "/p",
        target: "connector_secret:gmail",
        payload: expected.payload,
      })
    ).toEqual({ kind: "mismatch" })
  })

  it("passes a gate failure through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, {}))
    )
    expect(await prepareControl({ preparePath: "/p", ...expected })).toEqual({
      kind: "expired",
    })
  })
})

describe("submitControl", () => {
  it("signs the challenge and sends the approval with the extra fields read at send time", async () => {
    const get = stubPasskey(async () => new FakeCredential())
    const fetchMock = vi.fn(async () => json(200, { ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    let token = "typed"
    const extra = vi.fn(() => ({ setupToken: token }))
    const sending = submitControl(
      prepared,
      "/admin/secrets/simplefin",
      anyJson,
      extra
    )
    token = "typed later"
    expect(await sending).toEqual({
      kind: "ok",
      status: 200,
      value: { ok: true },
    })
    const options = get.mock.calls[0] as unknown as [CredentialRequestOptions]
    expect(options[0].publicKey?.userVerification).toBe("required")
    expect(options[0].publicKey?.rpId).toBe(window.location.hostname)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toEqual({
      setupToken: "typed later",
      approval: {
        id: "ctl-1",
        nonce: "N".repeat(43),
        assertion: FAKE_ASSERTION,
      },
    })
  })

  it("is cancelled and sends nothing when the passkey prompt fails", async () => {
    stubPasskey(async () =>
      Promise.reject(new DOMException("no", "NotAllowedError"))
    )
    const fetchMock = vi.fn(async () => json(200, {}))
    vi.stubGlobal("fetch", fetchMock)
    expect(await submitControl(prepared, "/s", anyJson)).toEqual({
      kind: "cancelled",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("is cancelled when the passkey answers with something other than a credential", async () => {
    stubPasskey(async () => null)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, {}))
    )
    expect(await submitControl(prepared, "/s", anyJson)).toEqual({
      kind: "cancelled",
    })
  })
})
