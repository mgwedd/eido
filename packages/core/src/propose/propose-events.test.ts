import { afterEach, describe, expect, test } from "vitest"
import { indexEvents } from "../context/context.test-support"
import { proposeIntents } from "./propose"
import { harness, seedNewsletters, type Harness } from "./propose.test-support"

const reply = (intents: unknown[]): string =>
  JSON.stringify({ result: "intents", intents })

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function setup(replies: string[], text: string) {
  h = await harness({ replies })
  const seed = seedNewsletters(h.db)
  indexEvents(h.db, [
    {
      uid: "apple-dentist",
      title: "Dentist checkup",
      start: "2030-05-01T09:00:00.000Z",
      end: "2030-05-01T10:00:00.000Z",
    },
    {
      uid: "proton-offsite@example.invalid",
      title: "Team offsite",
      start: "2030-05-03",
      end: "2030-05-04",
      allDay: true,
      source: "proton-calendar",
    },
  ])
  return { h, request: { id: "req-1", text, seed } }
}

const prompt = (current: Harness, call = 0): string =>
  current.completions()[call]?.messages.at(-1)?.content ?? ""

describe("proposeIntents with calendar events", () => {
  test("a calendar request gets an Events block with the matching event's uid, before the request", async () => {
    const { h, request } = await setup(
      [reply([])],
      "Move the dentist appointment to Friday"
    )
    await proposeIntents(request, h.deps)
    const content = prompt(h)
    expect(content).toContain(
      "## Events (1 of 1 match)\n- uid=apple-dentist | Dentist checkup | 2030-05-01T09:00:00.000Z to 2030-05-01T10:00:00.000Z | source=apple-eventkit | read-only"
    )
    expect(content).not.toContain("proton-offsite@example.invalid")
    expect(content.indexOf("## Events")).toBeGreaterThan(
      content.indexOf("[M1]")
    )
    expect(content.indexOf("## Events")).toBeLessThan(
      content.indexOf("Owner request:")
    )
  })

  test("a request with no calendar kind gets no Events block", async () => {
    const { h, request } = await setup(
      [reply([])],
      "Archive the dentist newsletter email"
    )
    await proposeIntents(request, h.deps)
    expect(prompt(h)).not.toContain("## Events")
  })

  test("a listed non-Apple event can be cancelled by its uid", async () => {
    const cancel = {
      kind: "calendar.delete",
      args: { eventUid: "proton-offsite@example.invalid" },
    }
    const { h, request } = await setup(
      [reply([cancel])],
      "Cancel the team offsite event"
    )
    const result = await proposeIntents(request, h.deps)
    expect(prompt(h)).toContain(
      "- uid=proton-offsite@example.invalid | Team offsite | 2030-05-03 to 2030-05-04 | all-day | source=proton-calendar"
    )
    expect(result.status).toBe("proposed")
    expect(h.gate.proposals.map((p) => p.intent)).toEqual([cancel])
  })

  test("a Proton delete naming a listed Apple event never reaches the gate", async () => {
    const cancel = {
      kind: "calendar.delete",
      args: { eventUid: "apple-dentist" },
    }
    const { h, request } = await setup(
      [reply([cancel]), reply([cancel])],
      "Cancel the dentist appointment"
    )
    const result = await proposeIntents(request, h.deps)
    expect(h.gate.proposals).toEqual([])
    expect(result).toMatchObject({
      status: "rejected",
      reason: "reply_failed_twice",
    })
    expect(prompt(h, 1)).toContain(
      "apple_event_not_proton at $.intents[0].args.eventUid"
    )
  })
})
