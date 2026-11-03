import { afterEach, describe, expect, test, vi } from "vitest"
import { loadHistory, loadQueue } from "../lib/queue/api"

afterEach(() => vi.unstubAllGlobals())

const stub = (response: Response | Error) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response)
    )
  )

const intent = (id: string, createdAt: string) => ({
  id,
  kind: "email.send",
  tier: "approval",
  state: "pending",
  origin: "task",
  createdAt,
})

describe("queue api", () => {
  test("the queue is ordered oldest first", async () => {
    stub(
      Response.json({
        intents: [
          intent("new", "2026-10-18T00:00:00.000Z"),
          intent("old", "2026-10-01T00:00:00.000Z"),
        ],
      })
    )
    const result = await loadQueue()
    expect(result.ok && result.value.map((i) => i.id)).toEqual(["old", "new"])
  })

  test("an unreadable list is a failure, not an empty queue", async () => {
    stub(Response.json({ nope: true }))
    expect(await loadQueue()).toEqual({ ok: false, status: 502 })
  })

  test("a 401 keeps its status", async () => {
    stub(new Response(null, { status: 401 }))
    expect(await loadHistory("i")).toEqual({ ok: false, status: 401 })
  })

  test("a network error is reported as such", async () => {
    stub(new TypeError("down"))
    expect(await loadQueue()).toEqual({ ok: false, status: "network" })
  })
})
