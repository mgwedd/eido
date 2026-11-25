import { afterEach, expect, test, vi } from "vitest"
import {
  CONFIRM_CARD_URL,
  requestConfirmCard,
} from "../lib/deferred-confirm-card"
import { confirmCardResponse } from "./fixtures/today"

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(impl: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(impl()))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function bodyOf(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string")
    throw new Error("expected a JSON string body")
  return init.body
}

test("posts the extraction id as JSON to core's confirm-card route", async () => {
  const fetchMock = stub(() => Response.json(confirmCardResponse))
  await requestConfirmCard(17)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0]!
  expect(url).toBe("/api/core/extractions/confirm-card")
  expect(CONFIRM_CARD_URL).toBe("/api/core/extractions/confirm-card")
  expect(init?.method).toBe("POST")
  expect(JSON.parse(bodyOf(init))).toEqual({ extractionId: 17 })
})

test("a new card (201) opens at the queue link core returned", async () => {
  stub(() => Response.json(confirmCardResponse, { status: 201 }))
  expect(await requestConfirmCard(17)).toEqual({
    status: "opened",
    queueHref: "/queue?intent=intent-extraction-fixture",
  })
})

test("an existing card (200) opens the same way", async () => {
  stub(() =>
    Response.json({ ...confirmCardResponse, created: false }, { status: 200 })
  )
  expect(await requestConfirmCard(17)).toEqual({
    status: "opened",
    queueHref: "/queue?intent=intent-extraction-fixture",
  })
})

test("a 401 reports an expired session", async () => {
  stub(() => new Response(null, { status: 401 }))
  expect(await requestConfirmCard(17)).toEqual({ status: "unauthenticated" })
})

test.each([404, 422, 503])(
  "a %i error fails without a queue link",
  async (status) => {
    stub(() =>
      Response.json(
        { error: { code: "not_found", message: "Lorem ipsum" } },
        { status }
      )
    )
    expect(await requestConfirmCard(17)).toEqual({ status: "failed" })
  }
)

test("a success body that is not a confirm-card response fails", async () => {
  stub(() =>
    Response.json({
      ...confirmCardResponse,
      queueHref: "https://example.invalid/q",
    })
  )
  expect(await requestConfirmCard(17)).toEqual({ status: "failed" })
})

test("a success body that is not JSON fails", async () => {
  stub(() => new Response("<html>", { status: 200 }))
  expect(await requestConfirmCard(17)).toEqual({ status: "failed" })
})

test("a network failure fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.reject(new TypeError("network")))
  )
  expect(await requestConfirmCard(17)).toEqual({ status: "failed" })
})
