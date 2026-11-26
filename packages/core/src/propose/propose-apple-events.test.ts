import { afterEach, describe, expect, test } from "vitest"
import { knowEventDetails, WRITABLE } from "../context/apple-event.test-support"
import { indexEvents } from "../context/context.test-support"
import { APPLE_EVENT_UPDATE_NOTE } from "./prompt"
import { proposeIntents } from "./propose"
import { harness, seedNewsletters, type Harness } from "./propose.test-support"

const reply = (intents: unknown[]): string =>
  JSON.stringify({ result: "intents", intents })
const NONE = JSON.stringify({ result: "none", reason: "Lorem ipsum." })

let h: Harness | undefined
let seed = ""
afterEach(async () => {
  await h?.close()
  h = undefined
})

const DENTIST = {
  uid: "apple-dentist",
  title: "Dentist checkup",
  start: "2030-05-01T09:00:00.000Z",
  end: "2030-05-01T10:00:00.000Z",
}

/** The update a model writes for the dentist event moved to the 3rd, location and notes unmentioned. */
const MOVE = {
  kind: "apple.event_update",
  args: {
    id: "apple-dentist",
    calendarId: "cal-1",
    title: "Dentist checkup",
    start: "2030-05-03T09:00:00.000Z",
    end: "2030-05-03T10:00:00.000Z",
    allDay: false,
  },
}

async function setup(
  replies: string[],
  events: Parameters<typeof indexEvents>[1],
  details: Record<
    string,
    { location: string | null; notes: string | null }
  > = {}
) {
  h = await harness({ replies })
  seed = seedNewsletters(h.db)
  indexEvents(h.db, events)
  for (const [uid, d] of Object.entries(details)) knowEventDetails(h.db, uid, d)
  return h
}

async function run(current: Harness, text: string) {
  return proposeIntents({ id: "req-1", text, seed }, current.deps)
}
const prompt = (current: Harness, call = 0): string =>
  current.completions()[call]?.messages.at(-1)?.content ?? ""
const offered = (current: Harness, call = 0): string[] =>
  /Intent kinds offered for this request: (.*)/
    .exec(prompt(current, call))?.[1]
    ?.split(", ") ?? []

const appleKinds = (current: Harness, call = 0): string[] =>
  offered(current, call).filter((k) => k.startsWith("apple."))

const INDEXED = { location: "Lorem Street 1", notes: "Ipsum dolor sit amet." }

describe("proposing an update to an Apple event", () => {
  test("a request to move a listed Apple event yields one update naming its id, and the model is shown the calendar id", async () => {
    const h = await setup([reply([MOVE])], [{ ...DENTIST, ...WRITABLE }], {
      "apple-dentist": INDEXED,
    })
    const result = await run(h, "Move the dentist appointment to the 3rd")
    expect(result.status).toBe("proposed")
    expect(h.gate.proposals).toHaveLength(1)
    expect(h.gate.proposals[0]?.intent).toMatchObject({
      kind: "apple.event_update",
      args: { id: "apple-dentist", calendarId: "cal-1" },
    })
    expect(prompt(h)).toContain(
      "- uid=apple-dentist | Dentist checkup | 2030-05-01T09:00:00.000Z to 2030-05-01T10:00:00.000Z | source=apple-eventkit | calendarId=cal-1"
    )
    expect(prompt(h)).not.toContain("read-only")
    expect(appleKinds(h)).toEqual(["apple.event_update"])
    expect(prompt(h)).toContain(APPLE_EVENT_UPDATE_NOTE)
  })

  test("an update that leaves location and notes out keeps the indexed ones", async () => {
    const h = await setup([reply([MOVE])], [{ ...DENTIST, ...WRITABLE }], {
      "apple-dentist": INDEXED,
    })
    await run(h, "Move the dentist appointment to the 3rd")
    expect(h.gate.proposals[0]?.intent).toEqual({
      ...MOVE,
      args: { ...MOVE.args, ...INDEXED },
    })
  })

  test("a location the request changes wins, and notes the calendar does not hold stay out", async () => {
    const changed = {
      ...MOVE,
      args: { ...MOVE.args, location: "Dolor Road 2" },
    }
    const h = await setup([reply([changed])], [{ ...DENTIST, ...WRITABLE }], {
      "apple-dentist": { location: "Lorem Street 1", notes: null },
    })
    await run(h, "Move the dentist appointment to Dolor Road")
    expect(h.gate.proposals[0]?.intent).toEqual(changed)
  })

  test("an update naming an event the block did not list is not proposed; the retry note names the id", async () => {
    const invented = { ...MOVE, args: { ...MOVE.args, id: "apple-invented" } }
    const h = await setup(
      [reply([invented]), reply([MOVE])],
      [{ ...DENTIST, ...WRITABLE }],
      { "apple-dentist": INDEXED }
    )
    const result = await run(h, "Move the dentist appointment to the 3rd")
    expect(prompt(h, 1)).toContain("unknown_reference at $.intents[0].args.id")
    expect(result.retried).toBe(true)
    expect(h.gate.proposals.map((p) => p.intent)).toEqual([
      { ...MOVE, args: { ...MOVE.args, ...INDEXED } },
    ])
  })

  test("an update naming an event outside the block twice is rejected and reaches no gate", async () => {
    const invented = { ...MOVE, args: { ...MOVE.args, id: "apple-invented" } }
    const h = await setup(
      [reply([invented]), reply([invented])],
      [{ ...DENTIST, ...WRITABLE }],
      { "apple-dentist": INDEXED }
    )
    const result = await run(h, "Move the dentist appointment to the 3rd")
    expect(result).toMatchObject({
      status: "rejected",
      reason: "reply_failed_twice",
    })
    expect(h.gate.proposals).toEqual([])
  })
})

