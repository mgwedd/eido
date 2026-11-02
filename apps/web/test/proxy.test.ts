import {
  getRedirectUrl,
  getRewrittenUrl,
  isRewrite,
  unstable_doesMiddlewareMatch,
} from "next/experimental/testing/server"
import { NextRequest, NextResponse } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { config, proxy } from "@/proxy"

const sdk = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  middleware: vi.fn(),
}))

vi.mock("@/lib/auth0", () => ({
  auth0: {
    middleware: sdk.middleware,
    getSession: () => Promise.resolve(sdk.session),
  },
}))

const ORIGIN = "http://localhost:3000"
const request = (path: string) => new NextRequest(new URL(path, ORIGIN))
const owner = { email: "owner@example.test", email_verified: true }
const assistant = { email: "assistant@example.test", email_verified: true }

beforeEach(() => {
  vi.stubEnv("EIDO_OWNER_EMAIL", "owner@example.test")
  vi.stubEnv("EIDO_ASSISTANT_EMAILS", "assistant@example.test")
  sdk.session = null
  sdk.middleware.mockImplementation(() => {
    const response = NextResponse.next()
    response.headers.append("set-cookie", "__session=rolled; Path=/; HttpOnly")
    return Promise.resolve(response)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("proxy", () => {
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
})
