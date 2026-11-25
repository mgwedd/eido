import { describe, expect, test } from "vitest"
import { appleProbe, createAppleReads } from "./apple-adapter"
import { AppleError } from "./runner"
import type { AppleRunner } from "./runner"
import type { GateAppleRequest } from "@eido/schemas"

describe("Apple read adapter", () => {
  test("sends only fixed read operations and checks each response shape", async () => {
    const requests: GateAppleRequest[] = []
    const run: AppleRunner = (request) => {
      requests.push(request)
      return Promise.resolve(
        request.operation === "list_events"
          ? { events: [] }
          : request.operation === "list_reminders"
            ? { reminders: [] }
            : { calendars: [{ id: "cal", title: "Work", writable: true }] }
      )
    }
    const reads = createAppleReads(run)
    await expect(reads.listCalendars()).resolves.toEqual({
      calendars: [{ id: "cal", title: "Work", writable: true }],
    })
    await reads.listReminderLists()
    await expect(
      reads.listEvents("cal", "2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z")
    ).resolves.toEqual({ events: [] })
    await expect(
      reads.listReminders("list", "2026-11-01T00:00:00Z")
    ).resolves.toEqual({ reminders: [] })
    expect(requests).toEqual([
      { operation: "list_calendars", args: {} },
      { operation: "list_reminder_lists", args: {} },
      {
        operation: "list_events",
        args: {
          calendarId: "cal",
          start: "2026-11-14T00:00:00Z",
          end: "2026-11-15T00:00:00Z",
        },
      },
      {
        operation: "list_reminders",
        args: { listId: "list", completedSince: "2026-11-01T00:00:00Z" },
      },
    ])
  })
  test("refuses a valid envelope with the wrong operation's result", async () => {
    const reads = createAppleReads(() => Promise.resolve({ calendars: [] }))
    await expect(
      reads.listEvents("cal", "2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z")
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      reads.listReminders("list", "2026-11-01T00:00:00Z")
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(
      createAppleReads(() => Promise.resolve({ events: [] })).listCalendars()
    ).rejects.toMatchObject({ code: "unavailable" })
  })
})

test("reconnect probe checks both grants and exposes only a bounded outcome", async () => {
  const calls: string[] = []
  const ok = createAppleReads((request) => {
    calls.push(request.operation)
    return Promise.resolve({ calendars: [] })
  })
  await expect(appleProbe(ok)()).resolves.toBe("ok")
  expect(calls).toEqual(["list_calendars", "list_reminder_lists"])
  const denied = createAppleReads(() =>
    Promise.reject(new AppleError("permission_denied"))
  )
  await expect(appleProbe(denied)()).resolves.toBe("auth_failed")
  const unavailable = createAppleReads(() =>
    Promise.reject(new Error("private calendar content"))
  )
  await expect(appleProbe(unavailable)()).resolves.toBe("unavailable")
})
