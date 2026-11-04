import { validateCoreApiSimpleFinSync } from "@eido/schemas"
import { describe, expect, test, vi } from "vitest"
import type { SimpleFinSyncNowResult } from "../connectors/simplefin/runtime"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

function handlerFor(
  result: SimpleFinSyncNowResult,
  configured = true
): { handle: ApiHandler; syncer: ReturnType<typeof vi.fn> } {
  const syncer = vi.fn(() => Promise.resolve(result))
  const profile = createProfileStore(openIndex(":memory:"), {
    audit: () => Promise.resolve(),
  })
  return {
    syncer,
    handle: createApiHandler({
      profile,
      allowedHosts: ["core.test"],
      ...(configured ? { syncSimpleFin: syncer } : {}),
    }),
  }
}

const post = (handle: ApiHandler, method = "POST"): Promise<Response> =>
  handle(new Request("http://core.test/connectors/simplefin/sync", { method }))

describe("POST /connectors/simplefin/sync", () => {
  test("a sync that ran answers 200 with the next scheduled sync", async () => {
    const { handle, syncer } = handlerFor({
      status: "synced",
      nextSyncAt: "2026-07-02T06:30:00.000Z",
    })
    const response = await post(handle)
    const body: unknown = await response.json()
    expect(response.status).toBe(200)
    expect(body).toEqual({
      status: "synced",
      nextSyncAt: "2026-07-02T06:30:00.000Z",
    })
    expect(validateCoreApiSimpleFinSync(body).ok).toBe(true)
    expect(syncer).toHaveBeenCalledTimes(1)
  })

  test("a spent daily budget answers 409 with the daily-limit reason and the reset time", async () => {
    const { handle } = handlerFor({
      status: "refused",
      reason: "daily_limit",
      nextSyncAt: "2026-07-02T00:00:00.000Z",
    })
    const response = await post(handle)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      status: "refused",
      reason: "daily_limit",
      nextSyncAt: "2026-07-02T00:00:00.000Z",
    })
  })

  test("other refusals answer 409 with their reason", async () => {
    const { handle } = handlerFor({
      status: "refused",
      reason: "connector_unavailable",
    })
    const response = await post(handle)
    expect([response.status, await response.json()]).toEqual([
      409,
      { status: "refused", reason: "connector_unavailable" },
    ])
  })

  test("only POST is allowed, and the sync does not run for a GET", async () => {
    const { handle, syncer } = handlerFor({
      status: "synced",
      nextSyncAt: "2026-07-02T06:30:00.000Z",
    })
    const response = await post(handle, "GET")
    expect(response.status).toBe(405)
    expect(syncer).not.toHaveBeenCalled()
  })

  test("is not served when SimpleFIN is not configured", async () => {
    const { handle } = handlerFor(
      { status: "synced", nextSyncAt: "2026-07-02T06:30:00.000Z" },
      false
    )
    expect((await post(handle)).status).toBe(404)
  })
})
