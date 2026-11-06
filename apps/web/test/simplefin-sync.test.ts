import { afterEach, describe, expect, test, vi } from "vitest"
import { budgetSpent, runSimpleFinSync, syncLine } from "../lib/simplefin-sync"
import { MIDNIGHT_AT, refused, synced } from "./fixtures/simplefin-sync"

afterEach(() => vi.unstubAllGlobals())

const reply = (body: unknown, status: number) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })))
  )

describe("runSimpleFinSync", () => {
  test("200 synced", async () => {
    reply(synced, 200)
    expect(await runSimpleFinSync()).toEqual({
      status: "synced",
      nextSyncAt: synced.nextSyncAt,
    })
  })

  test("409 refused keeps the reason and reset time", async () => {
    reply(refused("daily_limit", MIDNIGHT_AT), 409)
    expect(await runSimpleFinSync()).toEqual({
      status: "refused",
      reason: "daily_limit",
      nextSyncAt: MIDNIGHT_AT,
    })
  })

  test("a refused body without a reason, a 404 and a bad body all fail", async () => {
    reply({ status: "refused" }, 409)
    expect(await runSimpleFinSync()).toEqual({ status: "failed" })
    reply({}, 404)
    expect(await runSimpleFinSync()).toEqual({ status: "failed" })
    reply({ nope: true }, 200)
    expect(await runSimpleFinSync()).toEqual({ status: "failed" })
  })

  test("a 409 that says synced fails", async () => {
    reply(synced, 409)
    expect(await runSimpleFinSync()).toEqual({ status: "failed" })
  })
})

describe("budget", () => {
  test("spent when the count reaches the limit, not before", () => {
    expect(budgetSpent({ requestsToday: 23, requestLimit: 24 })).toBe(false)
    expect(budgetSpent({ requestsToday: 24, requestLimit: 24 })).toBe(true)
    expect(budgetSpent({ requestsToday: 24 })).toBe(false)
  })

  test("the line is empty with no data and just the count once spent", () => {
    expect(syncLine({})).toBe("")
    expect(
      syncLine({ requestsToday: 24, requestLimit: 24, nextSyncAt: MIDNIGHT_AT })
    ).toBe("24 of 24 requests today")
  })
})
