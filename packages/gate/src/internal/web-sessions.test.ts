import { sign } from "node:crypto"
import { describe, expect, it } from "vitest"
import { openControlDb } from "./control-db"
import {
  clearGateSessionCookie,
  clearWebSessionCookie,
  generateWebSessionKeyPair,
  getOrCreateWebSessionKeys,
  getWebSessionPublicKey,
  publicKeyFromRaw,
  signWebSession,
  verifyWebSession,
  webSessionCookie,
  WEB_SESSION_COOKIE,
  WEB_SESSION_COOKIE_PATH,
  WEB_SESSION_TTL_MS,
  type WebSessionPayload,
} from "./web-sessions"

describe("web-sessions", () => {
  const now = new Date("2026-11-07T12:00:00Z")
  const clock = () => now
  const nowSec = Math.floor(now.getTime() / 1000)

  it("generates a valid keypair and loads public key from raw base64url string", () => {
    const keys = generateWebSessionKeyPair()
    expect(typeof keys.publicKeyRaw).toBe("string")
    expect(keys.publicKeyRaw.length).toBeGreaterThan(0)

    const reloaded = publicKeyFromRaw(keys.publicKeyRaw)
    const payload: WebSessionPayload = {
      sub: "cred_123",
      role: "owner",
      iat: nowSec,
      exp: nowSec + 3600,
    }
    const token = signWebSession(payload, keys.privateKey)
    const verified = verifyWebSession(token, reloaded, clock)
    expect(verified).toEqual({ ok: true, payload })
  })

  it("persists keypair in SQLite and reloads the same keys across calls", () => {
    const db = openControlDb(":memory:")
    const keys1 = getOrCreateWebSessionKeys(db)
    const raw1 = getWebSessionPublicKey(db)
    expect(raw1).toBe(keys1.publicKeyRaw)

    const keys2 = getOrCreateWebSessionKeys(db)
    expect(keys2.publicKeyRaw).toBe(keys1.publicKeyRaw)

    const payload: WebSessionPayload = {
      sub: "cred_persist",
      role: "owner",
      iat: nowSec,
      exp: nowSec + 3600,
    }
    const token = signWebSession(payload, keys1.privateKey)
    const verified = verifyWebSession(token, keys2.publicKey, clock)
    expect(verified).toEqual({ ok: true, payload })
    db.close()
  })

  it("refuses tampered payload, tampered signature, or foreign private key", () => {
    const keys1 = generateWebSessionKeyPair()
    const keys2 = generateWebSessionKeyPair()
    const payload: WebSessionPayload = {
      sub: "cred_123",
      role: "owner",
      iat: nowSec,
      exp: nowSec + 3600,
    }
    const token = signWebSession(payload, keys1.privateKey)

    // Foreign key
    const foreign = verifyWebSession(token, keys2.publicKey, clock)
    expect(foreign).toEqual({ ok: false, reason: "bad_signature" })

    // Tampered payload
    const parts = token.split(".")
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, role: "attacker" })
    ).toString("base64url")
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`
    expect(verifyWebSession(tamperedToken, keys1.publicKey, clock)).toEqual({
      ok: false,
      reason: "bad_signature",
    })

    // Tampered signature
    const badSig = "A".repeat(86)
    expect(
      verifyWebSession(
        `${parts[0]}.${parts[1]}.${badSig}`,
        keys1.publicKey,
        clock
      )
    ).toEqual({ ok: false, reason: "bad_signature" })

    // Signature not 64 bytes
    const shortSig = Buffer.from("short").toString("base64url")
    expect(
      verifyWebSession(
        `${parts[0]}.${parts[1]}.${shortSig}`,
        keys1.publicKey,
        clock
      )
    ).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("refuses malformed tokens", () => {
    const keys = generateWebSessionKeyPair()

    // Not 3 parts
    expect(verifyWebSession("invalid", keys.publicKey, clock)).toEqual({
      ok: false,
      reason: "malformed",
    })
    expect(verifyWebSession("a.b", keys.publicKey, clock)).toEqual({
      ok: false,
      reason: "malformed",
    })
    expect(verifyWebSession("a.b.c.d", keys.publicKey, clock)).toEqual({
      ok: false,
      reason: "malformed",
    })

    // Bad header (non-JSON)
    const validPayload = Buffer.from(
      JSON.stringify({
        sub: "x",
        role: "owner",
        iat: nowSec,
        exp: nowSec + 3600,
      })
    ).toString("base64url")
    const sig = Buffer.alloc(64).toString("base64url")
    expect(
      verifyWebSession(`not-json.${validPayload}.${sig}`, keys.publicKey, clock)
    ).toEqual({ ok: false, reason: "malformed" })

    // Bad header (wrong alg)
    const badAlgHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" })
    ).toString("base64url")
    expect(
      verifyWebSession(
        `${badAlgHeader}.${validPayload}.${sig}`,
        keys.publicKey,
        clock
      )
    ).toEqual({ ok: false, reason: "malformed" })

    // Bad claims shape
    const goodHeader = Buffer.from(
      JSON.stringify({ alg: "EdDSA", typ: "JWT" })
    ).toString("base64url")
    const badClaims = [
      "not-json",
      Buffer.from(JSON.stringify(null)).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          role: "owner",
          iat: nowSec,
          exp: nowSec + 3600,
        })
      ).toString("base64url"), // missing sub
      Buffer.from(
        JSON.stringify({
          sub: "x",
          role: "assistant",
          iat: nowSec,
          exp: nowSec + 3600,
        })
      ).toString("base64url"), // role not owner
      Buffer.from(
        JSON.stringify({
          sub: "x",
          role: "owner",
          iat: "now",
          exp: nowSec + 3600,
        })
      ).toString("base64url"), // non-number iat
    ]

    for (const claim of badClaims) {
      const input = `${goodHeader}.${claim}`
      // Using an actual signed input over that claim:
      const manualSig = Buffer.from(
        sign(null, Buffer.from(input, "utf8"), keys.privateKey)
      ).toString("base64url")
      expect(
        verifyWebSession(`${input}.${manualSig}`, keys.publicKey, clock)
      ).toEqual({ ok: false, reason: "malformed" })
    }
  })

  it("refuses expired or not-yet-valid tokens with fake clock", () => {
    const keys = generateWebSessionKeyPair()
    const payload: WebSessionPayload = {
      sub: "cred_123",
      role: "owner",
      iat: nowSec,
      exp: nowSec + 3600, // valid for 1 hour
    }
    const token = signWebSession(payload, keys.privateKey)

    // Exact expiry time
    const atExpiry = () => new Date((nowSec + 3600) * 1000)
    expect(verifyWebSession(token, keys.publicKey, atExpiry)).toEqual({
      ok: false,
      reason: "expired",
    })

    // Past expiry
    const pastExpiry = () => new Date((nowSec + 3601) * 1000)
    expect(verifyWebSession(token, keys.publicKey, pastExpiry)).toEqual({
      ok: false,
      reason: "expired",
    })

    // Not yet valid (more than 60s in the future)
    const wayBefore = () => new Date((nowSec - 120) * 1000)
    expect(verifyWebSession(token, keys.publicKey, wayBefore)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    })

    // Within 60s clock skew is allowed
    const slightClockSkew = () => new Date((nowSec - 30) * 1000)
    expect(verifyWebSession(token, keys.publicKey, slightClockSkew)).toEqual({
      ok: true,
      payload,
    })
  })

  it("formats cookies correctly", () => {
    expect(WEB_SESSION_COOKIE).toBe("eido_web_session")
    expect(WEB_SESSION_COOKIE_PATH).toBe("/")

    const cookie = webSessionCookie("sample-token")
    expect(cookie).toBe(
      `${WEB_SESSION_COOKIE}=sample-token; Max-Age=${String(WEB_SESSION_TTL_MS / 1000)}; Path=${WEB_SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`
    )

    const clearWeb = clearWebSessionCookie()
    expect(clearWeb).toBe(
      `${WEB_SESSION_COOKIE}=; Max-Age=0; Path=${WEB_SESSION_COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`
    )

    const clearGate = clearGateSessionCookie()
    expect(clearGate).toBe(
      "eido_gate_session=; Max-Age=0; Path=/api/gate; HttpOnly; Secure; SameSite=Strict"
    )
  })
})
