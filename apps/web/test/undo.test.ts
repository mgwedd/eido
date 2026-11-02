import { afterEach, describe, expect, test, vi } from "vitest"
import { nextUndoState, requestUndo, undoUrl } from "../lib/undo"
import { EXECUTED_ID, UNDONE_ID } from "./fixtures/activity"

afterEach(() => vi.unstubAllGlobals())
const stub = (impl: () => Promise<Response>) => {
  const fetchMock = vi.fn<typeof fetch>(impl)
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("nextUndoState", () => {
  test.each([
    ["idle", "start", "undoing"],
    ["failed", "start", "undoing"],
    ["undoing", "start", "undoing"],
    ["undone", "start", "undone"],
    ["undoing", "confirmed", "undone"],
    ["undoing", "unconfirmed", "failed"],
    ["idle", "confirmed", "idle"],
    ["idle", "unconfirmed", "idle"],
  ] as const)("%s + %s is %s", (state, event, next) =>
    expect(nextUndoState(state, event)).toBe(next)
  )
})

describe("requestUndo", () => {
  test("POSTs an empty JSON body to the execution's undo route", async () => {
    const fetchMock = stub(() =>
      Promise.resolve(Response.json({ id: EXECUTED_ID, undone: true }))
    )
    expect(await requestUndo(EXECUTED_ID)).toBe("confirmed")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(`/api/gate/executions/${EXECUTED_ID}/undo`)
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe("{}")
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json"
    )
  })

  test("encodes the id into the path", () => {
    expect(undoUrl("a/b")).toBe("/api/gate/executions/a%2Fb/undo")
  })

  test.each([
    [
      "a refusal",
      () =>
        Promise.resolve(
          Response.json({ error: "already_decided" }, { status: 409 })
        ),
    ],
    [
      "a server error",
      () => Promise.resolve(new Response(null, { status: 503 })),
    ],
    [
      "another execution's result",
      () => Promise.resolve(Response.json({ id: UNDONE_ID, undone: true })),
    ],
    [
      "an unreadable body",
      () => Promise.resolve(Response.json({ id: EXECUTED_ID })),
    ],
    ["a network failure", () => Promise.reject(new TypeError("network"))],
  ])("%s is unconfirmed", async (_, impl) => {
    stub(impl)
    expect(await requestUndo(EXECUTED_ID)).toBe("unconfirmed")
  })

  test("a 401 is unauthenticated", async () => {
    stub(() => Promise.resolve(new Response(null, { status: 401 })))
    expect(await requestUndo(EXECUTED_ID)).toBe("unauthenticated")
  })
})
