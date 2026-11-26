import { mkdtempSync, rmSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, test } from "vitest"
import { createAppleClient } from "@eido/gate"
import type { AppleClient } from "@eido/gate"
import type { GateAppleCalendarList, GateAppleEventList } from "@eido/schemas"
import { openDataDb } from "../../ledger/db"
import { LIVE_DOCUMENT_PREDICATE } from "../../index/heads"
import { ingestBatch } from "../../index/index"
import { MIGRATIONS } from "../../index/schema"
import type { IngestEntities } from "../ingest-entity"
import {
  APPLE_CALENDAR_CONNECTOR,
  CALENDAR_EVENT_MIME,
  appleEventDetails,
  appleEventFlags,
  appleEventSourceRef,
  isAppleEventId,
  syncAppleCalendars,
} from "./sync"
import type { AppleCalendarRun, AppleCalendarSyncOptions } from "./sync"

// Synthetic calendars and events only: ids, titles and times are invented.

type AppleEvent = GateAppleEventList["events"][number]

const NOW = new Date("2026-12-01T12:00:00.000Z")
const WINDOW = {
  start: "2026-11-17T12:00:00.000Z",
  end: "2027-05-30T12:00:00.000Z",
}

function setupDb(): DatabaseSync {
  const db = openDataDb(":memory:")
  db.prepare(
    `INSERT INTO entities (id, kind, name, tag, created_at)
     VALUES ('entity-work', 'company', 'Lorem Co', 'work', datetime('now')),
            ('entity-default', 'personal', 'Ipsum', 'default', datetime('now'))`
  ).run()
  return db
}

function event(overrides: Partial<AppleEvent> = {}): AppleEvent {
  return {
    id: "evt-1",
    calendarId: "cal-synthetic-a",
    title: "Lorem standup",
    start: "2026-12-02T09:00:00Z",
    end: "2026-12-02T09:30:00Z",
    allDay: false,
    location: "Room ipsum",
    notes: "Dolor sit amet",
    modifiedAt: "2026-11-30T10:00:00Z",
    hasAttendees: false,
    recurring: false,
    ...overrides,
  }
}

const CALENDARS: GateAppleCalendarList = {
  calendars: [
    { id: "cal-synthetic-a", title: "Synthetic A", writable: true },
    { id: "cal-synthetic-b", title: "Synthetic B", writable: true },
  ],
}

type FakeClient = Pick<AppleClient, "listCalendars" | "listEvents"> & {
  reads: { calendarId: string; start: string; end: string }[]
}

/** A fake gate read client: each calendar answers with its events or reply, or throws its error. */
function fakeClient(
  events: Record<string, AppleEvent[] | GateAppleEventList | Error>,
  calendars: GateAppleCalendarList = CALENDARS
): FakeClient {
  const reads: FakeClient["reads"] = []
  return {
    reads,
    listCalendars: () => Promise.resolve(calendars),
    listEvents: (args) => {
      reads.push(args)
      const answer = events[args.calendarId] ?? []
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(
        Array.isArray(answer) ? { events: answer } : answer
      )
    },
  }
}

const defaultOnly: IngestEntities = {
  entityForAccount: () => Promise.resolve(null),
  getDefaultEntityId: () => Promise.resolve("entity-default"),
}

function options(
  db: DatabaseSync,
  client: FakeClient,
  overrides: Partial<AppleCalendarSyncOptions> = {}
): AppleCalendarSyncOptions {
  return {
    db,
    client,
    entities: defaultOnly,
    selection: { kind: "all" },
    now: () => NOW,
    ...overrides,
  }
}

