import { readFileSync } from "node:fs"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { describe, expect, test } from "vitest"

type Kind = "static" | "navigation" | "api-read" | "network-only"
type Request = {
  method: string
  url: string
  origin: string
  mode?: string
  hasAuthorization?: boolean
}
type Response = { status: number; type: string; cacheControl?: string | null }

const source = readFileSync(
  path.join(__dirname, "..", "public", "sw-routing.js"),
  "utf8"
)
const exported: unknown = runInNewContext(
  `${source}\n({ classifyRequest, isCacheableResponse })`,
  { URL }
)
const { classifyRequest, isCacheableResponse } = exported as {
  classifyRequest: (request: Request) => Kind
  isCacheableResponse: (response: Response) => boolean
}

const ORIGIN = "https://eido.example.ts.net"
function classify(pathname: string, init: Partial<Request> = {}): Kind {
  return classifyRequest({
    method: "GET",
    url: `${ORIGIN}${pathname}`,
    origin: ORIGIN,
    ...init,
  })
}

describe("classifyRequest", () => {
  test("build assets and icons are static", () => {
    expect(classify("/_next/static/chunks/app.js")).toBe("static")
    expect(classify("/manifest.webmanifest")).toBe("static")
    expect(classify("/icon/192")).toBe("static")
    expect(classify("/apple-icon")).toBe("static")
  })

  test("page loads are navigations", () => {
    expect(classify("/", { mode: "navigate" })).toBe("navigation")
    expect(classify("/queue", { mode: "navigate" })).toBe("navigation")
  })

  test("read API GETs are cacheable", () => {
    expect(classify("/api/intents")).toBe("api-read")
  })

  test("nonce, approval and signing requests never use the cache", () => {
    for (const p of [
      "/api/nonce",
      "/api/approvals/123",
      "/api/intents/123/approve",
      "/api/sign",
      "/api/passkeys/options",
      "/api/webauthn/challenge",
    ]) {
      expect(classify(p), p).toBe("network-only")
    }
    expect(classify("/unlock", { mode: "navigate" })).toBe("network-only")
  })

  test("writes, cross-origin, probes and the worker itself bypass the cache", () => {
    expect(classify("/api/intents", { method: "POST" })).toBe("network-only")
    expect(
      classify("/api/intents", { url: "https://other.example/api/intents" })
    ).toBe("network-only")
    expect(classify("/healthz")).toBe("network-only")
    expect(classify("/sw.js")).toBe("network-only")
    expect(classify("/api/intents", { hasAuthorization: true })).toBe(
      "network-only"
    )
  })

  test("unknown same-origin requests are network-only", () => {
    expect(classify("/something-else")).toBe("network-only")
  })
})

describe("isCacheableResponse", () => {
  test("stores complete same-origin 200 responses", () => {
    expect(isCacheableResponse({ status: 200, type: "basic" })).toBe(true)
    expect(
      isCacheableResponse({
        status: 200,
        type: "basic",
        cacheControl: "public, max-age=60",
      })
    ).toBe(true)
  })

  test("never stores no-store responses", () => {
    for (const cacheControl of [
      "no-store",
      "private, no-cache, no-store, max-age=0, must-revalidate",
      "NO-STORE",
    ]) {
      expect(
        isCacheableResponse({ status: 200, type: "basic", cacheControl })
      ).toBe(false)
    }
  })

  test("never stores errors, partial or opaque responses", () => {
    expect(isCacheableResponse({ status: 500, type: "basic" })).toBe(false)
    expect(isCacheableResponse({ status: 206, type: "basic" })).toBe(false)
    expect(isCacheableResponse({ status: 200, type: "opaque" })).toBe(false)
  })
})