describe("an Apple event the Helper would refuse", () => {
  const cases: [string, Parameters<typeof indexEvents>[1], boolean][] = [
    [
      "has attendees",
      [{ ...DENTIST, hasAttendees: true, recurring: false }],
      true,
    ],
    [
      "is recurring",
      [{ ...DENTIST, hasAttendees: false, recurring: true }],
      true,
    ],
    ["has unknown flags", [{ ...DENTIST }], true],
    ["has unknown details", [{ ...DENTIST, ...WRITABLE }], false],
  ]
  test.each(cases)(
    "an event that %s is not offered an Apple write kind and is listed read-only",
    async (_name, events, known) => {
      const h = await setup(
        [NONE],
        events,
        known ? { "apple-dentist": INDEXED } : {}
      )
      const result = await run(h, "Move the dentist appointment to the 3rd")
      expect(appleKinds(h)).toEqual([])
      expect(offered(h).filter((k) => k.startsWith("calendar.e"))).toEqual([])
      expect(prompt(h)).toContain("uid=apple-dentist")
      expect(prompt(h)).toContain("source=apple-eventkit | read-only")
      expect(prompt(h)).not.toContain("calendarId=")
      expect(prompt(h)).not.toContain(APPLE_EVENT_UPDATE_NOTE)
      expect(result.status).toBe("empty")
      expect(h.gate.proposals).toEqual([])
    }
  )

  test("a model that names such an event anyway is refused: the kind was not offered", async () => {
    const h = await setup(
      [reply([MOVE]), reply([MOVE])],
      [{ ...DENTIST, hasAttendees: true, recurring: false }],
      { "apple-dentist": INDEXED }
    )
    const result = await run(h, "Move the dentist appointment to the 3rd")
    expect(result.status).toBe("rejected")
    expect(h.gate.proposals).toEqual([])
  })
})

describe("what the Apple update kind never covers", () => {
  test("no Apple write kind is offered when no listed event matches", async () => {
    const h = await setup([NONE], [{ ...DENTIST, ...WRITABLE }], {
      "apple-dentist": INDEXED,
    })
    await run(h, "Move the yoga class to the 3rd")
    expect(offered(h)).not.toContain("apple.event_update")
    expect(prompt(h)).not.toContain("## Events")
  })

  test("a cancel request is not offered a delete kind: the gate has no Apple event delete", async () => {
    const h = await setup([NONE], [{ ...DENTIST, ...WRITABLE }], {
      "apple-dentist": INDEXED,
    })
    const result = await run(h, "Cancel the dentist appointment")
    expect(offered(h).filter((k) => /delete|cancel/.test(k))).toEqual([])
    expect(result.status).toBe("empty")
    expect(h.gate.proposals).toEqual([])
  })

  const PROTON_OFFSITE = {
    uid: "proton-offsite@example.invalid",
    title: "Team offsite",
    start: "2030-05-03",
    end: "2030-05-04",
    allDay: true,
    source: "proton-calendar",
  }
  const APPLE_OFFSITE = {
    uid: "apple-offsite",
    title: "Offsite dinner",
    start: "2030-05-03T18:00:00.000Z",
    end: "2030-05-03T20:00:00.000Z",
    ...WRITABLE,
  }

  test("a Proton event as the best match keeps calendar.edit and gets no Apple kind", async () => {
    const h = await setup([NONE], [PROTON_OFFSITE, APPLE_OFFSITE], {
      "apple-offsite": INDEXED,
    })
    await run(h, "Reschedule the team offsite event")
    expect(prompt(h)).toContain("uid=proton-offsite@example.invalid")
    expect(offered(h)).toEqual(
      expect.arrayContaining(["calendar.edit", "calendar.delete"])
    )
    expect(appleKinds(h)).toEqual([])
  })

  test("a Proton edit naming an Apple event's id is still refused", async () => {
    const edit = {
      kind: "calendar.edit",
      args: { eventUid: "apple-offsite", title: "Lorem" },
    }
    const h = await setup(
      [reply([edit]), reply([edit])],
      [PROTON_OFFSITE, APPLE_OFFSITE],
      { "apple-offsite": INDEXED }
    )
    const result = await run(h, "Reschedule the team offsite event")
    expect(result.status).toBe("rejected")
    expect(prompt(h, 1)).toContain("apple_event_not_proton")
    expect(h.gate.proposals).toEqual([])
  })
})
