import { mkdtempSync, rmSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { describe, expect, test } from "vitest"
import { createAppleClient } from "@eido/gate"
import type { AppleClient } from "@eido/gate"
import type { GateAppleCalendarList, GateAppleEventList } from "@eido/schemas"
import { openDataDb } from "../../ledger/db"
import { LIVE_DOCUMENT_PREDICATE } from "../../index/heads"
import type { IngestEntities } from "../ingest-entity"
import {
  APPLE_CALENDAR_CONNECTOR,
  CALENDAR_EVENT_MIME,
  appleEventSourceRef,
  isAppleEventId,
  syncAppleCalendars,
} from "./sync"
import type { AppleCalendarSyncOptions } from "./sync"

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

  test("a successful snapshot retires only its own calendar's missing events inside the window", async () => {
    const db = setupDb()
    const events: Record<string, AppleEvent[]> = {
      "cal-synthetic-a": [
        event({ id: "gone" }),
        event({ id: "kept" }),
        // Starts before the window the next run reads: not provably gone from that snapshot.
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
    events["cal-synthetic-b"] = []
    const result = await syncAppleCalendars(
      options(db, client, {
        selection: { kind: "ids", ids: ["cal-synthetic-a"] },
      })
    )

    expect(result.calendars).toEqual([
      {
        calendarId: "cal-synthetic-a",
        status: "synced",
        fetched: 1,
        ingested: 0,
        retired: 1,
        skipped: 0,
        dropped: 0,
      },
    ])
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
      { calendarId: "cal-not-listed", status: "missing" },
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
