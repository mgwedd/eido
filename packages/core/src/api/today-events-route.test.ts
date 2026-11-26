import type { DatabaseSync } from "node:sqlite"
import type { CoreApiError, CoreApiTodayEvents } from "@eido/schemas"
import { validateCoreApiTodayEvents } from "@eido/schemas"
import type { GateAppleCalendarList, GateAppleEventList } from "@eido/schemas"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { indexEvents } from "../context/context.test-support"
import type { EventSpec } from "../context/context.test-support"
import { syncAppleCalendars } from "../connectors/apple-calendar/sync"
import { MISSING_RUNS_BEFORE_RETIRE } from "../connectors/apple-calendar/unread"
import { ledgerFixture } from "../ledger/ledger.test-support"
import type { LedgerFixture } from "../ledger/ledger.test-support"
import type { ProfileStore } from "../profile/store"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

// Synthetic calendars and events only: ids, titles and times are invented.

let fixture: LedgerFixture
let db: DatabaseSync
let profile: ProfileStore
let handle: ApiHandler
let now = new Date("2030-03-01T12:00:00.000Z")

beforeEach(async () => {
  fixture = await ledgerFixture()
  db = fixture.db
  profile = fixture.profile
  now = new Date("2030-03-01T12:00:00.000Z")
  handle = createApiHandler({
    profile,
    allowedHosts: ["core.test"],
    basePath: "/api/core",
    documents: { db },
    now: () => now,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const index = (specs: EventSpec[]): void =>
  indexEvents(db, specs, fixture.company.id)

const request = (method = "GET"): Promise<Response> =>
  handle(new Request("http://core.test/api/core/today/events", { method }))

async function today(): Promise<CoreApiTodayEvents> {
  const response = await request()
  expect(response.status).toBe(200)
  const checked = validateCoreApiTodayEvents(await response.json())
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value
}

const ids = (body: CoreApiTodayEvents): string[] =>
  body.events.map((event) => event.id)

const at = (time: string, day = "2030-03-01"): string =>
  `${day}T${time}:00.000Z`

function timed(
  uid: string,
  start: string,
  end: string,
  extra: Partial<EventSpec> = {}
): EventSpec {
  return { uid, title: `Event ${uid}`, start, end, ...extra }
}

describe("GET /today/events", () => {
  test("lists the day's events with their fields, earliest start first", async () => {
    index([
      timed("late", at("15:00"), at("16:00"), { title: "Dentist" }),
      timed("early", at("08:00"), at("08:30"), { title: "Standup" }),
      timed("next-day", at("08:00", "2030-03-02"), at("09:00", "2030-03-02")),
    ])
    expect(await today()).toEqual({
      timezone: "Etc/UTC",
      date: "2030-03-01",
      events: [
        {
          id: "early",
          title: "Standup",
          start: at("08:00"),
          end: at("08:30"),
          allDay: false,
        },
        {
          id: "late",
          title: "Dentist",
          start: at("15:00"),
          end: at("16:00"),
          allDay: false,
        },
      ],
    })
  })

  test("a day without events is an empty list, not an error", async () => {
    expect((await today()).events).toEqual([])
  })

  test("the day is the owner's local day, not the UTC day", async () => {
    await profile.updateProfile({
      displayName: "Example Owner",
      timezone: "Pacific/Auckland",
    })
    // 23:30 UTC on 1 March is 12:30 on 2 March in Auckland (UTC+13).
    now = new Date("2030-03-01T23:30:00.000Z")
    index([
      timed("auckland-today", at("12:00"), at("13:00")),
      timed(
        "auckland-tomorrow",
        at("12:00", "2030-03-02"),
        at("13:00", "2030-03-02")
      ),
      timed("auckland-yesterday", at("08:00"), at("09:00")),
    ])
    const body = await today()
    expect(body.timezone).toBe("Pacific/Auckland")
    expect(body.date).toBe("2030-03-02")
    expect(ids(body)).toEqual(["auckland-today"])
  })

  test("on a 23-hour day the hour that does not exist belongs to neither neighbour", async () => {
    await profile.updateProfile({
      displayName: "Example Owner",
      timezone: "Europe/Berlin",
    })
    // Berlin skips from 02:00 to 03:00 on 31 March 2030: the local day is 23:00Z to 22:00Z.
    now = new Date("2030-03-31T10:00:00.000Z")
    index([
      timed("before", "2030-03-30T22:30:00.000Z", "2030-03-30T22:45:00.000Z"),
      timed("first", "2030-03-30T23:00:00.000Z", "2030-03-30T23:30:00.000Z"),
      timed("last", "2030-03-31T21:30:00.000Z", "2030-03-31T21:45:00.000Z"),
      timed("after", "2030-03-31T22:00:00.000Z", "2030-03-31T22:30:00.000Z"),
    ])
    expect(ids(await today())).toEqual(["first", "last"])
  })

  test("an all-day event is flagged and listed for each day it covers", async () => {
    index([
      timed("birthday", at("00:00"), at("00:00", "2030-03-02"), {
        allDay: true,
      }),
      timed("trip", at("00:00", "2030-02-27"), at("00:00", "2030-03-03"), {
        allDay: true,
      }),
      timed("tomorrow", at("00:00", "2030-03-02"), at("00:00", "2030-03-03"), {
        allDay: true,
      }),
    ])
    const body = await today()
    expect(body.events.map((e) => [e.id, e.allDay])).toEqual([
      ["trip", true],
      ["birthday", true],
    ])
  })

  test("a timed event that spans midnight is listed on both days", async () => {
    index([
      timed(
        "overnight",
        "2030-02-28T22:00:00.000Z",
        "2030-03-01T02:00:00.000Z"
      ),
    ])
    expect(ids(await today())).toEqual(["overnight"])
  })

  test("an event that ends exactly when the day starts, or starts when it ends, is not listed", async () => {
    index([
      timed("ends-at-midnight", "2030-02-28T23:00:00.000Z", at("00:00")),
      timed(
        "starts-at-midnight",
        at("00:00", "2030-03-02"),
        at("01:00", "2030-03-02")
      ),
    ])
    expect(ids(await today())).toEqual([])
  })

  test("an event with no length is listed when it starts within the day", async () => {
    index([
      timed("reminder", at("00:00"), at("00:00")),
      timed("other-day", at("00:00", "2030-03-02"), at("00:00", "2030-03-02")),
    ])
    expect(ids(await today())).toEqual(["reminder"])
  })

  test("an event that was edited is listed once, as its current version", async () => {
    index([
      timed("moved", at("08:00"), at("09:00"), {
        title: "Old title",
        retired: true,
      }),
      timed("moved", at("10:00"), at("11:00"), { title: "New title" }),
    ])
    const body = await today()
    expect(body.events.map((e) => [e.id, e.title, e.start])).toEqual([
      ["moved", "New title", at("10:00")],
    ])
  })

  test("a retired event and an event from another calendar source are not listed", async () => {
    index([
      timed("kept", at("09:00"), at("10:00")),
      timed("cancelled", at("11:00"), at("12:00"), { retired: true }),
      timed("invitation", at("13:00"), at("14:00"), {
        source: "proton-calendar",
      }),
    ])
    expect(ids(await today())).toEqual(["kept"])
  })

  test("a title is whitespace-collapsed and cut at 200 characters", async () => {
    index([
      timed("long", at("09:00"), at("10:00"), {
        title: `  ${"a".repeat(250)}\n`,
      }),
      timed("spaced", at("11:00"), at("12:00"), {
        title: "Lunch \n  with   friends",
      }),
    ])
    const body = await today()
    expect(body.events.map((e) => e.title)).toEqual([
      "a".repeat(200),
      "Lunch with friends",
    ])
  })

  test("a day lists at most 200 events", async () => {
    index(
      Array.from({ length: 201 }, (_, i) =>
        timed(`e${String(i).padStart(3, "0")}`, at("08:00"), at("09:00"))
      )
    )
    const body = await today()
    expect(body.events).toHaveLength(200)
    expect(body.events.at(-1)?.id).toBe("e199")
  })

  test("a method other than GET is refused", async () => {
    const response = await request("POST")
    const body = (await response.json()) as CoreApiError
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
    expect(body.error.code).toBe("method_not_allowed")
  })

  test("serving the day writes no event title to any log", async () => {
    const written: string[] = []
    const capture = (...args: unknown[]): void => {
      written.push(args.map(String).join(" "))
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(capture)
    }
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    index([
      timed("secret", at("09:00"), at("10:00"), {
        title: "Lorem private appointment",
      }),
    ])
    expect((await today()).events).toHaveLength(1)
    expect(written.filter((line) => line.includes("Lorem private"))).toEqual([])
  })
})

describe("GET /today/events after a calendar sync", () => {
  const CALENDARS: GateAppleCalendarList = {
    calendars: [
      { id: "cal-a", title: "Lorem calendar", writable: true },
      { id: "cal-b", title: "Ipsum calendar", writable: true },
    ],
  }
  const eventOf = (
    id: string,
    calendarId: string
  ): GateAppleEventList["events"][number] => ({
    id,
    calendarId,
    title: `Title ${id}`,
    start: "2030-03-01T09:00:00Z",
    end: "2030-03-01T10:00:00Z",
    allDay: false,
    location: "",
    notes: "",
    modifiedAt: "2030-02-28T10:00:00Z",
  })

  function sync(
    selection: Parameters<typeof syncAppleCalendars>[0]["selection"],
    listed: GateAppleCalendarList = CALENDARS
  ): Promise<unknown> {
    return syncAppleCalendars({
      db,
      client: {
        listCalendars: () => Promise.resolve(listed),
        listEvents: ({ calendarId }) =>
          Promise.resolve({
            events:
              calendarId === "cal-a"
                ? [eventOf("a-1", "cal-a")]
                : [eventOf("b-1", "cal-b")],
          }),
      },
      entities: {
        entityForAccount: () => Promise.resolve(null),
        getDefaultEntityId: () => Promise.resolve(fixture.company.id),
      },
      selection,
      now: () => now,
    })
  }

  test("events of every synced calendar are listed", async () => {
    await sync({ kind: "all" })
    expect(ids(await today())).toEqual(["a-1", "b-1"])
  })

  test("a calendar left out of the selection disappears after the next sync", async () => {
    await sync({ kind: "all" })
    await sync({ kind: "ids", ids: ["cal-a"] })
    expect(ids(await today())).toEqual(["a-1"])
  })

  test("a calendar the Helper stops listing disappears once it has been missing long enough", async () => {
    await sync({ kind: "all" })
    const [first] = CALENDARS.calendars
    if (first === undefined) throw new Error("fixture has no calendar")
    for (let run = 0; run < MISSING_RUNS_BEFORE_RETIRE; run++) {
      await sync({ kind: "all" }, { calendars: [first] })
    }
    expect(ids(await today())).toEqual(["a-1"])
  })
})
