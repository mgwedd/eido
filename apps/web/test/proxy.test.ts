import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import {
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server"
import { NextRequest, NextResponse } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetWebSessionPublicKey,
  setWebSessionPublicKey,
} from "@/lib/auth/web-session"
import { config, proxy } from "@/proxy"

const sdk = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  middleware: vi.fn(),
}))

vi.mock("@/lib/auth0", () => ({
  isAuth0Enabled: () => Boolean(process.env["AUTH0_DOMAIN"]),
  auth0: {
    middleware: sdk.middleware,
    getSession: () => Promise.resolve(sdk.session),
  },
}))

const ORIGIN = "http://localhost:3000"
const request = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, ORIGIN), {
    headers: cookie ? { cookie: `eido_web_session=${cookie}` } : undefined,
  })
const owner = { email: "owner@example.test", email_verified: true }
const assistant = { email: "assistant@example.test", email_verified: true }

function mintWebSession(
  payload: { sub: string; role: string; iat: number; exp: number },
  privateKey: KeyObject
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" })
  ).toString("base64url")
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const data = Buffer.from(`${header}.${claims}`, "utf8")
  const sig = Buffer.from(sign(null, data, privateKey)).toString("base64url")
  return `${header}.${claims}.${sig}`
}

describe("proxy in passkey-only mode (AUTH0_DOMAIN unset)", () => {
  let keys: { privateKey: KeyObject; publicKeyRaw: string }
  const now = new Date("2026-11-07T12:00:00Z")
  const nowSec = Math.floor(now.getTime() / 1000)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const jwk = publicKey.export({ format: "jwk" })
    keys = {
      privateKey,
      publicKeyRaw: jwk.x as string,
    }
    setWebSessionPublicKey(keys.publicKeyRaw)
  })

  afterEach(() => {
    vi.useRealTimers()
    resetWebSessionPublicKey()
    vi.unstubAllEnvs()
  })

  it("leaves /unlock, /enroll, /recover, and /healthz open without redirect when signed out", async () => {
    for (const path of ["/unlock", "/enroll", "/recover", "/healthz"]) {
      const response = await proxy(request(path))
      expect(response.headers.get("x-middleware-next")).toBe("1")
    }
  })

  it("redirects signed-out requests on protected routes to /unlock with next parameter", async () => {
    const queueResponse = await proxy(request("/queue?id=1"))
    expect(queueResponse.status).toBe(307)
    const target = new URL(getRedirectUrl(queueResponse) ?? "")
    expect(target.pathname).toBe("/unlock")
    expect(target.searchParams.get("next")).toBe("/queue?id=1")

    const rootResponse = await proxy(request("/"))
    expect(rootResponse.status).toBe(307)
    const rootTarget = new URL(getRedirectUrl(rootResponse) ?? "")
    expect(rootTarget.pathname).toBe("/unlock")
    expect(rootTarget.searchParams.get("next")).toBe("/")
  })

  it("lets the owner through with a valid eido_web_session cookie", async () => {
    const token = mintWebSession(
      {
        sub: "owner_passkey_1",
        role: "owner",
        iat: nowSec,
        exp: nowSec + 3600,
      },
      keys.privateKey
    )
    for (const path of ["/", "/queue", "/admin", "/settings", "/documents"]) {
      const response = await proxy(request(path, token))
      expect(response.headers.get("x-middleware-next")).toBe("1")
    }
  })

  it("redirects to /unlock when the cookie is expired", async () => {
    const expiredToken = mintWebSession(
      {
        sub: "owner_passkey_1",
        role: "owner",
        iat: nowSec - 7200,
        exp: nowSec - 60,
      },
      keys.privateKey
    )
    const response = await proxy(request("/queue", expiredToken))
    expect(response.status).toBe(307)
    const target = new URL(getRedirectUrl(response) ?? "")
    expect(target.pathname).toBe("/unlock")
    expect(target.searchParams.get("next")).toBe("/queue")
  })

  it("redirects to /unlock when the cookie signature is tampered", async () => {
    const validToken = mintWebSession(
      {
        sub: "owner_passkey_1",
        role: "owner",
        iat: nowSec,
        exp: nowSec + 3600,
      },
      keys.privateKey
    )
    const parts = validToken.split(".")
    const tampered = `${parts[0]}.${parts[1]}.badsignature`
    const response = await proxy(request("/queue", tampered))
    expect(response.status).toBe(307)
    const target = new URL(getRedirectUrl(response) ?? "")
    expect(target.pathname).toBe("/unlock")
  })

  it("redirects to /unlock when the cookie payload is malformed", async () => {
    const response = await proxy(request("/queue", "not-a-valid-jwt"))
    expect(response.status).toBe(307)
    const target = new URL(getRedirectUrl(response) ?? "")
    expect(target.pathname).toBe("/unlock")
  })
})

