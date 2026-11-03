// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/require-await -- fetch and navigator.credentials.get return promises, so their stubs are async functions with nothing to await */
import { IPHONE_UA } from "./platform"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GateRepinPrepared } from "@eido/schemas"
import { repinConnector } from "@/lib/connector-repin"

const DRIFT = { added: ["drive.move_bulk"], removed: ["drive.save"] }

// Keys are sorted and there is no whitespace, so the text is already its RFC 8785 form.
const PAYLOAD =
  '{"name":"drive","operations":[{"name":"drive.list"},{"name":"drive.move_bulk"}],"version":2}'
const PAYLOAD_HASH = createHash("sha256").update(PAYLOAD).digest("hex")
const ID = "approval-1"
const NONCE = "N".repeat(43)

function challengeFor(target: string, hash: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "eido.control.v1",
        "manifest.pin",
        target,
        ID,
        hash,
        NONCE,
      ])
    )
    .digest("base64url")
}

const prepared: GateRepinPrepared = {
  id: ID,
  purpose: "manifest.pin",
  target: "drive",
  payload: PAYLOAD,
  payloadHash: PAYLOAD_HASH,
  nonce: NONCE,
  challenge: challengeFor("drive", PAYLOAD_HASH),
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status })

class FakeAssertionResponse {
  authenticatorData = new Uint8Array([1, 2]).buffer
  clientDataJSON = new Uint8Array([3]).buffer
  signature = new Uint8Array([4, 5]).buffer
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown = new FakeAssertionResponse()
}

function stubWebAuthn(
  get: (options: CredentialRequestOptions) => Promise<unknown>,
  userAgent = ""
) {
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
  const spy = vi.fn(get)
  vi.stubGlobal("navigator", {
    userAgent,
    maxTouchPoints: 0,
    credentials: { get: spy },
  })
  return spy
}

