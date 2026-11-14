import { afterEach, describe, expect, test, vi } from "vitest"
import { REVIEWED_MANIFESTS, validateConnectorManifest } from "@eido/schemas"
import { setup, loggedText } from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import type { GateRequest } from "../http"
import { payloadHash } from "../canonical"
import { APPLE_CONNECTOR, appleRoute } from "./apple-routes"
import type { AppleReads } from "./apple-adapter"
import { AppleError } from "./runner"
import { appleProbe } from "./apple-adapter"
import { checkConnector } from "../connector-connect"
import { dataPlaneHandler } from "../routes"

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})
function fixture() {
  const manifest = validateConnectorManifest(
    REVIEWED_MANIFESTS[APPLE_CONNECTOR]
  )
  if (!manifest.ok) throw new Error(manifest.errors.join("; "))
  s = setup([manifest.value])
  return s
}
function req(path: string, query = "", method = "GET"): GateRequest {
  return {
    path,
    method,
    query: new URLSearchParams(query),
    headers: {},
    body: () => Promise.resolve({ ok: true, text: "" }),
  }
}
function reads(): AppleReads {
  return {
    listCalendars: vi.fn(() =>
      Promise.resolve({
        calendars: [
          { id: "cal", title: "Private calendar title", writable: true },
        ],
      })
    ),
    listReminderLists: vi.fn(() => Promise.resolve({ calendars: [] })),
    listEvents: vi.fn(() => Promise.resolve({ events: [] })),
    listReminders: vi.fn(() => Promise.resolve({ reminders: [] })),
  }
}

describe("Apple data-plane reads", () => {
  test("routes all four reads and audits counts without payloads", async () => {
    const state = fixture()
    const apple = reads()
    expect(await appleRoute(req("/apple/calendars"), state.db, apple)).toEqual({
      status: 200,
      body: {
        calendars: [
          { id: "cal", title: "Private calendar title", writable: true },
        ],
      },
    })
    expect(
      (await appleRoute(req("/apple/reminder-lists"), state.db, apple))?.status
    ).toBe(200)
    expect(
      (
        await appleRoute(
          req(
            "/apple/events",
            "calendarId=cal&start=2026-11-14T00:00:00Z&end=2026-11-15T00:00:00Z"
          ),
          state.db,
          apple
        )
      )?.body
    ).toEqual({ events: [] })
    expect(
      (
        await appleRoute(
          req(
            "/apple/reminders",
            "listId=list&completedSince=2026-11-01T00:00:00Z"
          ),
          state.db,
          apple
        )
      )?.body
    ).toEqual({ reminders: [] })
    expect(apple.listEvents).toHaveBeenCalledWith(
      "cal",
      "2026-11-14T00:00:00Z",
      "2026-11-15T00:00:00Z"
    )
    expect(apple.listReminders).toHaveBeenCalledWith(
      "list",
      "2026-11-01T00:00:00Z"
    )
    expect(
      state.db
        .prepare(
          "SELECT detail_hash FROM audit_log WHERE action='apple.read.list_calendars'"
        )
        .get()?.["detail_hash"]
    ).toBe(payloadHash({ items: 1 }))
    expect(loggedText(state.db)).not.toContain("Private calendar title")
  })
  test.each([
    ["/apple/calendars", "unexpected=1"],
    [
      "/apple/events",
      "calendarId=cal&calendarId=other&start=2026-11-14T00:00:00Z&end=2026-11-15T00:00:00Z",
    ],
    [
      "/apple/events",
      "calendarId=cal&start=2026-11-15T00:00:00Z&end=2026-11-14T00:00:00Z",
    ],
    [
      "/apple/events",
      "calendarId=cal&start=2026-11-14T00:00:00Z&end=2028-11-15T00:00:00Z",
    ],
    ["/apple/events", "calendarId=cal&start=nope&end=nope"],
    ["/apple/reminders", "listId=list"],
  ])(
    "rejects invalid query parameters before calling Helper (%s)",
    async (path, query) => {
      const state = fixture()
      const apple = reads()
      expect(
        (await appleRoute(req(path, query), state.db, apple))?.status
      ).toBe(400)
      expect(apple.listEvents).not.toHaveBeenCalled()
      expect(apple.listCalendars).not.toHaveBeenCalled()
      expect(apple.listReminders).not.toHaveBeenCalled()
    }
  )
  test("has no write route and refuses a disabled connector", async () => {
    const state = fixture()
    const apple = reads()
    expect(
      await appleRoute(req("/apple/calendars", "", "POST"), state.db, apple)
    ).toBeUndefined()
    expect(
      await appleRoute(req("/apple/create_event"), state.db, apple)
    ).toBeUndefined()
    state.db
      .prepare("UPDATE connectors SET enabled=0 WHERE name=?")
      .run(APPLE_CONNECTOR)
    expect(
      (await appleRoute(req("/apple/calendars"), state.db, apple))?.status
    ).toBe(503)
    expect(apple.listCalendars).not.toHaveBeenCalled()
  })
  test.each([
    ["permission_denied", 502, "auth_failed"],
    ["not_found", 404, "not_found"],
    ["invalid_request", 400, "invalid_request"],
    ["unavailable", 502, "unavailable"],
  ] as const)(
    "maps Helper %s to a bounded response",
    async (code, status, resultCode) => {
      const state = fixture()
      const apple = reads()
      apple.listCalendars = () => Promise.reject(new AppleError(code))
      expect(
        await appleRoute(req("/apple/calendars"), state.db, apple)
      ).toMatchObject({ status, body: { code: resultCode } })
      if (code === "permission_denied")
        expect(
          state.db
            .prepare("SELECT enabled FROM connectors WHERE name=?")
            .get(APPLE_CONNECTOR)?.["enabled"]
        ).toBe(0)
    }
  )
  test("does not expose arbitrary subprocess errors", async () => {
    const state = fixture()
    const apple = reads()
    apple.listCalendars = () => Promise.reject(new Error("private event title"))
    expect(await appleRoute(req("/apple/calendars"), state.db, apple)).toEqual({
      status: 502,
      body: { code: "unavailable", message: "Apple Helper is unavailable" },
    })
    expect(loggedText(state.db)).not.toContain("private event title")
  })
})

