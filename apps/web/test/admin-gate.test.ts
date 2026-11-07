/* eslint-disable @typescript-eslint/require-await -- fetch stubs return promises */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ValidationResult } from "@eido/schemas"
import { anyJson, callGate } from "@/lib/admin/gate"

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

const count = (value: unknown): ValidationResult<{ n: number }> =>
  typeof value === "object" &&
  value !== null &&
  "n" in value &&
  typeof value.n === "number"
    ? { ok: true, value: { n: value.n } }
    : { ok: false, errors: ["n"] }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("callGate", () => {
  it("GETs the gate path without a body and returns the checked answer", async () => {
    const fetchMock = vi.fn(async () => json(200, { n: 3 }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await callGate("/admin/stack", count)).toEqual({
      kind: "ok",
      status: 200,
      value: { n: 3 },
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("/api/gate/admin/stack")
    expect(init.method).toBe("GET")
    expect(init.body).toBeUndefined()
  })

  it("POSTs a body as JSON", async () => {
    const fetchMock = vi.fn(async () => json(202, { n: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    await callGate("/admin/stack/restart", count, {
      body: { names: ["core"] },
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "content-type": "application/json" })
    expect(init.body).toBe('{"names":["core"]}')
  })

  it("is unreachable when fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("x")))
    )
    expect(await callGate("/x", count)).toEqual({ kind: "unreachable" })
  })

  it("rethrows when the caller aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const abort = new DOMException("aborted", "AbortError")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(abort))
    )
    await expect(
      callGate("/x", count, { signal: controller.signal })
    ).rejects.toBe(abort)
  })

  it("reads 401 as the session ending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { code: "x" }))
    )
    expect(await callGate("/x", count)).toEqual({ kind: "expired" })
  })

  it("reads 403 step_up_required as a step-up, other codes as refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(403, { code: "step_up_required", message: "Step up." })
      )
    )
    expect(await callGate("/x", count)).toEqual({ kind: "step-up" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(503, { code: "supervisor_unavailable", message: "Down." })
      )
    )
    expect(await callGate("/x", count)).toEqual({
      kind: "refused",
      status: 503,
      code: "supervisor_unavailable",
    })
  })

  it("refuses with code unknown when an error body is not the gate's error shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(500, { nope: true }))
    )
    expect(await callGate("/x", count)).toEqual({
      kind: "refused",
      status: 500,
      code: "unknown",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 502 }))
    )
    expect(await callGate("/x", count)).toEqual({
      kind: "refused",
      status: 502,
      code: "unknown",
    })
  })

  it("is invalid when a success is not JSON or fails its schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 }))
    )
    expect(await callGate("/x", count)).toEqual({ kind: "invalid" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { n: "3" }))
    )
    expect(await callGate("/x", count)).toEqual({ kind: "invalid" })
  })
})

describe("anyJson", () => {
  it("passes the value through", () => {
    expect(anyJson({ a: 1 })).toEqual({ ok: true, value: { a: 1 } })
  })
})
