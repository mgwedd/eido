// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  changeBridgePin,
  checkGoogleApproval,
  isPin,
  landingMessage,
  normalizePin,
  prepareGoogle,
  readGoogleLanding,
  removeConnector,
  removeCopy,
  sealBridgePassword,
  sealSimpleFin,
  startGoogle,
  type Signer,
} from "@/lib/admin/connectors"
import { FAKE_ASSERTION, FakeCredential, stubPasskey } from "./admin-webauthn"
import {
  FLOW,
  GOOGLE_CLIENT_ID,
  GOOGLE_URL,
  OTHER_PIN,
  PIN,
  bridgePrepared,
  fakeGate,
  googlePrepared,
  json,
  pinPrepared,
  sealedHealth,
  simplefinPrepared,
  type Call,
} from "./fixtures/admin-connectors"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A signer that signs at once, remembering what it was asked to show. */
function signer() {
  const shown: Parameters<Signer>[0][] = []
  const signed: Signer = (change, send) => {
    shown.push(change)
    return send()
  }
  return { signed, shown }
}

const passkey = () => stubPasskey(() => Promise.resolve(new FakeCredential()))

describe("normalizePin and isPin", () => {
  it("lowercases and drops colons and spaces, as Bridge prints a fingerprint", () => {
    const spaced = PIN.toUpperCase().match(/.{2}/g)?.join(":") ?? ""
    expect(normalizePin(` ${spaced} `)).toBe(PIN)
  })
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(isPin(PIN)).toBe(true)
    expect(isPin(PIN.slice(1))).toBe(false)
    expect(isPin(`${PIN.slice(1)}g`)).toBe(false)
  })
})

