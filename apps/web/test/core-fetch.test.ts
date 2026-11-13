import { describe, expect, it, vi } from "vitest"

import { withCoreRoleRefresh } from "@/lib/auth/core-fetch"

const unauthenticated = () =>
  Response.json(
    { error: { code: "unauthenticated", message: "sign in again" } },
    { status: 401 }
  )

function setup(responses: Response[]) {
  const base = vi.fn<typeof fetch>()
  for (const r of responses) base.mockResolvedValueOnce(r)
  return { base, fetch: withCoreRoleRefresh(base) }
}

describe("withCoreRoleRefresh", () => {
  it("refreshes the cookie and retries a core 401 once", async () => {
    const ok = Response.json({ ok: true })
    const { base, fetch } = setup([
      unauthenticated(),
      new Response(null, { status: 204 }),
      ok,
    ])
    const init = { method: "POST", body: "{}" }
    expect(await fetch("/api/core/ask", init)).toBe(ok)
    expect(base).toHaveBeenCalledTimes(3)
    expect(base.mock.calls[1]).toEqual([
      "/auth/core-role",
      { method: "POST", cache: "no-store" },
    ])
    expect(base.mock.calls[2]).toEqual(["/api/core/ask", init])
  })

  it("does not retry twice", async () => {
    const { base, fetch } = setup([
      unauthenticated(),
      new Response(null, { status: 204 }),
      unauthenticated(),
    ])
    expect((await fetch("/api/core/ask", { method: "POST" })).status).toBe(401)
    expect(base).toHaveBeenCalledTimes(3)
  })

  it("returns the first 401 when the refresh is refused or fails", async () => {
    const refused = setup([
      unauthenticated(),
      new Response(null, { status: 401 }),
    ])
    expect((await refused.fetch("/api/core/ask")).status).toBe(401)
    expect(refused.base).toHaveBeenCalledTimes(2)

    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthenticated())
      .mockRejectedValueOnce(new TypeError("offline"))
    expect((await withCoreRoleRefresh(base)("/api/core/ask")).status).toBe(401)
  })

  it("leaves other responses and other paths alone", async () => {
    const forbidden = Response.json(
      { error: { code: "forbidden", message: "no" } },
      { status: 403 }
    )
    const a = setup([forbidden])
    expect(await a.fetch("/api/core/ask")).toBe(forbidden)
    expect(a.base).toHaveBeenCalledTimes(1)

    const gate = unauthenticated()
    const b = setup([gate])
    expect(await b.fetch("/api/gate/approvals")).toBe(gate)
    expect(b.base).toHaveBeenCalledTimes(1)

    const plain = new Response("nope", { status: 401 })
    const c = setup([plain])
    expect(await c.fetch(new URL("http://x.test/api/core/ask"))).toBe(plain)
    expect(c.base).toHaveBeenCalledTimes(1)
  })

  it("reads the path from a Request", async () => {
    const ok = Response.json({})
    const { base, fetch } = setup([
      unauthenticated(),
      new Response(null, { status: 204 }),
      ok,
    ])
    await fetch(
      new Request("http://x.test/api/core/intents", { method: "POST" })
    )
    expect(base).toHaveBeenCalledTimes(3)
  })
})