function stubFetch(...responses: Response[]) {
  const spy = vi.fn(async () => responses.shift() ?? json(500, {}))
  vi.stubGlobal("fetch", spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("repinConnector", () => {
  it("prepares, signs the control challenge and posts the assertion, then reports success", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    const fetchMock = stubFetch(
      json(200, prepared),
      json(200, { connector: "drive", manifestHash: PAYLOAD_HASH })
    )
    expect(await repinConnector("drive", DRIFT)).toEqual({ ok: true })

    const urls = fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(urls).toEqual([
      "/api/gate/connector-settings/drive/repin",
      "/api/gate/connector-settings/drive/repin/decision",
    ])
    const options = get.mock.calls[0]![0].publicKey!
    expect(
      Buffer.from(options.challenge as ArrayBuffer).toString("base64url")
    ).toBe(prepared.challenge)
    expect(options.userVerification).toBe("required")
    const sent = JSON.parse(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
        .body as string
    ) as Record<string, unknown>
    expect(sent).toEqual({
      id: ID,
      nonce: NONCE,
      assertion: {
        credentialId: "CQ",
        authenticatorData: "AQI",
        clientDataJSON: "Aw",
        signature: "BAU",
      },
    })
  })

  it("never opens the passkey prompt when the payload no longer matches its hash", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    stubFetch(
      json(200, {
        ...prepared,
        payload: PAYLOAD.replace('"version":2', '"version":3'),
      })
    )
    const outcome = await repinConnector("drive", DRIFT)
    expect(outcome).toMatchObject({ ok: false })
    expect(
      outcome.ok === false && "message" in outcome && outcome.message
    ).toContain("Nothing was signed")
    expect(get).not.toHaveBeenCalled()
  })

  it("refuses a card whose manifest keeps a removed tool", async () => {
    const payload =
      '{"name":"drive","operations":[{"name":"drive.move_bulk"},{"name":"drive.save"}],"version":2}'
    const hash = createHash("sha256").update(payload).digest("hex")
    const get = stubWebAuthn(async () => new FakeCredential())
    stubFetch(
      json(200, {
        ...prepared,
        payload,
        payloadHash: hash,
        challenge: challengeFor("drive", hash),
      })
    )
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    expect(get).not.toHaveBeenCalled()
  })

  it("refuses a card whose manifest lacks an added tool", async () => {
    const payload =
      '{"name":"drive","operations":[{"name":"drive.list"}],"version":2}'
    const hash = createHash("sha256").update(payload).digest("hex")
    const get = stubWebAuthn(async () => new FakeCredential())
    stubFetch(
      json(200, {
        ...prepared,
        payload,
        payloadHash: hash,
        challenge: challengeFor("drive", hash),
      })
    )
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    expect(get).not.toHaveBeenCalled()
  })

  it("refuses a card for another connector", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    stubFetch(
      json(200, {
        ...prepared,
        target: "gmail",
        challenge: challengeFor("gmail", PAYLOAD_HASH),
      })
    )
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    expect(get).not.toHaveBeenCalled()
  })

  it("refuses a challenge that is not the control-ceremony hash of the card", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    stubFetch(json(200, { ...prepared, challenge: "A".repeat(43) }))
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    expect(get).not.toHaveBeenCalled()
  })

  it("reports a cancelled prompt and posts no decision", async () => {
    stubWebAuthn(async () => {
      throw new DOMException("cancelled", "NotAllowedError")
    })
    const fetchMock = stubFetch(json(200, prepared))
    expect(await repinConnector("drive", DRIFT)).toEqual({
      ok: false,
      message:
        "The passkey prompt did not complete. The connector stays disabled.",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("names Face ID when the prompt is cancelled on an iPhone", async () => {
    stubWebAuthn(async () => {
      throw new DOMException("cancelled", "NotAllowedError")
    }, IPHONE_UA)
    stubFetch(json(200, prepared))
    expect(await repinConnector("drive", DRIFT)).toEqual({
      ok: false,
      message: "Face ID did not complete. The connector stays disabled.",
    })
  })

  it("treats a credential that is not an assertion as cancelled", async () => {
    stubWebAuthn(async () => null)
    const fetchMock = stubFetch(json(200, prepared))
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("reports an expired session on either call", async () => {
    stubFetch(json(401, { code: "unauthenticated", message: "no session" }))
    expect(await repinConnector("drive", DRIFT)).toEqual({
      ok: false,
      expired: true,
    })
    stubWebAuthn(async () => new FakeCredential())
    stubFetch(json(200, prepared), json(401, {}))
    expect(await repinConnector("drive", DRIFT)).toEqual({
      ok: false,
      expired: true,
    })
  })

  it("says the old pin is unchanged when the gate refuses the signature", async () => {
    stubWebAuthn(async () => new FakeCredential())
    stubFetch(
      json(200, prepared),
      json(403, {
        code: "verification_failed",
        message: "the re-pin was refused",
      })
    )
    expect(await repinConnector("drive", DRIFT)).toEqual({
      ok: false,
      message: "The gate refused the signature. The old pin is unchanged.",
    })
  })

  it("relays the gate's reason when it cannot start a re-pin", async () => {
    stubFetch(
      json(409, {
        code: "unavailable",
        message: "no reviewed manifest is placed",
      })
    )
    const outcome = await repinConnector("drive", DRIFT)
    expect(outcome).toEqual({
      ok: false,
      message:
        "The gate cannot re-pin this connector: no reviewed manifest is placed. Nothing was changed.",
    })
  })

  it("reports an unreachable gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline")
      })
    )
    expect(await repinConnector("drive", DRIFT)).toEqual({
      ok: false,
      message: "The gate could not be reached. Nothing was changed.",
    })
  })

  it("rejects unreadable bodies and a result that names a different manifest", async () => {
    stubFetch(new Response("not json", { status: 200 }))
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    stubFetch(new Response("oops", { status: 500 }))
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    stubFetch(json(200, { nonsense: true }))
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    stubWebAuthn(async () => new FakeCredential())
    stubFetch(
      json(200, prepared),
      json(200, { connector: "drive", manifestHash: "f".repeat(64) })
    )
    expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
  })

  it("rejects a payload that is not a manifest object", async () => {
    const get = stubWebAuthn(async () => new FakeCredential())
    for (const payload of [
      '"text"',
      "null",
      '{"name":"drive"}',
      '{"name":"drive","operations":[1]}',
    ]) {
      const hash = createHash("sha256").update(payload).digest("hex")
      stubFetch(
        json(200, {
          ...prepared,
          payload,
          payloadHash: hash,
          challenge: challengeFor("drive", hash),
        })
      )
      expect(await repinConnector("drive", DRIFT)).toMatchObject({ ok: false })
    }
    expect(get).not.toHaveBeenCalled()
  })
})