describe("proxy with Auth0 (AUTH0_DOMAIN set)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH0_DOMAIN", "tenant.example.test")
    vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
    vi.stubEnv("EIDO_ASSISTANT_EMAILS", "assistant@example.test")
    sdk.session = null
    sdk.middleware.mockImplementation(() => {
      const response = NextResponse.next()
      response.headers.append(
        "set-cookie",
        "__session=rolled; Path=/; HttpOnly"
      )
      return Promise.resolve(response)
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("hands /auth/* to the SDK untouched", async () => {
    const handled = new NextResponse(null, { status: 302 })
    sdk.middleware.mockResolvedValueOnce(handled)
    expect(await proxy(request("/auth/login"))).toBe(handled)
    sdk.middleware.mockResolvedValueOnce(handled)
    expect(await proxy(request("/auth"))).toBe(handled)
  })

  it("sends a signed-out request to Universal Login, returning to the page", async () => {
    const response = await proxy(request("/queue?id=1"))
    expect(response.status).toBe(307)
    const target = new URL(getRedirectUrl(response) ?? "")
    expect(target.pathname).toBe("/auth/login")
    expect(target.searchParams.get("returnTo")).toBe("/queue?id=1")
  })

  it("lets the owner through with the SDK's cookies", async () => {
    sdk.session = { user: owner }
    const response = await proxy(request("/queue"))
    expect(response.headers.get("x-middleware-next")).toBe("1")
    expect(response.headers.getSetCookie()).toEqual([
      "__session=rolled; Path=/; HttpOnly",
    ])
  })

  it.each([
    ["an assistant on an owner-only page", assistant],
    ["an address on neither list", { ...owner, email: "x@example.test" }],
    ["an unverified owner address", { ...owner, email_verified: false }],
  ])("rewrites %s to the 403 page", async (_name, user) => {
    sdk.session = { user }
    const response = await proxy(request("/"))
    expect(isRewrite(response)).toBe(true)
    expect(getRewrittenUrl(response)).toBe(`${ORIGIN}/forbidden`)
    expect(response.headers.getSetCookie()).toEqual([
      "__session=rolled; Path=/; HttpOnly",
    ])
  })

  it("lets a signed-in user without a role open the 403 page itself", async () => {
    sdk.session = { user: { ...owner, email: "x@example.test" } }
    const response = await proxy(request("/forbidden"))
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("fails closed when the allow-list is broken", async () => {
    vi.stubEnv("EIDO_OWNER_EMAIL", "")
    sdk.session = { user: owner }
    const response = await proxy(request("/"))
    expect(response.status).toBe(503)
    expect(await response.text()).toBe(
      "Eido's sign-in allow-list is misconfigured."
    )
  })

  it("sends a signed-out visit to /enroll to login and back, keeping next", async () => {
    const response = await proxy(request("/enroll?next=%2Fqueue"))
    const login = getRedirectUrl(response)
    expect(login).toBe(
      `${ORIGIN}/auth/login?returnTo=${encodeURIComponent("/enroll?next=%2Fqueue")}`
    )
  })

  it("lets the owner open /enroll and refuses the assistant", async () => {
    sdk.session = { user: owner }
    expect(isRewrite(await proxy(request("/enroll")))).toBe(false)
    sdk.session = { user: assistant }
    expect(isRewrite(await proxy(request("/enroll")))).toBe(true)
  })

  it("rethrows anything that is not an allow-list error", async () => {
    sdk.session = {
      user: {
        get email_verified(): boolean {
          throw new TypeError("boom")
        },
      },
    }
    await expect(proxy(request("/"))).rejects.toThrow("boom")
  })
})

describe("proxy matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url })

  it.each([
    "/",
    "/queue",
    "/unlock?next=/queue",
    "/enroll?next=%2Fqueue",
    "/forbidden",
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
  ])("runs on %s", (url) => {
    expect(matches(url)).toBe(true)
  })

  it.each([
    "/healthz",
    "/_next/static/chunk.js",
    "/_next/image?url=x",
    "/favicon.ico",
    "/manifest.webmanifest",
    "/icon/192",
    "/apple-icon",
    "/sw.js",
    "/sw-routing.js",
  ])("leaves %s public", (url) => {
    expect(matches(url)).toBe(false)
  })

  it.each([
    "/healthzxyz",
    "/healthz-admin",
    "/sw.js.map",
    "/sw-routing.json",
    "/favicon.icon",
    "/manifest.webmanifest.bak",
    "/apple-iconx",
    "/_next/staticx/a",
    "/_next/imagex",
  ])("does not leave the lookalike %s public", (url) => {
    expect(matches(url)).toBe(true)
  })
})
