import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  approvalChallenge,
  checkWebAuthnConfig,
  fromBase64url,
  parseAuthenticatorData,
  parseClientData,
} from "./webauthn"

type ChallengeVector = {
  id: string
  payloadHash: string
  intentId: string
  nonce: string
  message: string
  challenge: string
  challengeHex: string
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../schemas/vectors/approval-challenge-vectors.json",
      import.meta.url
    ),
    "utf8"
  )
) as { vectors: ChallengeVector[] }

describe("shared approval challenge vectors", () => {
  it.each(vectors.vectors)("reproduces $id", (vector) => {
    const challenge = approvalChallenge(
      vector.payloadHash,
      vector.intentId,
      vector.nonce
    )
    expect(challenge.toString("hex")).toBe(vector.challengeHex)
    expect(challenge.toString("base64url")).toBe(vector.challenge)
  })
})

describe("approvalChallenge", () => {
  it("binds each input: changing any one changes the challenge", () => {
    const hash = "a".repeat(64)
    const nonce = "n".repeat(43)
    const base = approvalChallenge(hash, "intent-1", nonce).toString("hex")
    expect(
      approvalChallenge("b".repeat(64), "intent-1", nonce).toString("hex")
    ).not.toBe(base)
    expect(approvalChallenge(hash, "intent-2", nonce).toString("hex")).not.toBe(
      base
    )
    expect(
      approvalChallenge(hash, "intent-1", "m".repeat(43)).toString("hex")
    ).not.toBe(base)
  })
})

describe("fromBase64url", () => {
  it("decodes unpadded base64url", () => {
    expect(fromBase64url("-_8")?.toString("hex")).toBe("fbff")
  })

  it.each([
    ["padding", "AA=="],
    ["standard base64 characters", "a+b/"],
    ["an empty string", ""],
    ["an impossible length", "AAAAA"],
  ])("rejects %s", (_name, text) => {
    expect(fromBase64url(text)).toBeUndefined()
  })
})

describe("parseClientData", () => {
  const bytes = (text: string) => Buffer.from(text, "utf8")

  it("reads type, challenge, origin and crossOrigin", () => {
    expect(
      parseClientData(
        bytes(
          '{"type":"webauthn.get","challenge":"c","origin":"https://x","crossOrigin":true}'
        )
      )
    ).toEqual({
      type: "webauthn.get",
      challenge: "c",
      origin: "https://x",
      crossOrigin: true,
    })
  })

  it("treats a missing crossOrigin as false", () => {
    expect(
      parseClientData(bytes('{"type":"t","challenge":"c","origin":"o"}'))
        ?.crossOrigin
    ).toBe(false)
  })

  it.each([
    ["text that is not JSON", "{"],
    ["a JSON array", "[]"],
    ["a missing challenge", '{"type":"t","origin":"o"}'],
    ["a numeric origin", '{"type":"t","challenge":"c","origin":1}'],
  ])("rejects %s", (_name, text) => {
    expect(parseClientData(bytes(text))).toBeUndefined()
  })
})

describe("parseAuthenticatorData", () => {
  function header(flags: number, signCount: number): Buffer {
    const data = Buffer.alloc(37, 0x11)
    data.writeUInt8(flags, 32)
    data.writeUInt32BE(signCount, 33)
    return data
  }

  it("reads the flags and the big-endian sign count", () => {
    const parsed = parseAuthenticatorData(header(0x05, 0x01020304))
    expect(parsed).toMatchObject({
      userPresent: true,
      userVerified: true,
      signCount: 16909060,
      attestedCredentialId: undefined,
    })
    expect(parsed?.rpIdHash.toString("hex")).toBe("11".repeat(32))
  })

  it("reads the attested credential id when the AT flag is set", () => {
    const length = Buffer.from([0x00, 0x03])
    const data = Buffer.concat([
      header(0x45, 0),
      Buffer.alloc(16),
      length,
      Buffer.from([0xaa, 0xbb, 0xcc]),
    ])
    expect(
      parseAuthenticatorData(data)?.attestedCredentialId?.toString("hex")
    ).toBe("aabbcc")
  })

  it.each([
    ["shorter than the fixed header", Buffer.alloc(36)],
    [
      "attested but cut before the id length",
      Buffer.concat([header(0x41, 0), Buffer.alloc(10)]),
    ],
    [
      "attested with an id longer than the data",
      Buffer.concat([
        header(0x41, 0),
        Buffer.alloc(16),
        Buffer.from([0x00, 0x09]),
        Buffer.alloc(3),
      ]),
    ],
  ])("rejects data %s", (_name, data) => {
    expect(parseAuthenticatorData(data)).toBeUndefined()
  })
})

describe("checkWebAuthnConfig", () => {
  const rpId = "node.example.ts.net"

  it.each([
    ["https://<rpId>", `https://${rpId}`],
    ["https://<rpId>:8443", `https://${rpId}:8443`],
    ["the lowest port", `https://${rpId}:1`],
    ["the highest port", `https://${rpId}:65535`],
  ])("accepts %s", (_name, origin) => {
    expect(() => checkWebAuthnConfig({ rpId, origin })).not.toThrow()
  })

  it.each([
    ["an http origin", rpId, `http://${rpId}`],
    ["an http origin with a port", rpId, `http://${rpId}:8443`],
    ["an origin on another host", rpId, "https://other.example.ts.net:8443"],
    [
      "a host that only starts with the RP id",
      rpId,
      `https://${rpId}.evil:8443`,
    ],
    ["a path", rpId, `https://${rpId}:8443/app`],
    ["a query", rpId, `https://${rpId}:8443?x=1`],
    ["a query without a port", rpId, `https://${rpId}?x=1`],
    ["userinfo", rpId, `https://user@${rpId}:8443`],
    ["a trailing slash", rpId, `https://${rpId}/`],
    ["a trailing slash after the port", rpId, `https://${rpId}:8443/`],
    ["an empty port", rpId, `https://${rpId}:`],
    ["a non-numeric port", rpId, `https://${rpId}:https`],
    ["port 0", rpId, `https://${rpId}:0`],
    ["a port above 65535", rpId, `https://${rpId}:65536`],
    ["a port with a leading zero", rpId, `https://${rpId}:08443`],
    ["the default port, which browsers omit", rpId, `https://${rpId}:443`],
    ["an empty RP id", "", "https://"],
  ])("refuses %s", (_name, configRpId, origin) => {
    expect(() => checkWebAuthnConfig({ rpId: configRpId, origin })).toThrow(
      "the WebAuthn origin must be https://<rpId> or https://<rpId>:<port>"
    )
  })
})
