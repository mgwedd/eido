import { createHash, createPublicKey, verify } from "node:crypto"
import { canonicalize } from "./canonical"

// The WebAuthn pieces the gate needs, written on node:crypto so the gate adds no dependency:
// base64url decoding, clientDataJSON and authenticatorData parsing, the relying-party checks
// shared by enrolment and approval, and ES256 signature verification. Only ES256 (COSE -7,
// ECDSA P-256 with SHA-256) is accepted; it is what platform passkeys use.

export type WebAuthnConfig = {
  /** The relying-party id: the single hostname the web app is served on. */
  rpId: string
  /**
   * The only origin a ceremony may come from: `https://<rpId>` or `https://<rpId>:<port>`,
   * compared exactly, port included, with clientDataJSON.origin.
   */
  origin: string
}

export const ES256 = -7

const BASE64URL = /^[A-Za-z0-9_-]+$/

/** Decodes unpadded base64url; undefined for anything else. */
export function fromBase64url(text: string): Buffer | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined
  return Buffer.from(text, "base64url")
}

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest()
}

/**
 * The challenge the device signs to approve one intent: SHA-256 over the UTF-8 bytes of the
 * RFC 8785 canonical JSON array `[payloadHash, intentId, nonce]`, where payloadHash is lowercase
 * hex and nonce is the unpadded base64url string the gate issued. The layout was decided in #85 (was
 * #145); the shared vectors are packages/schemas/vectors/approval-challenge-vectors.json.
 */
export function approvalChallenge(
  payloadHash: string,
  intentId: string,
  nonce: string
): Buffer {
  return sha256(canonicalize([payloadHash, intentId, nonce]))
}

export type ClientData = {
  type: string
  challenge: string
  origin: string
  crossOrigin: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseClientData(bytes: Buffer): ClientData | undefined {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const { type, challenge, origin, crossOrigin } = value
  if (
    typeof type !== "string" ||
    typeof challenge !== "string" ||
    typeof origin !== "string"
  ) {
    return undefined
  }
  return { type, challenge, origin, crossOrigin: crossOrigin === true }
}

export type AuthenticatorData = {
  rpIdHash: Buffer
  userPresent: boolean
  userVerified: boolean
  signCount: number
  /** The credential id from the attested credential data; only on enrolment. */
  attestedCredentialId: Buffer | undefined
}

const USER_PRESENT = 0x01
const USER_VERIFIED = 0x04
const ATTESTED = 0x40
// rpIdHash (32) + flags (1) + signCount (4); attested data adds aaguid (16) + id length (2).
const HEADER = 37
const ATTESTED_HEADER = HEADER + 16 + 2

export function parseAuthenticatorData(
  bytes: Buffer
): AuthenticatorData | undefined {
  if (bytes.length < HEADER) return undefined
  const flags = bytes.readUInt8(32)
  let attestedCredentialId: Buffer | undefined
  if ((flags & ATTESTED) !== 0) {
    if (bytes.length < ATTESTED_HEADER) return undefined
    const length = bytes.readUInt16BE(HEADER + 16)
    if (bytes.length < ATTESTED_HEADER + length) return undefined
    attestedCredentialId = bytes.subarray(
      ATTESTED_HEADER,
      ATTESTED_HEADER + length
    )
  }
  return {
    rpIdHash: bytes.subarray(0, 32),
    userPresent: (flags & USER_PRESENT) !== 0,
    userVerified: (flags & USER_VERIFIED) !== 0,
    signCount: bytes.readUInt32BE(33),
    attestedCredentialId,
  }
}

export type CeremonyFailure =
  | "wrong_type"
  | "wrong_origin"
  | "wrong_rp_id"
  | "user_not_present"
  | "user_not_verified"

/** The relying-party checks every ceremony shares: type, origin, rpIdHash and the UP and UV flags. */
export function checkCeremony(
  config: WebAuthnConfig,
  type: "webauthn.get" | "webauthn.create",
  clientData: ClientData,
  authData: AuthenticatorData
): CeremonyFailure | undefined {
  if (clientData.type !== type) return "wrong_type"
  if (clientData.origin !== config.origin || clientData.crossOrigin) {
    return "wrong_origin"
  }
  if (!authData.rpIdHash.equals(sha256(config.rpId))) return "wrong_rp_id"
  if (!authData.userPresent) return "user_not_present"
  if (!authData.userVerified) return "user_not_verified"
  return undefined
}

/** True when `der` is an EC P-256 SubjectPublicKeyInfo. */
export function isP256PublicKey(der: Buffer): boolean {
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" })
    return key.asymmetricKeyDetails?.namedCurve === "prime256v1"
  } catch {
    return false
  }
}

/** Verifies an ES256 (DER-encoded ECDSA) assertion signature over authData || SHA-256(clientDataJSON). */
export function verifyAssertionSignature(
  publicKeyDer: Buffer,
  authenticatorData: Buffer,
  clientDataJSON: Buffer,
  signature: Buffer
): boolean {
  try {
    const key = createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    })
    return verify(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      { key, dsaEncoding: "der" },
      signature
    )
  } catch {
    return false
  }
}

const ORIGIN_ERROR =
  "the WebAuthn origin must be https://<rpId> or https://<rpId>:<port>"

/** 1 to 65535 with no leading zero; 443 is left out because browsers omit the default port. */
const PORT = /^[1-9][0-9]{0,4}$/

/**
 * The origin and RP id come from config. The origin must be `https://<rpId>`, or
 * `https://<rpId>:<port>` (ADR 0004 serves the app on its own port), written as the browser
 * serializes it into clientDataJSON so the exact comparison in `checkCeremony` can match.
 */
export function checkWebAuthnConfig(config: WebAuthnConfig): void {
  const base = `https://${config.rpId}`
  if (config.rpId === "" || !config.origin.startsWith(base)) {
    throw new Error(ORIGIN_ERROR)
  }
  const rest = config.origin.slice(base.length)
  if (rest === "") return
  const port = rest.startsWith(":") ? rest.slice(1) : ""
  if (!PORT.test(port) || Number(port) > 65535 || port === "443") {
    throw new Error(ORIGIN_ERROR)
  }
}