describe("sealBridgePassword", () => {
  const routes = (prepared = bridgePrepared(PIN)) => ({
    "POST /admin/secrets/bridge/prepare": () => json(200, prepared),
    "POST /admin/secrets/bridge": () => json(201, sealedHealth),
  })

  it("prepares for the pin, shows the pin shortened and posts the password read at send time", async () => {
    const gate = fakeGate(routes())
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    const { signed, shown } = signer()
    const read = vi.fn(() => "hunter2-bridge")
    const result = await sealBridgePassword(signed, PIN.toUpperCase(), read)
    expect(result).toEqual({ kind: "sealed" })
    expect(gate.calls).toEqual([
      {
        path: "/admin/secrets/bridge/prepare",
        method: "POST",
        body: { certificateSha256: PIN },
      },
      {
        path: "/admin/secrets/bridge",
        method: "POST",
        body: {
          certificateSha256: PIN,
          password: "hunter2-bridge",
          approval: {
            id: "control-1",
            nonce: "N".repeat(43),
            assertion: FAKE_ASSERTION,
          },
        },
      },
    ])
    expect(shown[0]?.fields).toEqual([
      ["Connector", "Proton Mail (Bridge)"],
      ["Pin sha256", "ab12 ab12"],
    ])
    expect(JSON.stringify(shown)).not.toContain("hunter2-bridge")
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("does not call the network for a malformed pin", async () => {
    const gate = fakeGate(routes())
    vi.stubGlobal("fetch", gate.fetch)
    const result = await sealBridgePassword(signer().signed, "abc", () => "x")
    expect(result).toEqual({
      kind: "invalid",
      message: "The certificate pin must be 64 hex characters (SHA-256).",
    })
    expect(gate.calls).toEqual([])
  })

  it("signs nothing when the gate prepared another pin", async () => {
    const gate = fakeGate(routes(bridgePrepared(OTHER_PIN)))
    vi.stubGlobal("fetch", gate.fetch)
    const get = passkey()
    const read = vi.fn(() => "secret")
    const result = await sealBridgePassword(signer().signed, PIN, read)
    expect(result).toEqual({
      kind: "failed",
      reason:
        "the gate prepared a different change than asked, so nothing was signed",
    })
    expect(get).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it("names the pin mismatch the gate answers with", async () => {
    const gate = fakeGate({
      "POST /admin/secrets/bridge/prepare": () =>
        json(409, { code: "pin_mismatch", message: "x" }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    expect(await sealBridgePassword(signer().signed, PIN, () => "x")).toEqual({
      kind: "failed",
      reason: "the gate runs with another Bridge certificate pin",
    })
  })

  it("reports a refused signature as refused", async () => {
    const gate = fakeGate({
      ...routes(),
      "POST /admin/secrets/bridge": () =>
        json(403, { code: "verification_failed", message: "x" }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    expect(await sealBridgePassword(signer().signed, PIN, () => "x")).toEqual({
      kind: "refused",
    })
  })

  it("reports a closed passkey prompt as cancelled and sends no secret", async () => {
    const gate = fakeGate(routes())
    vi.stubGlobal("fetch", gate.fetch)
    stubPasskey(() => Promise.resolve(null))
    const read = vi.fn(() => "secret")
    expect(await sealBridgePassword(signer().signed, PIN, read)).toEqual({
      kind: "cancelled",
    })
    expect(gate.calls.map((c) => c.path)).toEqual([
      "/admin/secrets/bridge/prepare",
    ])
    expect(read).not.toHaveBeenCalled()
  })

  it("says the gate could not be reached when fetch fails", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network")))
    expect(await sealBridgePassword(signer().signed, PIN, () => "x")).toEqual({
      kind: "failed",
      reason: "the gate could not be reached",
    })
  })

  it("falls back to the code for a refusal it has no words for", async () => {
    const gate = fakeGate({
      "POST /admin/secrets/bridge/prepare": () =>
        json(409, { code: "busy", message: "x" }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    expect(await sealBridgePassword(signer().signed, PIN, () => "x")).toEqual({
      kind: "failed",
      reason: "the gate refused it (busy)",
    })
  })
})

describe("changeBridgePin", () => {
  it("posts the pin alone, with no password, and says to restart", async () => {
    const gate = fakeGate({
      "POST /admin/secrets/bridge-pin/prepare": () =>
        json(200, pinPrepared(OTHER_PIN)),
      "POST /admin/secrets/bridge-pin": () =>
        json(200, { certificateSha256: OTHER_PIN }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    const { signed, shown } = signer()
    const result = await changeBridgePin(signed, OTHER_PIN)
    expect(result.kind).toBe("sealed")
    expect(result.kind === "sealed" && result.message).toBe(
      "Pin changed and the stored Bridge password deleted. Restart the stack from Status, then seal the password again."
    )
    const [prepare, submit] = gate.calls
    expect(prepare?.body).toEqual({ certificateSha256: OTHER_PIN })
    expect(submit?.body).toEqual({
      certificateSha256: OTHER_PIN,
      approval: {
        id: "control-1",
        nonce: "N".repeat(43),
        assertion: FAKE_ASSERTION,
      },
    })
    expect(shown[0]?.fields).toContainEqual([
      "Effect",
      "Deletes the stored Bridge password",
    ])
  })

  it("rejects a malformed pin before any call", async () => {
    const gate = fakeGate({})
    vi.stubGlobal("fetch", gate.fetch)
    expect((await changeBridgePin(signer().signed, "")).kind).toBe("invalid")
    expect(gate.calls).toEqual([])
  })

  it("names a certificate that does not match the pin", async () => {
    const gate = fakeGate({
      "POST /admin/secrets/bridge-pin/prepare": () =>
        json(409, { code: "certificate_mismatch", message: "x" }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    expect(await changeBridgePin(signer().signed, OTHER_PIN)).toEqual({
      kind: "failed",
      reason: "the exported Bridge certificate does not match that pin",
    })
  })
})

describe("sealSimpleFin", () => {
  const routes = (submit: () => Response) => ({
    "POST /admin/secrets/simplefin/prepare": () => json(200, simplefinPrepared),
    "POST /admin/secrets/simplefin": submit,
  })

  it("posts the setup token read at send time under the signed approval", async () => {
    const gate = fakeGate(routes(() => json(201, sealedHealth)))
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    const result = await sealSimpleFin(signer().signed, () => "token-abc")
    expect(result).toEqual({ kind: "sealed" })
    expect(gate.calls[0]?.body).toEqual({})
    expect(gate.calls[1]?.body).toEqual({
      setupToken: "token-abc",
      approval: {
        id: "control-1",
        nonce: "N".repeat(43),
        assertion: FAKE_ASSERTION,
      },
    })
  })

  it("says the token may be spent when SimpleFIN did not answer", async () => {
    const gate = fakeGate(
      routes(() => json(502, { code: "claim_failed", message: "x" }))
    )
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    expect(await sealSimpleFin(signer().signed, () => "t")).toEqual({
      kind: "failed",
      reason:
        "SimpleFIN did not hand over the access URL; the token may be spent",
    })
  })
})

describe("checkGoogleApproval", () => {
  const ok = googlePrepared("gmail", "gmail", "write")

  it("accepts the ceremony the gate derives for the target, for any client id", async () => {
    expect(await checkGoogleApproval(ok, "gmail")).toBe(true)
    expect(
      await checkGoogleApproval(
        googlePrepared("drive", "drive", "read"),
        "drive"
      )
    ).toBe(true)
    expect(
      await checkGoogleApproval(
        googlePrepared("gmail-read", "gmail", "read", "other.example.invalid"),
        "gmail-read"
      )
    ).toBe(true)
  })

  it("rejects a ceremony for another target or connector", async () => {
    expect(await checkGoogleApproval(ok, "drive")).toBe(false)
    expect(await checkGoogleApproval(ok, "gmail-read")).toBe(false)
    const wrongClient = googlePrepared("gmail", "gmail", "read")
    expect(await checkGoogleApproval(wrongClient, "gmail")).toBe(false)
  })

  it("rejects an empty client id and a payload with an extra or missing key", async () => {
    expect(
      await checkGoogleApproval(
        googlePrepared("gmail", "gmail", "write", ""),
        "gmail"
      )
    ).toBe(false)
    expect(
      await checkGoogleApproval(
        { ...ok, payload: '{"action":"connector.oauth.start"}' },
        "gmail"
      )
    ).toBe(false)
    expect(
      await checkGoogleApproval({ ...ok, payload: "not json" }, "gmail")
    ).toBe(false)
    expect(await checkGoogleApproval({ ...ok, payload: "[]" }, "gmail")).toBe(
      false
    )
  })

  it("rejects a tampered hash, a tampered challenge and a wrong target", async () => {
    expect(
      await checkGoogleApproval({ ...ok, payloadHash: "0".repeat(64) }, "gmail")
    ).toBe(false)
    expect(
      await checkGoogleApproval({ ...ok, challenge: "C".repeat(43) }, "gmail")
    ).toBe(false)
    expect(
      await checkGoogleApproval(
        { ...ok, target: "connector_oauth:drive" },
        "gmail"
      )
    ).toBe(false)
  })

  it("rejects non-string field values", async () => {
    const payload = JSON.stringify({
      action: "connector.oauth.start",
      client: "write",
      clientId: 7,
      connector: "gmail",
    })
    expect(await checkGoogleApproval({ ...ok, payload }, "gmail")).toBe(false)
  })
})

describe("prepareGoogle", () => {
  it("returns the checked ceremony and whether the vault holds the client secret", async () => {
    const gate = fakeGate({
      "POST /admin/connectors/google/prepare": () =>
        json(200, {
          approval: googlePrepared("drive", "drive", "read"),
          clientSecretStored: false,
        }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    const result = await prepareGoogle("drive")
    expect(gate.calls[0]?.body).toEqual({ target: "drive" })
    expect(result.kind === "ready" && result.clientSecretStored).toBe(false)
    expect(result.kind === "ready" && result.prepared.target).toBe(
      "connector_oauth:drive"
    )
  })

  it("fails when the ceremony is for something else", async () => {
    const gate = fakeGate({
      "POST /admin/connectors/google/prepare": () =>
        json(200, {
          approval: googlePrepared("gmail", "gmail", "write"),
          clientSecretStored: true,
        }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    expect(await prepareGoogle("drive")).toEqual({
      kind: "failed",
      reason:
        "the gate prepared a different change than asked, so nothing was signed",
    })
  })

  it("names a gate with no client id for the target", async () => {
    const gate = fakeGate({
      "POST /admin/connectors/google/prepare": () =>
        json(503, { code: "unavailable", message: "x" }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    expect(await prepareGoogle("drive")).toEqual({
      kind: "failed",
      reason: "the gate cannot do this right now",
    })
  })
})

describe("startGoogle", () => {
  const prepared = googlePrepared("drive", "drive", "read")
  const started = () => json(200, { authorizationUrl: GOOGLE_URL, flow: FLOW })

  it("signs, starts with the target and navigates to Google", async () => {
    const gate = fakeGate({ "POST /admin/connectors/google/start": started })
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    const navigate = vi.fn()
    const { signed, shown } = signer()
    const result = await startGoogle(
      signed,
      "drive",
      prepared,
      undefined,
      navigate
    )
    expect(result.kind).toBe("sealed")
    expect(gate.calls[0]?.body).toEqual({
      target: "drive",
      approval: {
        id: "control-1",
        nonce: "N".repeat(43),
        assertion: FAKE_ASSERTION,
      },
    })
    expect(navigate).toHaveBeenCalledWith(GOOGLE_URL)
    expect(shown[0]?.fields).toEqual([
      ["Connector", "Drive"],
      ["Client", "read"],
      ["Google client ID", GOOGLE_CLIENT_ID],
    ])
  })

  it("sends the client secret read at send time when the vault has none", async () => {
    const gate = fakeGate({ "POST /admin/connectors/google/start": started })
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    await startGoogle(
      signer().signed,
      "drive",
      prepared,
      () => "gsecret",
      vi.fn()
    )
    const body: Call["body"] = gate.calls[0]?.body
    expect(body).toMatchObject({ target: "drive", clientSecret: "gsecret" })
  })

  it("does not follow an address that is not Google's", async () => {
    const gate = fakeGate({
      "POST /admin/connectors/google/start": () =>
        json(200, {
          authorizationUrl: "https://accounts.google.com.evil.example.invalid/",
          flow: FLOW,
        }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    passkey()
    const navigate = vi.fn()
    // The schema pins the host prefix, so an off-host address is an invalid answer, not a redirect.
    const result = await startGoogle(
      signer().signed,
      "drive",
      prepared,
      undefined,
      navigate
    )
    expect(result.kind).toBe("failed")
    expect(navigate).not.toHaveBeenCalled()
  })

  it("reports a cancelled passkey without starting", async () => {
    const gate = fakeGate({ "POST /admin/connectors/google/start": started })
    vi.stubGlobal("fetch", gate.fetch)
    stubPasskey(() => Promise.resolve(null))
    const result = await startGoogle(
      signer().signed,
      "drive",
      prepared,
      undefined,
      vi.fn()
    )
    expect(result).toEqual({ kind: "cancelled" })
    expect(gate.calls).toEqual([])
  })
})

describe("removeConnector and removeCopy", () => {
  it("posts to the connector's remove route", async () => {
    const gate = fakeGate({
      "POST /admin/connectors/gmail/remove": () =>
        json(200, { connector: "gmail" }),
    })
    vi.stubGlobal("fetch", gate.fetch)
    const outcome = await removeConnector("gmail")
    expect(outcome.kind).toBe("ok")
    expect(gate.calls[0]).toMatchObject({
      path: "/admin/connectors/gmail/remove",
      method: "POST",
    })
  })

  it("words the confirm per connector", () => {
    expect(removeCopy("gmail")).toEqual({
      title: "Remove Gmail?",
      text: "Eido deletes Gmail's tokens from the vault. Mail already indexed stays.",
      button: "Remove Gmail",
    })
    expect(removeCopy("drive").text).toBe(
      "Eido deletes Drive's tokens from the vault. Files already indexed stay."
    )
    expect(removeCopy("proton-mail")).toEqual({
      title: "Remove Proton Mail (Bridge)?",
      text: "Eido deletes the Bridge password from the vault. Mail already indexed stays.",
      button: "Remove Proton Mail (Bridge)",
    })
  })
})

describe("the Google landing", () => {
  it.each([
    ["?error=expired", { kind: "expired" }],
    [
      "?google=gmail&connected=healthy",
      { kind: "connected", target: "gmail", health: "healthy" },
    ],
    [
      "?google=drive&error=denied",
      { kind: "failed", target: "drive", reason: "denied" },
    ],
    [
      "?google=gmail-read&connected=unpinned",
      { kind: "connected", target: "gmail-read", health: "unpinned" },
    ],
  ])("reads %s", (search, landing) => {
    expect(readGoogleLanding(search)).toEqual(landing)
  })

  it.each([
    "",
    "?other=1",
    "?google=nope&connected=healthy",
    "?google=gmail",
    "?error=denied",
  ])("ignores %j", (search) => {
    expect(readGoogleLanding(search)).toBeNull()
  })

  it("says what happened in a line", () => {
    expect(landingMessage({ kind: "expired" })).toBe(
      "The Google sign-in expired or was already used. Start it again."
    )
    expect(
      landingMessage({ kind: "connected", target: "gmail", health: "healthy" })
    ).toBe("Gmail connected. Health: healthy.")
    expect(
      landingMessage({ kind: "connected", target: "drive", health: "unpinned" })
    ).toBe(
      "Drive signed in. It is not pinned yet, so it stays unused until it is."
    )
    expect(
      landingMessage({ kind: "failed", target: "drive", reason: "denied" })
    ).toBe("Drive was not connected. Google sign-in was denied.")
    expect(
      landingMessage({
        kind: "failed",
        target: "gmail-read",
        reason: "new_reason",
      })
    ).toBe("Gmail (read only) was not connected. The sign-in failed.")
  })
})