function liveRefs(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT d.source_ref FROM documents d
       WHERE d.source = ? AND ${LIVE_DOCUMENT_PREDICATE}
       ORDER BY d.source_ref`
    )
    .all(APPLE_CALENDAR_CONNECTOR)
    .map((row) => String(row["source_ref"]))
}

function documentCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM documents WHERE source = ?")
    .get(APPLE_CALENDAR_CONNECTOR)
  return Number(row?.["n"])
}

describe("syncAppleCalendars", () => {
  test("indexes an event with source, calendar, id, title, times, entity and source link", async () => {
    const db = setupDb()
    const client = fakeClient({ "cal-synthetic-a": [event()] })
    const entities: IngestEntities = {
      entityForAccount: (connector, ref) =>
        Promise.resolve(
          connector === "apple-eventkit" && ref === "cal-synthetic-a"
            ? {
                id: "entity-work",
                kind: "company",
                name: "Lorem Co",
                tag: "work",
                createdAt: "2026-01-01T00:00:00Z",
              }
            : null
        ),
      getDefaultEntityId: () => Promise.resolve("entity-default"),
    }

    const result = await syncAppleCalendars(options(db, client, { entities }))

    expect(result.calendars).toEqual([
      {
        calendarId: "cal-synthetic-a",
        status: "synced",
        fetched: 1,
        ingested: 1,
        retired: 0,
        skipped: 0,
        dropped: 0,
      },
      {
        calendarId: "cal-synthetic-b",
        status: "synced",
        fetched: 0,
        ingested: 0,
        retired: 0,
        skipped: 0,
        dropped: 0,
      },
    ])
    expect(client.reads).toEqual([
      { calendarId: "cal-synthetic-a", ...WINDOW },
      { calendarId: "cal-synthetic-b", ...WINDOW },
    ])
    const doc = db
      .prepare(
        `SELECT d.source, d.source_ref, d.mime, d.entity_id, t.title, t.body, t.occurred_at,
                f.calendar_id, f.event_id, f.start_at, f.end_at, f.all_day
         FROM documents d
         JOIN document_text t ON t.sha256 = d.sha256
         JOIN calendar_event_facts f ON f.sha256 = d.sha256`
      )
      .get()
    expect(doc).toEqual({
      source: "apple-eventkit",
      source_ref: "apple-eventkit://calendar/cal-synthetic-a/event/evt-1",
      mime: CALENDAR_EVENT_MIME,
      entity_id: "entity-work",
      title: "Lorem standup",
      body: "Lorem standup\n\nRoom ipsum\n\nDolor sit amet",
      occurred_at: "2026-12-02T09:00:00Z",
      calendar_id: "cal-synthetic-a",
      event_id: "evt-1",
      start_at: "2026-12-02T09:00:00Z",
      end_at: "2026-12-02T09:30:00Z",
      all_day: 0,
    })
  })

  test("falls back to the default entity and records an all-day event", async () => {
    const db = setupDb()
    const client = fakeClient({
      "cal-synthetic-a": [
        event({
          title: "",
          allDay: true,
          start: "2026-12-03T00:00:00Z",
          end: "2026-12-04T00:00:00Z",
          location: null,
          notes: null,
        }),
      ],
    })

    await syncAppleCalendars(options(db, client))

    expect(
      db
        .prepare(
          `SELECT d.entity_id, t.title, t.body, f.all_day
           FROM documents d
           JOIN document_text t ON t.sha256 = d.sha256
           JOIN calendar_event_facts f ON f.sha256 = d.sha256`
        )
        .get()
    ).toEqual({
      entity_id: "entity-default",
      title: null,
      body: "",
      all_day: 1,
    })
  })

  test("an identical re-read adds no version; a changed event replaces its head", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = {
      "cal-synthetic-a": [event()],
    }
    const client = fakeClient(events)

    await syncAppleCalendars(options(db, client))
    const again = await syncAppleCalendars(options(db, client))
    expect(again.calendars[0]).toMatchObject({ fetched: 1, ingested: 0 })
    expect(documentCount(db)).toBe(1)

    events["cal-synthetic-a"] = [
      event({
        title: "Lorem standup moved",
        start: "2026-12-02T10:00:00Z",
        end: "2026-12-02T10:30:00Z",
      }),
    ]
    const changed = await syncAppleCalendars(options(db, client))
    expect(changed.calendars[0]).toMatchObject({ ingested: 1, retired: 0 })
    expect(documentCount(db)).toBe(2)
    const live = db
      .prepare(
        `SELECT t.title FROM documents d
         JOIN document_text t ON t.sha256 = d.sha256
         WHERE d.source = 'apple-eventkit' AND ${LIVE_DOCUMENT_PREDICATE}`
      )
      .all()
    expect(live).toEqual([{ title: "Lorem standup moved" }])
  })

  test("a successful snapshot retires only its own calendar's events that overlap the window and are missing", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[] | Error> = {
      "cal-synthetic-a": [
        event({ id: "gone" }),
        event({ id: "kept" }),
        // Ended before the window the next run reads: past, kept as history.
        event({
          id: "before-window",
          start: "2026-11-01T09:00:00Z",
          end: "2026-11-01T10:00:00Z",
        }),
      ],
      "cal-synthetic-b": [
        event({ id: "other", calendarId: "cal-synthetic-b" }),
      ],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(
      options(db, client, { now: () => new Date("2026-10-20T12:00:00Z") })
    )

    events["cal-synthetic-a"] = [event({ id: "kept" })]
    // The other calendar's read fails, so only calendar A's snapshot reconciles anything.
    events["cal-synthetic-b"] = new Error("gate unavailable")
    const result = await syncAppleCalendars(options(db, client))

    expect(result.calendars[0]).toEqual({
      calendarId: "cal-synthetic-a",
      status: "synced",
      fetched: 1,
      ingested: 0,
      retired: 1,
      skipped: 0,
      dropped: 0,
    })
    expect(liveRefs(db)).toEqual([
      appleEventSourceRef("cal-synthetic-a", "before-window"),
      appleEventSourceRef("cal-synthetic-a", "kept"),
      appleEventSourceRef("cal-synthetic-b", "other"),
    ])
  })

  test("a failed read leaves the calendar's heads intact and other calendars still sync", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[] | Error> = {
      "cal-synthetic-a": [event()],
      "cal-synthetic-b": [event({ id: "b-1", calendarId: "cal-synthetic-b" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events["cal-synthetic-a"] = new Error("gate unavailable")
    events["cal-synthetic-b"] = []
    const result = await syncAppleCalendars(options(db, client))

    expect(result.calendars).toEqual([
      {
        calendarId: "cal-synthetic-a",
        status: "failed",
        reason: "read_failed",
      },
      {
        calendarId: "cal-synthetic-b",
        status: "synced",
        fetched: 0,
        ingested: 0,
        retired: 1,
        skipped: 0,
        dropped: 0,
      },
    ])
    expect(liveRefs(db)).toEqual([
      appleEventSourceRef("cal-synthetic-a", "evt-1"),
    ])
  })

  test("a read that reports skipped items indexes what it returned and retires nothing", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[] | GateAppleEventList> = {
      "cal-synthetic-a": [event({ id: "unreadable" }), event({ id: "kept" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events["cal-synthetic-a"] = {
      events: [event({ id: "kept" }), event({ id: "new" })],
      skipped: 1,
    }
    const result = await syncAppleCalendars(
      options(db, client, {
        selection: { kind: "ids", ids: ["cal-synthetic-a"] },
      })
    )

    expect(result.calendars).toEqual([
      {
        calendarId: "cal-synthetic-a",
        status: "synced",
        fetched: 2,
        ingested: 1,
        retired: 0,
        skipped: 1,
        dropped: 0,
      },
    ])
    expect(liveRefs(db)).toEqual([
      appleEventSourceRef("cal-synthetic-a", "kept"),
      appleEventSourceRef("cal-synthetic-a", "new"),
      appleEventSourceRef("cal-synthetic-a", "unreadable"),
    ])
  })

  test("a read that reports zero skipped items is a whole snapshot", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[] | GateAppleEventList> = {
      "cal-synthetic-a": [event({ id: "gone" }), event({ id: "kept" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events["cal-synthetic-a"] = { events: [event({ id: "kept" })], skipped: 0 }
    const result = await syncAppleCalendars(
      options(db, client, {
        selection: { kind: "ids", ids: ["cal-synthetic-a"] },
      })
    )

    expect(result.calendars[0]).toMatchObject({ retired: 1, skipped: 0 })
    expect(liveRefs(db)).toEqual([
      appleEventSourceRef("cal-synthetic-a", "kept"),
    ])
  })

  test("a skipped count in the gate's reply, parsed by the real gate client, retires nothing", async () => {
    const db = setupDb()
    let reply: unknown = {
      events: [event({ id: "unreadable" }), event({ id: "kept" })],
      skipped: 0,
    }
    const server = createHttpServer((request, response) => {
      const body = (request.url ?? "").startsWith("/apple/calendars")
        ? { calendars: CALENDARS.calendars.slice(0, 1) }
        : reply
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    })
    const dir = mkdtempSync(join(tmpdir(), "eido-apple-sync-"))
    const socketPath = join(dir, "gate.sock")
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      const client = createAppleClient({ socketPath })
      const run = () =>
        syncAppleCalendars({
          db,
          client,
          entities: defaultOnly,
          selection: { kind: "all" },
          now: () => NOW,
        })
      await run()
      reply = { events: [event({ id: "kept" })], skipped: 1 }
      const result = await run()

      expect(result.calendars[0]).toMatchObject({ retired: 0, skipped: 1 })
      expect(liveRefs(db)).toEqual([
        appleEventSourceRef("cal-synthetic-a", "kept"),
        appleEventSourceRef("cal-synthetic-a", "unreadable"),
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an event moved within the window keeps its id and is re-indexed with its new time", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = {
      "cal-synthetic-a": [event({ id: "moved" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events["cal-synthetic-a"] = [
      event({
        id: "moved",
        start: "2027-01-10T15:00:00Z",
        end: "2027-01-10T16:00:00Z",
        modifiedAt: "2026-12-01T08:00:00Z",
      }),
    ]
    const result = await syncAppleCalendars(options(db, client))

    expect(result.calendars[0]).toMatchObject({ ingested: 1, retired: 0 })
    expect(liveRefs(db)).toEqual([
      appleEventSourceRef("cal-synthetic-a", "moved"),
    ])
    const live = db
      .prepare(
        `SELECT t.occurred_at FROM document_heads h
         JOIN document_text t ON t.sha256 = h.sha256
         WHERE h.source = ?`
      )
      .all(APPLE_CALENDAR_CONNECTOR)
    expect(live.map((row) => row["occurred_at"])).toEqual([
      "2027-01-10T15:00:00Z",
    ])
  })

  test("an event moved out of the window is retired, and indexed again with its new time once the window reaches it", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = {
      "cal-synthetic-a": [event({ id: "moved" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    // Moved to 2027-07-01, past the window's end (2027-05-30): the read no longer returns it.
    const later = event({
      id: "moved",
      start: "2027-07-01T09:00:00Z",
      end: "2027-07-01T09:30:00Z",
      modifiedAt: "2026-12-01T08:00:00Z",
    })
    events["cal-synthetic-a"] = []
    const moved = await syncAppleCalendars(options(db, client))
    expect(moved.calendars[0]).toMatchObject({ retired: 1 })
    expect(liveRefs(db)).toEqual([])

    events["cal-synthetic-a"] = [later]
    const reached = await syncAppleCalendars(
      options(db, client, { now: () => new Date("2027-02-01T12:00:00Z") })
    )
    expect(reached.calendars[0]).toMatchObject({ ingested: 1 })
    expect(liveRefs(db)).toEqual([
      appleEventSourceRef("cal-synthetic-a", "moved"),
    ])
  })

  test.each([
    [
      "an event of another calendar",
      [event({ calendarId: "cal-synthetic-b" })],
      1,
    ],
    [
      "a repeated event id",
      [event({ title: "Lorem one" }), event({ title: "Lorem two" })],
      2,
    ],
    ["an id too long to cite", [event({ id: "x".repeat(480) })], 1],
  ])(
    "a read with %s drops it, indexes the rest and retires nothing",
    async (_name, bad, dropped) => {
      const db = setupDb()
      const events: Record<string, AppleEvent[]> = {
        "cal-synthetic-a": [event({ id: "existing" })],
      }
      const client = fakeClient(events)
      await syncAppleCalendars(options(db, client))

      events["cal-synthetic-a"] = [...bad, event({ id: "good" })]
      const result = await syncAppleCalendars(
        options(db, client, {
          selection: { kind: "ids", ids: ["cal-synthetic-a"] },
        })
      )

      expect(result.calendars).toEqual([
        {
          calendarId: "cal-synthetic-a",
          status: "synced",
          fetched: bad.length + 1,
          ingested: 1,
          retired: 0,
          skipped: 0,
          dropped,
        },
      ])
      expect(liveRefs(db)).toEqual([
        appleEventSourceRef("cal-synthetic-a", "existing"),
        appleEventSourceRef("cal-synthetic-a", "good"),
      ])
    }
  )

  test("with no assigned or default entity nothing is read", async () => {
    const db = setupDb()
    const client = fakeClient({ "cal-synthetic-a": [event()] })
    const result = await syncAppleCalendars(
      options(db, client, {
        selection: { kind: "ids", ids: ["cal-synthetic-a"] },
        entities: {
          entityForAccount: () => Promise.resolve(null),
          getDefaultEntityId: () => Promise.resolve(null),
        },
      })
    )
    expect(result.calendars).toEqual([
      {
        calendarId: "cal-synthetic-a",
        status: "failed",
        reason: "entity_required",
      },
    ])
    expect(client.reads).toEqual([])
    expect(documentCount(db)).toBe(0)
  })

  test("an enabled calendar the Helper does not list is missing, and only enabled calendars are reported", async () => {
    const db = setupDb()
    const client = fakeClient({})
    const seen: { id: string; title: string }[] = []
    const result = await syncAppleCalendars(
      options(db, client, {
        selection: { kind: "ids", ids: ["cal-synthetic-b", "cal-not-listed"] },
        onCalendar: (calendar) => seen.push(calendar),
      })
    )
    expect(result.calendars).toEqual([
      {
        calendarId: "cal-synthetic-b",
        status: "synced",
        fetched: 0,
        ingested: 0,
        retired: 0,
        skipped: 0,
        dropped: 0,
      },
      {
        calendarId: "cal-not-listed",
        status: "missing",
        missedRuns: 0,
        retired: 0,
      },
    ])
    expect(client.reads.map((read) => read.calendarId)).toEqual([
      "cal-synthetic-b",
    ])
    expect(seen).toEqual([{ id: "cal-synthetic-b", title: "Synthetic B" }])
  })

  test("recurring occurrences keep distinct identities that are stable across reads", async () => {
    const db = setupDb()
    const first = "recurrence:series-1:2026-12-07T09:00:00Z"
    const second = "recurrence:series-1:2026-12-14T09:00:00Z"
    const client = fakeClient({
      "cal-synthetic-a": [
        event({
          id: first,
          start: "2026-12-07T09:00:00Z",
          end: "2026-12-07T09:30:00Z",
        }),
        event({
          id: second,
          start: "2026-12-14T09:00:00Z",
          end: "2026-12-14T09:30:00Z",
        }),
      ],
    })

    await syncAppleCalendars(options(db, client))
    const again = await syncAppleCalendars(options(db, client))

    expect(again.calendars[0]).toMatchObject({
      fetched: 2,
      ingested: 0,
      retired: 0,
    })
    expect(liveRefs(db)).toEqual([
      "apple-eventkit://calendar/cal-synthetic-a/event/recurrence%3Aseries-1%3A2026-12-07T09%3A00%3A00Z",
      "apple-eventkit://calendar/cal-synthetic-a/event/recurrence%3Aseries-1%3A2026-12-14T09%3A00%3A00Z",
    ])
    expect(isAppleEventId(db, first)).toBe(true)
    expect(isAppleEventId(db, second)).toBe(true)
    expect(isAppleEventId(db, "recurrence:series-1:2026-12-21T09:00:00Z")).toBe(
      false
    )
  })

  describe("events that overlap the window edges", () => {
    // The window of a run at NOW is 2026-11-17T12:00Z to 2027-05-30T12:00Z.
    const straddlesStart = {
      start: "2026-11-16T09:00:00Z",
      end: "2026-11-18T09:00:00Z",
    }
    const straddlesEnd = {
      start: "2027-05-29T09:00:00Z",
      end: "2027-05-31T09:00:00Z",
    }
    const selectA = { kind: "ids", ids: ["cal-synthetic-a"] } as const

    test("an event straddling the window start is retired when a whole read lacks it, and kept while the read returns it", async () => {
      const db = setupDb()
      const events: Record<string, AppleEvent[]> = {
        "cal-synthetic-a": [
          event({ id: "deleted", ...straddlesStart }),
          event({ id: "present", ...straddlesStart }),
        ],
      }
      const client = fakeClient(events)
      await syncAppleCalendars(
        options(db, client, {
          selection: selectA,
          now: () => new Date("2026-11-10T12:00:00Z"),
        })
      )

      events["cal-synthetic-a"] = [event({ id: "present", ...straddlesStart })]
      const result = await syncAppleCalendars(
        options(db, client, { selection: selectA })
      )

      expect(result.calendars[0]).toMatchObject({
        status: "synced",
        ingested: 0,
        retired: 1,
      })
      expect(liveRefs(db)).toEqual([
        appleEventSourceRef("cal-synthetic-a", "present"),
      ])
    })

    test("an event straddling the window end is retired when a whole read lacks it", async () => {
      const db = setupDb()
      const events: Record<string, AppleEvent[]> = {
        "cal-synthetic-a": [event({ id: "long", ...straddlesEnd })],
      }
      const client = fakeClient(events)
      await syncAppleCalendars(options(db, client, { selection: selectA }))

      events["cal-synthetic-a"] = []
      const result = await syncAppleCalendars(
        options(db, client, { selection: selectA })
      )

      expect(result.calendars[0]).toMatchObject({ retired: 1 })
      expect(liveRefs(db)).toEqual([])
    })

    test("an event that ended before the window start is kept as history, however old", async () => {
      const db = setupDb()
      const events: Record<string, AppleEvent[]> = {
        "cal-synthetic-a": [
          event({
            id: "old",
            start: "2026-11-10T09:00:00Z",
            end: "2026-11-10T10:00:00Z",
          }),
          // Ends exactly at the window start: a read of that window need not return it.
          event({
            id: "edge",
            start: "2026-11-17T11:00:00Z",
            end: "2026-11-17T12:00:00Z",
          }),
        ],
      }
      const client = fakeClient(events)
      await syncAppleCalendars(
        options(db, client, {
          selection: selectA,
          now: () => new Date("2026-11-10T12:00:00Z"),
        })
      )

      events["cal-synthetic-a"] = []
      const result = await syncAppleCalendars(
        options(db, client, { selection: selectA })
      )

      expect(result.calendars[0]).toMatchObject({ retired: 0 })
      expect(liveRefs(db)).toEqual([
        appleEventSourceRef("cal-synthetic-a", "edge"),
        appleEventSourceRef("cal-synthetic-a", "old"),
      ])
    })

    test("a read that reports skipped items retires no straddling event", async () => {
      const db = setupDb()
      const events: Record<string, AppleEvent[] | GateAppleEventList> = {
        "cal-synthetic-a": [
          event({ id: "start-edge", ...straddlesStart }),
          event({ id: "end-edge", ...straddlesEnd }),
        ],
      }
      const client = fakeClient(events)
      await syncAppleCalendars(
        options(db, client, {
          selection: selectA,
          now: () => new Date("2026-11-10T12:00:00Z"),
        })
      )

      events["cal-synthetic-a"] = { events: [], skipped: 1 }
      const result = await syncAppleCalendars(
        options(db, client, { selection: selectA })
      )

      expect(result.calendars[0]).toMatchObject({ retired: 0, skipped: 1 })
      expect(liveRefs(db)).toEqual([
        appleEventSourceRef("cal-synthetic-a", "end-edge"),
        appleEventSourceRef("cal-synthetic-a", "start-edge"),
      ])
    })

    test("a read that fails retires no straddling event", async () => {
      const db = setupDb()
      const events: Record<string, AppleEvent[] | Error> = {
        "cal-synthetic-a": [event({ id: "edge", ...straddlesStart })],
      }
      const client = fakeClient(events)
      await syncAppleCalendars(
        options(db, client, {
          selection: selectA,
          now: () => new Date("2026-11-10T12:00:00Z"),
        })
      )

      events["cal-synthetic-a"] = new Error("gate unavailable")
      await syncAppleCalendars(options(db, client, { selection: selectA }))

      expect(liveRefs(db)).toEqual([
        appleEventSourceRef("cal-synthetic-a", "edge"),
      ])
    })
  })

  describe("calendars that are no longer read", () => {
    const onlyA: GateAppleCalendarList = {
      calendars: [CALENDARS.calendars[0]!],
    }
    const bothCalendars = (): Record<string, AppleEvent[]> => ({
      "cal-synthetic-a": [event({ id: "a-1" })],
      "cal-synthetic-b": [
        event({ id: "b-1", calendarId: "cal-synthetic-b" }),
        // Past, outside the window: still retired with its calendar.
        event({
          id: "b-old",
          calendarId: "cal-synthetic-b",
          start: "2026-10-01T09:00:00Z",
          end: "2026-10-01T10:00:00Z",
        }),
      ],
    })
    const liveFor = (calendarId: string, ids: string[]) =>
      ids.map((id) => appleEventSourceRef(calendarId, id))

    test("a calendar EIDO_APPLE_CALENDARS no longer names is retired at once, with all its events", async () => {
      const db = setupDb()
      const client = fakeClient(bothCalendars())
      await syncAppleCalendars(
        options(db, client, { now: () => new Date("2026-10-02T12:00:00Z") })
      )
      expect(liveRefs(db)).toHaveLength(3)

      const result = await syncAppleCalendars(
        options(db, client, {
          selection: { kind: "ids", ids: ["cal-synthetic-a"] },
        })
      )

      expect(result.disabled).toEqual([
        { calendarId: "cal-synthetic-b", retired: 2 },
      ])
      expect(liveRefs(db)).toEqual(liveFor("cal-synthetic-a", ["a-1"]))
      // The calendar is no longer read at all.
      expect(client.reads.map((read) => read.calendarId).slice(-1)).toEqual([
        "cal-synthetic-a",
      ])
    })

    test("a calendar with nothing indexed is not reported as disabled, and retiring twice does nothing", async () => {
      const db = setupDb()
      const client = fakeClient(bothCalendars())
      await syncAppleCalendars(
        options(db, client, { now: () => new Date("2026-10-02T12:00:00Z") })
      )
      const narrowed = options(db, client, {
        selection: { kind: "ids", ids: ["cal-synthetic-a"] },
      })
      await syncAppleCalendars(narrowed)

      const again = await syncAppleCalendars(narrowed)

      expect(again.disabled).toEqual([])
    })

    test("a calendar the Helper stops listing is kept for eleven runs and retired on the twelfth", async () => {
      const db = setupDb()
      const events = bothCalendars()
      let calendars = CALENDARS
      const client: FakeClient = {
        ...fakeClient(events),
        listCalendars: () => Promise.resolve(calendars),
      }
      await syncAppleCalendars(
        options(db, client, { now: () => new Date("2026-10-02T12:00:00Z") })
      )

      calendars = onlyA
      const runs = []
      for (let run = 1; run <= 12; run++) {
        const result = await syncAppleCalendars(options(db, client))
        runs.push(result.calendars.find((c) => c.status === "missing"))
        if (run === 11)
          expect(liveRefs(db)).toEqual([
            ...liveFor("cal-synthetic-a", ["a-1"]),
            ...liveFor("cal-synthetic-b", ["b-1", "b-old"]),
          ])
      }

      expect(runs[10]).toEqual({
        calendarId: "cal-synthetic-b",
        status: "missing",
        missedRuns: 11,
        retired: 0,
      })
      expect(runs[11]).toEqual({
        calendarId: "cal-synthetic-b",
        status: "missing",
        missedRuns: 12,
        retired: 2,
      })
      expect(liveRefs(db)).toEqual(liveFor("cal-synthetic-a", ["a-1"]))
    })

    test("a calendar listed again starts the count over", async () => {
      const db = setupDb()
      const events = bothCalendars()
      let calendars = CALENDARS
      const client: FakeClient = {
        ...fakeClient(events),
        listCalendars: () => Promise.resolve(calendars),
      }
      await syncAppleCalendars(
        options(db, client, { now: () => new Date("2026-10-02T12:00:00Z") })
      )

      for (let cycle = 0; cycle < 2; cycle++) {
        calendars = onlyA
        for (let run = 0; run < 11; run++)
          await syncAppleCalendars(options(db, client))
        calendars = CALENDARS
        await syncAppleCalendars(options(db, client))
      }
      calendars = onlyA
      const next = await syncAppleCalendars(options(db, client))

      expect(next.calendars.find((c) => c.status === "missing")).toMatchObject({
        missedRuns: 1,
        retired: 0,
      })
      expect(liveRefs(db)).toHaveLength(3)
    })

    test("an enabled id the Helper stops listing is retired after the same twelve runs", async () => {
      const db = setupDb()
      const events = bothCalendars()
      let calendars = CALENDARS
      const client: FakeClient = {
        ...fakeClient(events),
        listCalendars: () => Promise.resolve(calendars),
      }
      const both = {
        selection: {
          kind: "ids",
          ids: ["cal-synthetic-a", "cal-synthetic-b"],
        },
      } as const
      await syncAppleCalendars(
        options(db, client, {
          ...both,
          now: () => new Date("2026-10-02T12:00:00Z"),
        })
      )

      calendars = onlyA
      let last: AppleCalendarRun | undefined
      for (let run = 0; run < 12; run++) {
        const result = await syncAppleCalendars(options(db, client, both))
        last = result.calendars.find((c) => c.status === "missing")
      }

      expect(last).toMatchObject({ missedRuns: 12, retired: 2 })
      expect(liveRefs(db)).toEqual(liveFor("cal-synthetic-a", ["a-1"]))
    })

    test("a failed calendar listing, as a revoked Calendar permission gives, retires nothing and does not count", async () => {
      const db = setupDb()
      const events = bothCalendars()
      let calendars: GateAppleCalendarList | Error = CALENDARS
      const client: FakeClient = {
        ...fakeClient(events),
        listCalendars: () =>
          calendars instanceof Error
            ? Promise.reject(calendars)
            : Promise.resolve(calendars),
      }
      await syncAppleCalendars(
        options(db, client, { now: () => new Date("2026-10-02T12:00:00Z") })
      )
      calendars = onlyA
      for (let run = 0; run < 11; run++)
        await syncAppleCalendars(options(db, client))

      calendars = new Error("calendar permission denied")
      for (let run = 0; run < 3; run++)
        await expect(syncAppleCalendars(options(db, client))).rejects.toThrow(
          "calendar permission denied"
        )
      expect(liveRefs(db)).toHaveLength(3)

      // The failed runs were not missing runs: the twelfth listing run is the one that retires.
      calendars = onlyA
      const next = await syncAppleCalendars(options(db, client))
      expect(next.calendars.find((c) => c.status === "missing")).toMatchObject({
        missedRuns: 12,
        retired: 2,
      })
    })

    test("a failed read of a listed calendar leaves its events and does not count it missing", async () => {
      const db = setupDb()
      const events: Record<string, AppleEvent[] | Error> = bothCalendars()
      const client = fakeClient(events)
      await syncAppleCalendars(
        options(db, client, { now: () => new Date("2026-10-02T12:00:00Z") })
      )

      events["cal-synthetic-b"] = new Error("gate unavailable")
      const result = await syncAppleCalendars(options(db, client))

      expect(result.calendars[1]).toEqual({
        calendarId: "cal-synthetic-b",
        status: "failed",
        reason: "read_failed",
      })
      expect(result.disabled).toEqual([])
      expect(liveRefs(db)).toHaveLength(3)
    })
  })

  test("a calendar list failure propagates", async () => {
    const db = setupDb()
    const client: FakeClient = {
      reads: [],
      listCalendars: () => Promise.reject(new Error("helper unavailable")),
      listEvents: () => Promise.resolve({ events: [] }),
    }
    await expect(syncAppleCalendars(options(db, client))).rejects.toThrow(
      "helper unavailable"
    )
  })
})

describe("Apple event location and notes", () => {
  const CAL = "cal-synthetic-a"

  test("a synced event's location and notes are read back separately, keeping empty and absent apart", async () => {
    const db = setupDb()
    const client = fakeClient({
      [CAL]: [
        event({ id: "both", location: "Room ipsum", notes: "Dolor sit amet" }),
        event({ id: "empty", location: "", notes: "" }),
        event({ id: "absent", location: null, notes: null }),
        event({ id: "mixed", location: null, notes: "Only notes" }),
      ],
    })

    await syncAppleCalendars(options(db, client))

    expect(appleEventDetails(db, CAL, "both")).toEqual({
      known: true,
      location: "Room ipsum",
      notes: "Dolor sit amet",
    })
    expect(appleEventDetails(db, CAL, "empty")).toEqual({
      known: true,
      location: "",
      notes: "",
    })
    expect(appleEventDetails(db, CAL, "absent")).toEqual({
      known: true,
      location: null,
      notes: null,
    })
    expect(appleEventDetails(db, CAL, "mixed")).toEqual({
      known: true,
      location: null,
      notes: "Only notes",
    })
  })

  test("an event that is not indexed, or was retired, has no details", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = { [CAL]: [event()] }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))
    expect(appleEventDetails(db, CAL, "never-seen")).toBeNull()

    events[CAL] = []
    await syncAppleCalendars(options(db, client))
    expect(appleEventDetails(db, CAL, "evt-1")).toBeNull()
  })

  test("an edit to the notes indexes a new version and the head reads the new value", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = {
      [CAL]: [event({ location: "Room ipsum", notes: "first" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events[CAL] = [
      event({
        location: "Room ipsum",
        notes: "second",
        modifiedAt: "2026-11-30T11:00:00Z",
      }),
    ]
    await syncAppleCalendars(options(db, client))

    expect(appleEventDetails(db, CAL, "evt-1")).toEqual({
      known: true,
      location: "Room ipsum",
      notes: "second",
    })
  })

  test("a known fact row cannot be rewritten, and an unknown one can change nothing but its details", async () => {
    const db = setupDb()
    await syncAppleCalendars(
      options(db, fakeClient({ [CAL]: [event({ location: "Room ipsum" })] }))
    )
    expect(() =>
      db.prepare("UPDATE calendar_event_facts SET location = 'Elsewhere'").run()
    ).toThrow("immutable")
    expect(() =>
      db
        .prepare("UPDATE calendar_event_facts SET start_at = '2030-01-01'")
        .run()
    ).toThrow("immutable")
    expect(() => db.prepare("DELETE FROM calendar_event_facts").run()).toThrow(
      "immutable"
    )
    expect(appleEventDetails(db, CAL, "evt-1")).toMatchObject({
      location: "Room ipsum",
    })
  })

  describe("an event indexed before the migration", () => {
    function tempDir(): string {
      return mkdtempSync(join(tmpdir(), "eido-apple-fields-"))
    }

    /**
     * A database at index schema v15 (no location or notes columns) holding `events` as the sync
     * of that version wrote them: a document, a live head and a fact row each. `digests` are the
     * content digests of the same events, taken from a current sync, so a later sync matches them.
     */
    function databaseAtV15(
      path: string,
      events: readonly AppleEvent[],
      digests: ReadonlyMap<string, string>
    ): void {
      const old = new DatabaseSync(path)
      old.exec("PRAGMA foreign_keys = ON")
      for (const migration of MIGRATIONS.slice(0, 15)) old.exec(migration)
      old.exec("PRAGMA user_version = 15")
      old
        .prepare(
          `INSERT INTO entities (id, kind, name, tag, created_at)
         VALUES ('entity-default', 'personal', 'Ipsum', 'default', datetime('now'))`
        )
        .run()
      for (const e of events) {
        const sha256 = digests.get(e.id) ?? ""
        const sourceRef = appleEventSourceRef(e.calendarId, e.id)
        ingestBatch(old, {
          connector: APPLE_CALENDAR_CONNECTOR,
          stream: `calendar:${e.calendarId}`,
          documents: [
            {
              sha256,
              source: APPLE_CALENDAR_CONNECTOR,
              sourceRef,
              mime: CALENDAR_EVENT_MIME,
              entityId: "entity-default",
              title: e.title,
              body: e.title,
              occurredAt: e.start,
            },
          ],
          heads: [{ source: APPLE_CALENDAR_CONNECTOR, sourceRef, sha256 }],
          nextCursor: "c",
        })
        old
          .prepare(
            `INSERT INTO calendar_event_facts
               (sha256, source, calendar_id, event_id, start_at, end_at, all_day)
             VALUES (?, ?, ?, ?, ?, ?, 0)`
          )
          .run(
            sha256,
            APPLE_CALENDAR_CONNECTOR,
            e.calendarId,
            e.id,
            e.start,
            e.end
          )
      }
      old.close()
    }

    async function digestsOf(
      events: readonly AppleEvent[]
    ): Promise<Map<string, string>> {
      const db = setupDb()
      await syncAppleCalendars(options(db, fakeClient({ [CAL]: [...events] })))
      const rows = db
        .prepare(
          `SELECT f.event_id, f.sha256 FROM calendar_event_facts f ORDER BY f.event_id`
        )
        .all()
      db.close()
      return new Map(
        rows.map((row) => [String(row["event_id"]), String(row["sha256"])])
      )
    }

    test("is reported as unknown after the migration, not as having no location or notes", async () => {
      const events = [event({ id: "old-1" })]
      const dir = tempDir()
      try {
        const path = join(dir, "data.db")
        databaseAtV15(path, events, await digestsOf(events))

        const db = openDataDb(path)

        expect(appleEventDetails(db, CAL, "old-1")).toEqual({ known: false })
        db.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("is filled in by the next sync that reads it, and one the read does not reach stays unknown", async () => {
      const inRead = event({ id: "old-in", location: "Room ipsum", notes: "" })
      const outOfRead = event({ id: "old-out", location: "Hall dolor" })
      const events = [inRead, outOfRead]
      const dir = tempDir()
      try {
        const path = join(dir, "data.db")
        databaseAtV15(path, events, await digestsOf(events))
        const db = openDataDb(path)

        // The Helper returns only `old-in` this time, with its content unchanged, and reports
        // one item it skipped, so the read is partial and retires nothing.
        const result = await syncAppleCalendars(
          options(db, fakeClient({ [CAL]: { events: [inRead], skipped: 1 } }), {
            selection: { kind: "ids", ids: [CAL] },
          })
        )

        expect(result.calendars[0]).toMatchObject({
          status: "synced",
          ingested: 0,
        })
        expect(appleEventDetails(db, CAL, "old-in")).toEqual({
          known: true,
          location: "Room ipsum",
          notes: "",
        })
        expect(appleEventDetails(db, CAL, "old-out")).toEqual({ known: false })
        db.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe("Apple event attendee and recurrence flags", () => {
  const CAL = "cal-synthetic-a"

  test("a synced event stores its two flags independently", async () => {
    const db = setupDb()
    await syncAppleCalendars(
      options(
        db,
        fakeClient({
          [CAL]: [
            event({ id: "plain" }),
            event({ id: "guests", hasAttendees: true }),
            event({ id: "series", recurring: true }),
            event({ id: "both", hasAttendees: true, recurring: true }),
          ],
        })
      )
    )

    expect(appleEventFlags(db, CAL, "plain")).toEqual({
      known: true,
      hasAttendees: false,
      recurring: false,
    })
    expect(appleEventFlags(db, CAL, "guests")).toEqual({
      known: true,
      hasAttendees: true,
      recurring: false,
    })
    expect(appleEventFlags(db, CAL, "series")).toEqual({
      known: true,
      hasAttendees: false,
      recurring: true,
    })
    expect(appleEventFlags(db, CAL, "both")).toEqual({
      known: true,
      hasAttendees: true,
      recurring: true,
    })
  })

  test("an event that is not indexed, or was retired, has no flags", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = { [CAL]: [event()] }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))
    expect(appleEventFlags(db, CAL, "never-seen")).toBeNull()

    events[CAL] = []
    await syncAppleCalendars(options(db, client))
    expect(appleEventFlags(db, CAL, "evt-1")).toBeNull()
  })

  test("a flag that changes with the event's modification time is updated by the next sync", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = { [CAL]: [event()] }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events[CAL] = [
      event({ hasAttendees: true, modifiedAt: "2026-11-30T11:00:00Z" }),
    ]
    const result = await syncAppleCalendars(options(db, client))

    expect(result.calendars[0]).toMatchObject({ ingested: 1 })
    expect(appleEventFlags(db, CAL, "evt-1")).toEqual({
      known: true,
      hasAttendees: true,
      recurring: false,
    })
  })

  test("a flag that changes while the event's content does not is updated and indexes no new version", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = { [CAL]: [event()] }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events[CAL] = [event({ recurring: true })]
    const result = await syncAppleCalendars(options(db, client))
    expect(result.calendars[0]).toMatchObject({ ingested: 0 })
    expect(appleEventFlags(db, CAL, "evt-1")).toEqual({
      known: true,
      hasAttendees: false,
      recurring: true,
    })

    events[CAL] = [event({ recurring: false })]
    await syncAppleCalendars(options(db, client))
    expect(appleEventFlags(db, CAL, "evt-1")).toEqual({
      known: true,
      hasAttendees: false,
      recurring: false,
    })
    expect(
      db.prepare("SELECT count(*) AS n FROM calendar_event_facts").get()
    ).toEqual({ n: 1 })
  })

  test("a changed flag does not unlock the rest of the fact row", async () => {
    const db = setupDb()
    await syncAppleCalendars(options(db, fakeClient({ [CAL]: [event()] })))

    expect(() =>
      db
        .prepare(
          "UPDATE calendar_event_facts SET has_attendees = 1, start_at = '2030-01-01'"
        )
        .run()
    ).toThrow("immutable")
    expect(() =>
      db
        .prepare(
          "UPDATE calendar_event_facts SET recurring = 1, location = 'Elsewhere'"
        )
        .run()
    ).toThrow("immutable")
    expect(appleEventFlags(db, CAL, "evt-1")).toEqual({
      known: true,
      hasAttendees: false,
      recurring: false,
    })
  })

  test("a flag update leaves a known row's location and notes as they are", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = {
      [CAL]: [event({ location: "Room ipsum", notes: "first" })],
    }
    const client = fakeClient(events)
    await syncAppleCalendars(options(db, client))

    events[CAL] = [
      event({ location: "Room ipsum", notes: "first", hasAttendees: true }),
    ]
    await syncAppleCalendars(options(db, client))

    expect(appleEventDetails(db, CAL, "evt-1")).toEqual({
      known: true,
      location: "Room ipsum",
      notes: "first",
    })
  })

  describe("an event indexed before the flags were stored", () => {
    /**
     * A database at index schema v16 (no flag columns) holding `events` as the sync of that
     * version wrote them. `digests` are taken from a current sync, so a later sync matches them.
     */
    function databaseAtV16(
      path: string,
      events: readonly AppleEvent[],
      digests: ReadonlyMap<string, string>
    ): void {
      const old = new DatabaseSync(path)
      old.exec("PRAGMA foreign_keys = ON")
      for (const migration of MIGRATIONS.slice(0, 16)) old.exec(migration)
      old.exec("PRAGMA user_version = 16")
      old
        .prepare(
          `INSERT INTO entities (id, kind, name, tag, created_at)
           VALUES ('entity-default', 'personal', 'Ipsum', 'default', datetime('now'))`
        )
        .run()
      for (const e of events) {
        const sha256 = digests.get(e.id) ?? ""
        const sourceRef = appleEventSourceRef(e.calendarId, e.id)
        ingestBatch(old, {
          connector: APPLE_CALENDAR_CONNECTOR,
          stream: `calendar:${e.calendarId}`,
          documents: [
            {
              sha256,
              source: APPLE_CALENDAR_CONNECTOR,
              sourceRef,
              mime: CALENDAR_EVENT_MIME,
              entityId: "entity-default",
              title: e.title,
              body: e.title,
              occurredAt: e.start,
            },
          ],
          heads: [{ source: APPLE_CALENDAR_CONNECTOR, sourceRef, sha256 }],
          nextCursor: "c",
        })
        old
          .prepare(
            `INSERT INTO calendar_event_facts
               (sha256, source, calendar_id, event_id, start_at, end_at, all_day,
                details_known, location, notes)
             VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`
          )
          .run(
            sha256,
            APPLE_CALENDAR_CONNECTOR,
            e.calendarId,
            e.id,
            e.start,
            e.end,
            e.location,
            e.notes
          )
      }
      old.close()
    }

    async function digestsOf(
      events: readonly AppleEvent[]
    ): Promise<Map<string, string>> {
      const db = setupDb()
      await syncAppleCalendars(options(db, fakeClient({ [CAL]: [...events] })))
      const rows = db
        .prepare("SELECT event_id, sha256 FROM calendar_event_facts")
        .all()
      db.close()
      return new Map(
        rows.map((row) => [String(row["event_id"]), String(row["sha256"])])
      )
    }

    test("has unknown flags after the migration, and the next sync that reads it fills them in", async () => {
      const inRead = event({ id: "old-in", hasAttendees: true })
      const outOfRead = event({ id: "old-out", recurring: true })
      const events = [inRead, outOfRead]
      const dir = mkdtempSync(join(tmpdir(), "eido-apple-flags-"))
      try {
        const path = join(dir, "data.db")
        databaseAtV16(path, events, await digestsOf(events))
        const db = openDataDb(path)
        expect(appleEventFlags(db, CAL, "old-in")).toEqual({ known: false })
        expect(appleEventFlags(db, CAL, "old-out")).toEqual({ known: false })

        // A partial read of `old-in` alone, content unchanged: no new version is indexed.
        const result = await syncAppleCalendars(
          options(db, fakeClient({ [CAL]: { events: [inRead], skipped: 1 } }), {
            selection: { kind: "ids", ids: [CAL] },
          })
        )

        expect(result.calendars[0]).toMatchObject({
          status: "synced",
          ingested: 0,
        })
        expect(appleEventFlags(db, CAL, "old-in")).toEqual({
          known: true,
          hasAttendees: true,
          recurring: false,
        })
        expect(appleEventFlags(db, CAL, "old-out")).toEqual({ known: false })
        db.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
