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
  `${source}\n({ classifyRequest, isCacheableResponse, notificationForPush, APPROVAL_QUEUE_URL })`,
  { URL }
)
const {
  classifyRequest,
  isCacheableResponse,
  notificationForPush,
  APPROVAL_QUEUE_URL,
} = exported as {
  classifyRequest: (request: Request) => Kind
  isCacheableResponse: (response: Response) => boolean
  notificationForPush: (
    payload: string
  ) => { title: string; body: string } | null
  APPROVAL_QUEUE_URL: string
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

describe("push notification routing", () => {
  test("shows only fixed generic copy and the pending count", () => {
    expect(notificationForPush('{"v":1,"pending":2}')).toEqual({
      title: "Eido approval queue",
      body: "2 approvals are waiting for your review.",
    })
    expect(notificationForPush('{"v":1,"pending":1}')).toEqual({
      title: "Eido approval queue",
      body: "1 approval is waiting for your review.",
    })
  })

  test("rejects malformed and non-exact payloads", () => {
    expect(notificationForPush("not json")).toBeNull()
    expect(
      notificationForPush('{"v":1,"pending":2,"intent":"private"}')
    ).toBeNull()
    expect(notificationForPush('{"v":2,"pending":2}')).toBeNull()
    expect(notificationForPush('{"v":1,"pending":-1}')).toBeNull()
  })

  test("notification clicks target the approval queue", () => {
    expect(APPROVAL_QUEUE_URL).toBe("/queue")
  })

  test("clicking focuses an open queue or opens that route when no queue is open", async () => {
    const workerSource = readFileSync(
      path.join(__dirname, "..", "public", "sw.js"),
      "utf8"
    )
    const listeners = new Map<string, (event: unknown) => void>()
    const focused: string[] = []
    const opened: string[] = []
    let windows = [
      {
        url: `${ORIGIN}/queue`,
        focus: () => {
          focused.push("queue")
          return Promise.resolve()
        },
      },
    ]
    const worker = {
      location: { origin: ORIGIN },
      clients: {
        matchAll: () => Promise.resolve(windows),
        openWindow: (url: string) => {
          opened.push(url)
          return Promise.resolve()
        },
      },
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners.set(name, listener)
      },
    }
    runInNewContext(`${source}\n${workerSource}`, {
      self: worker,
      URL,
      importScripts: () => undefined,
    })
    const click = listeners.get("notificationclick")
    if (click === undefined)
      throw new Error("notification click listener is missing")
    let waited: Promise<unknown> | undefined
    let closed = 0
    const event = {
      notification: {
        close: () => {
          closed++
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise
      },
    }
    click(event)
    await waited
    expect(focused).toEqual(["queue"])
    expect(opened).toEqual([])
    windows = []
    click(event)
    await waited
    expect(opened).toEqual([`${ORIGIN}/queue`])
    expect(closed).toBe(2)
  })
})
