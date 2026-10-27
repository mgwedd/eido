import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto"

const encoder = new TextEncoder()
const pushInfo = Buffer.from("WebPush: info\0", "utf8")
const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "utf8")
const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf8")

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    return undefined
  const decoded = Buffer.from(value, "base64url")
  return decoded.toString("base64url") === value ? decoded : undefined
}

function hkdfExtract(salt: Buffer, input: Buffer): Buffer {
  return createHmac("sha256", salt).update(input).digest()
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  return createHmac("sha256", prk)
    .update(info)
    .update(Buffer.from([1]))
    .digest()
    .subarray(0, length)
}

function publicKeyFromPoint(point: Buffer) {
  if (point.length !== 65 || point[0] !== 4)
    throw new Error("Invalid P-256 public key")
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  })
}

function privateKeyFromScalar(privateKey: string) {
  const scalar = decodeBase64Url(privateKey)
  if (!scalar || scalar.length !== 32)
    throw new Error("Invalid P-256 private key")
  const ecdh = createECDH("prime256v1")
  ecdh.setPrivateKey(scalar)
  const point = ecdh.getPublicKey(undefined, "uncompressed")
  return {
    scalar,
    point,
    key: createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        d: scalar.toString("base64url"),
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    }),
  }
}

export function validatePushKeys(p256dh: string, auth: string): boolean {
  const point = decodeBase64Url(p256dh)
  const secret = decodeBase64Url(auth)
  if (
    !point ||
    point.length !== 65 ||
    point[0] !== 4 ||
    !secret ||
    secret.length !== 16
  )
    return false
  try {
    publicKeyFromPoint(point)
    return true
  } catch {
    return false
  }
}

export function encryptPush(
  payload: Buffer,
  p256dh: string,
  auth: string
): Buffer {
  if (!Buffer.isBuffer(payload) || payload.length > 3993)
    throw new Error("Invalid push payload")
  if (!validatePushKeys(p256dh, auth))
    throw new Error("Invalid push subscription keys")
  const uaPublic = decodeBase64Url(p256dh)
  const authSecret = decodeBase64Url(auth)
  if (!uaPublic || !authSecret)
    throw new Error("Invalid push subscription keys")

  const sender = createECDH("prime256v1")
  sender.generateKeys()
  const asPublic = sender.getPublicKey(undefined, "uncompressed")
  const ecdhSecret = sender.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([pushInfo, uaPublic, asPublic])
  const ikm = hkdfExpand(hkdfExtract(authSecret, ecdhSecret), keyInfo, 32)
  const salt = randomBytes(16)
  const prk = hkdfExtract(salt, ikm)
  const cek = hkdfExpand(prk, cekInfo, 16)
  const nonce = hkdfExpand(prk, nonceInfo, 12)
  const cipher = createCipheriv("aes-128-gcm", cek, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, ciphertext])
}

export function vapidPublicKey(privateKey: string): string {
  return privateKeyFromScalar(privateKey).point.toString("base64url")
}

export function vapidAuthorization(
  endpoint: string,
  privateKey: string,
  subject: string,
  nowMs = Date.now()
): string {
  let audience: string
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "https:") throw new Error("Invalid push endpoint")
    audience = url.origin
  } catch {
    throw new Error("Invalid push endpoint")
  }
  if (!Number.isFinite(nowMs) || !Number.isInteger(nowMs))
    throw new Error("Invalid VAPID time")
  if (!/^(mailto:.+|https:\/\/.+)$/.test(subject))
    throw new Error("Invalid VAPID subject")
  const key = privateKeyFromScalar(privateKey)
  const header = Buffer.from(
    JSON.stringify({ typ: "JWT", alg: "ES256" })
  ).toString("base64url")
  const claims = Buffer.from(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
      sub: subject,
    })
  ).toString("base64url")
  const signingInput = `${header}.${claims}`
  const signature = sign("sha256", encoder.encode(signingInput), {
    key: key.key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
  return `vapid t=${signingInput}.${signature}, k=${key.point.toString("base64url")}`
}
