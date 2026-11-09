import { generateKeyPairSync, sign } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  getWebSessionPublicKey,
  loadWebSessionPublicKey,
  resetWebSessionPublicKey,
  setWebSessionPublicKey,
  verifyWebSessionToken,
  WEB_SESSION_COOKIE,
} from "@/lib/auth/web-session"

describe("web-session", () => {
  const { publicKey: validPublic, privateKey: validPrivate } =
    generateKeyPairSync("ed25519")
  const jwk = validPublic.export({ format: "jwk" })
  const rawBase64Url = jwk.x!

  beforeEach(() => {
    resetWebSessionPublicKey()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    resetWebSessionPublicKey()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("exports the standard cookie name", () => {
    expect(WEB_SESSION_COOKIE).toBe("eido_web_session")
  })

  it("manually setting and getting the public key", () => {
    expect(getWebSessionPublicKey()).toBeNull()
    const key = setWebSessionPublicKey(rawBase64Url)
    expect(getWebSessionPublicKey()).toBe(key)
    resetWebSessionPublicKey()
    expect(getWebSessionPublicKey()).toBeNull()
  })

  it("loads public key from EIDO_WEB_SESSION_PUBLIC_KEY env var", async () => {
    vi.stubEnv("EIDO_WEB_SESSION_PUBLIC_KEY", rawBase64Url)
    const key = await loadWebSessionPublicKey()
    expect(key).not.toBeNull()
    expect(getWebSessionPublicKey()).toBe(key)
  })

  it("loads public key by fetching from gate phone port", async () => {
    vi.stubEnv("EIDO_GATE_PHONE_PORT", "4041")
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ publicKey: rawBase64Url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const key = await loadWebSessionPublicKey()
    expect(key).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4041/auth/jwt-key",
      {
        cache: "no-store",
      }
    )
  })

  it("returns null if fetch fails", async () => {
    vi.stubEnv("EIDO_GATE_PHONE_PORT", "4041")
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"))
    vi.stubGlobal("fetch", fetchMock)

    const key = await loadWebSessionPublicKey()
    expect(key).toBeNull()
  })

  it("verifies a valid token", () => {
    const b64u = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url")
    const header = b64u({ alg: "EdDSA", typ: "JWT" })
    const now = 1_700_000_000
    const payload = b64u({
      sub: "owner-1",
      role: "owner",
      iat: now - 10,
      exp: now + 3600,
    })
    const signingInput = Buffer.from(`${header}.${payload}`)
    const signature = sign(null, signingInput, validPrivate).toString(
      "base64url"
    )
    const token = `${header}.${payload}.${signature}`

    const result = verifyWebSessionToken(
      token,
      validPublic,
      () => new Date(now * 1000)
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.sub).toBe("owner-1")
      expect(result.payload.role).toBe("owner")
    }
  })

  it("rejects token without key", () => {
    const result = verifyWebSessionToken("any.token.here", null)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("no_key")
    }
  })

  it("rejects token with invalid segments", () => {
    const result = verifyWebSessionToken("malformed-token", validPublic)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("malformed")
    }
  })

  it("rejects token with invalid header algorithm", () => {
    const b64u = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url")
    const header = b64u({ alg: "HS256", typ: "JWT" })
    const payload = b64u({ sub: "owner-1", role: "owner", iat: 100, exp: 200 })
    const token = `${header}.${payload}.sig`
    const result = verifyWebSessionToken(token, validPublic)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("malformed")
    }
  })

  it("rejects token with missing role or expiration", () => {
    const b64u = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url")
    const header = b64u({ alg: "EdDSA", typ: "JWT" })
    const payload = b64u({ sub: "owner-1" })
    const token = `${header}.${payload}.sig`
    const result = verifyWebSessionToken(token, validPublic)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("malformed")
    }
  })

  it("rejects expired token", () => {
    const b64u = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url")
    const header = b64u({ alg: "EdDSA", typ: "JWT" })
    const now = 1_700_000_000
    const payload = b64u({
      sub: "owner-1",
      role: "owner",
      iat: now - 3600,
      exp: now - 60,
    })
    const signingInput = Buffer.from(`${header}.${payload}`)
    const signature = sign(null, signingInput, validPrivate).toString(
      "base64url"
    )
    const token = `${header}.${payload}.${signature}`

    const result = verifyWebSessionToken(
      token,
      validPublic,
      () => new Date(now * 1000)
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("expired")
    }
  })

  it("rejects tampered signature", () => {
    const b64u = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url")
    const header = b64u({ alg: "EdDSA", typ: "JWT" })
    const now = 1_700_000_000
    const payload = b64u({
      sub: "owner-1",
      role: "owner",
      iat: now,
      exp: now + 3600,
    })
    const signingInput = Buffer.from(`${header}.${payload}`)
    const signature = sign(null, signingInput, validPrivate).toString(
      "base64url"
    )
    const tamperedPayload = b64u({
      sub: "attacker",
      role: "owner",
      iat: now,
      exp: now + 3600,
    })
    const token = `${header}.${tamperedPayload}.${signature}`

    const result = verifyWebSessionToken(
      token,
      validPublic,
      () => new Date(now * 1000)
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature")
    }
  })
})