test("an explicit owner reconnect recovers after granting EventKit access", async () => {
  const state = fixture()
  const denied = reads()
  denied.listCalendars = () =>
    Promise.reject(new AppleError("permission_denied"))
  expect(
    (await appleRoute(req("/apple/calendars"), state.db, denied))?.status
  ).toBe(502)
  const granted = reads()
  expect(
    (await appleRoute(req("/apple/calendars"), state.db, granted))?.status
  ).toBe(503)
  expect(granted.listCalendars).not.toHaveBeenCalled()
  expect(
    (
      await checkConnector(
        state.db,
        APPLE_CONNECTOR,
        { [APPLE_CONNECTOR]: appleProbe(granted) },
        Date.now
      )
    ).status
  ).toBe(200)
  expect(
    (await appleRoute(req("/apple/calendars"), state.db, granted))?.status
  ).toBe(200)
  expect(
    state.db
      .prepare("SELECT enabled,health FROM connectors WHERE name=?")
      .get(APPLE_CONNECTOR)
  ).toMatchObject({ enabled: 1, health: "healthy" })
})

test("the actual data-plane handler serves Apple reads and exposes no direct write endpoint", async () => {
  const state = fixture()
  const apple = reads()
  const handler = dataPlaneHandler(
    () => state,
    undefined,
    undefined,
    undefined,
    apple
  )
  expect((await handler(req("/apple/calendars"))).status).toBe(200)
  expect((await handler(req("/apple/calendars", "", "POST"))).status).toBe(404)
  expect((await handler(req("/apple/create_event", "", "POST"))).status).toBe(
    404
  )
})
