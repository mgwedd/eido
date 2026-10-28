import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  encryptPush,
  generateVapidPrivateKey,
  validatePushKeys,
  vapidAuthorization,
  vapidPublicKey,
} from "./push-crypto.js"

function extract(salt: Buffer, input: Buffer): Buffer {
  return createHmac("sha256", salt).update(input).digest()
}

function expand(prk: Buffer, info: Buffer, size: number): Buffer {
  return createHmac("sha256", prk)
    .update(info)
    .update(Buffer.from([1]))
    .digest()
    .subarray(0, size)
}

function decodeJwt(authorization: string): {
  header: unknown
  claims: unknown
  signature: Buffer
  input: Buffer
} {
  const token = authorization.slice(
    "vapid t=".length,
    authorization.indexOf(", k=")
  )
  const [headerPart, claimPart, signaturePart] = token.split(".")
  if (!headerPart || !claimPart || !signaturePart)
    throw new Error("Invalid JWT")
  const header: unknown = JSON.parse(
    Buffer.from(headerPart, "base64url").toString("utf8")
  )
  const claims: unknown = JSON.parse(
    Buffer.from(claimPart, "base64url").toString("utf8")
  )
  return {
    header,
    claims,
    signature: Buffer.from(signaturePart, "base64url"),
    input: Buffer.from(`${headerPart}.${claimPart}`),
  }
}

describe("push crypto", () => {
  it("encrypts a single RFC 8291 aes128gcm record that decrypts independently", () => {
    const receiver = createECDH("prime256v1")
    receiver.generateKeys()
    const p256dh = receiver
      .getPublicKey(undefined, "uncompressed")
      .toString("base64url")
    const auth = randomBytes(16).toString("base64url")
    const payload = Buffer.from('{"title":"Reminder"}')
    const body = encryptPush(payload, p256dh, auth)

    const salt = body.subarray(0, 16)
    expect(body.readUInt32BE(16)).toBe(4096)
    const keyLength = body.readUInt8(20)
    expect(keyLength).toBe(65)
    const senderPublic = body.subarray(21, 21 + keyLength)
    // ECDH's receiver-side secret is independently derived from the serialized sender public key.
    const ecdhSecret = receiver.computeSecret(senderPublic)
    const keyInfo = Buffer.concat([
      Buffer.from("WebPush: info\0"),
      receiver.getPublicKey(undefined, "uncompressed"),
      senderPublic,
    ])
    const ikm = expand(
      extract(Buffer.from(auth, "base64url"), ecdhSecret),
      keyInfo,
      32
    )
    const prk = extract(salt, ikm)
    const cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16)
    const nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12)
    const record = body.subarray(21 + keyLength)
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce)
    decipher.setAuthTag(record.subarray(-16))
    const plaintext = Buffer.concat([
      decipher.update(record.subarray(0, -16)),
      decipher.final(),
    ])
    expect(plaintext).toEqual(Buffer.concat([payload, Buffer.from([2])]))
  })

  it("validates subscription keys and rejects malformed payload/key inputs", () => {
    const receiver = createECDH("prime256v1")
    receiver.generateKeys()
    const p256dh = receiver
      .getPublicKey(undefined, "uncompressed")
      .toString("base64url")
    const auth = randomBytes(16).toString("base64url")
    expect(validatePushKeys(p256dh, auth)).toBe(true)
    expect(validatePushKeys("not-base64!", auth)).toBe(false)
    expect(validatePushKeys(p256dh, "AA")).toBe(false)
    expect(() => encryptPush(Buffer.from("x"), "bad", auth)).toThrow()
    expect(() => encryptPush(Buffer.alloc(3994), p256dh, auth)).toThrow()
  })

  it("pads a generated VAPID key whose scalar lost its leading zero bytes", () => {
    // Node's ECDH getPrivateKey() drops leading zero bytes; this is that case (1 in 256 keys).
    const stripped = Buffer.alloc(30, 7)
    const key = generateVapidPrivateKey({
      generateKeys: () => Buffer.alloc(0),
      getPrivateKey: () => stripped,
    })
    expect(Buffer.from(key, "base64url")).toEqual(
      Buffer.concat([Buffer.alloc(2), stripped])
    )
    expect(vapidPublicKey(key)).toMatch(/^[A-Za-z0-9_-]{87}$/)
  })

  it("creates a VAPID token with verifiable ES256 signature and claims", () => {
    const privateKey = generateVapidPrivateKey()
    const authorization = vapidAuthorization(
      "https://push.example.invalid/path",
      privateKey,
      "mailto:ops@example.invalid",
      1_700_000_000_000
    )
    const publicKey = vapidPublicKey(privateKey)
    expect(authorization.endsWith(`, k=${publicKey}`)).toBe(true)
    const token = decodeJwt(authorization)
    expect(token.header).toEqual({ typ: "JWT", alg: "ES256" })
    expect(token.claims).toEqual({
      aud: "https://push.example.invalid",
      exp: 1_700_043_200,
      sub: "mailto:ops@example.invalid",
    })
    const point = Buffer.from(publicKey, "base64url")
    const verifier = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    })
    expect(
      verify(
        "sha256",
        token.input,
        { key: verifier, dsaEncoding: "ieee-p1363" },
        token.signature
      )
    ).toBe(true)
  })

  it("rejects malformed VAPID inputs", () => {
    expect(() =>
      vapidAuthorization(
        "http://push.example.invalid",
        "bad",
        "mailto:ops@example.invalid"
      )
    ).toThrow()
    expect(() =>
      vapidAuthorization(
        "https://push.example.invalid",
        "bad",
        "mailto:ops@example.invalid"
      )
    ).toThrow()
    expect(() =>
      vapidAuthorization(
        "https://push.example.invalid",
        "A".repeat(43),
        "invalid subject"
      )
    ).toThrow()
  })
})
