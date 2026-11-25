import { afterEach, describe, expect, test, vi } from "vitest"
import {
  buildEditedIntent,
  editRefusal,
  editableFields,
  fromLocalInput,
  hasEditForm,
  hasEdits,
  toLocalInput,
} from "../lib/queue/edit"

const SEND = JSON.stringify({
  kind: "email.send",
  args: {
    to: ["a@example.invalid", "b@example.invalid"],
    cc: ["c@example.invalid"],
    subject: "Quote",
    body: "Hello",
    draftId: "draft-1",
  },
})

const REPLY = JSON.stringify({
  kind: "email.reply",
  args: {
    messageId: "m-1",
    messageSha256: "ab".repeat(32),
    to: ["a@example.invalid"],
    body: "Hello",
    replyAll: false,
  },
})

const EVENT = JSON.stringify({
  kind: "calendar.create",
  args: {
    entity: "personal",
    title: "Lease review",
    start: "2026-11-01T14:00:00Z",
    end: "2026-11-01T15:00:00Z",
    allDay: false,
    location: "Office",
    description: "Bring the lease",
    guests: ["pm@example.invalid"],
  },
})

// Node reads TZ again when it changes, so a test can pin the device's zone.
const setTimeZone = (zone: string) => {
  vi.stubEnv("TZ", zone)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("editableFields", () => {
  test("an email send offers To, Subject and Message, and not cc or the draft", () => {
    expect(editableFields(SEND)).toEqual([
      {
        key: "to",
        label: "To",
        type: "list",
        initial: "a@example.invalid, b@example.invalid",
      },
      { key: "subject", label: "Subject", type: "text", initial: "Quote" },
      { key: "body", label: "Message", type: "block", initial: "Hello" },
    ])
  })

  test("a reply, which has no subject, offers To and Message", () => {
    expect(editableFields(REPLY).map((field) => field.label)).toEqual([
      "To",
      "Message",
    ])
  })

  test("a calendar event offers When (start and end), Attendees and Notes, not title or location", () => {
    setTimeZone("America/New_York")
    expect(editableFields(EVENT)).toEqual([
      {
        key: "start",
        label: "Starts",
        type: "datetime",
        group: "When",
        initial: "2026-11-01T09:00",
      },
      {
        key: "end",
        label: "Ends",
        type: "datetime",
        group: "When",
        initial: "2026-11-01T10:00",
      },
      {
        key: "guests",
        label: "Attendees",
        type: "list",
        initial: "pm@example.invalid",
      },
      {
        key: "description",
        label: "Notes",
        type: "block",
        initial: "Bring the lease",
      },
    ])
  })

  test("a change to an event shows only the designed fields it carries", () => {
    const change = JSON.stringify({
      kind: "calendar.edit",
      args: { eventUid: "uid-1", guests: [], title: "New title" },
    })
    expect(editableFields(change).map((field) => field.key)).toEqual(["guests"])
  })

  test("a kind with no designed form has nothing to edit", () => {
    const trash = JSON.stringify({
      kind: "email.trash",
      args: { messageIds: ["m-1"] },
    })
    expect(editableFields(trash)).toEqual([])
    const apple = JSON.stringify({
      kind: "apple.event_create",
      args: { title: "x", notes: "y", start: "2026-11-01T14:00:00Z" },
    })
    expect(editableFields(apple)).toEqual([])
  })

  test("a value of the wrong shape or a time that cannot be read is left out", () => {
    const odd = JSON.stringify({
      kind: "calendar.create",
      args: { start: "soon", end: 5, guests: "pm@example.invalid" },
    })
    expect(editableFields(odd)).toEqual([])
  })

  test("a payload that is not an intent has nothing to edit", () => {
    expect(editableFields("not json")).toEqual([])
    expect(editableFields(JSON.stringify({ args: { to: ["x"] } }))).toEqual([])
    expect(
      editableFields(JSON.stringify({ kind: "email.send", args: [] }))
    ).toEqual([])
  })
})

describe("hasEditForm", () => {
  test.each([
    ["email.send", true],
    ["email.reply", true],
    ["calendar.create", true],
    ["calendar.edit", true],
    ["email.forward", false],
    ["things.update_todo", false],
    ["toString", false],
  ])("%s", (kind, expected) => {
    expect(hasEditForm(kind)).toBe(expected)
  })
})

describe("local date and time", () => {
  test("shows an RFC 3339 time in the device's zone", () => {
    setTimeZone("America/New_York")
    expect(toLocalInput("2026-07-15T13:30:00Z")).toBe("2026-07-15T09:30")
    expect(toLocalInput("2026-07-15T08:30:00+05:30")).toBe("2026-07-14T23:00")
    expect(toLocalInput("not a time")).toBeUndefined()
  })

  test("writes a local time with the device's offset on that date", () => {
    setTimeZone("America/New_York")
    expect(fromLocalInput("2026-07-15T09:00")).toBe("2026-07-15T09:00:00-04:00")
    expect(fromLocalInput("2026-12-15T09:00")).toBe("2026-12-15T09:00:00-05:00")
    setTimeZone("Asia/Kolkata")
    expect(fromLocalInput("2026-07-15T09:00")).toBe("2026-07-15T09:00:00+05:30")
    setTimeZone("UTC")
    expect(fromLocalInput("2026-07-15T09:00")).toBe("2026-07-15T09:00:00+00:00")
  })

  test("passes a value that is not a local date and time through, for the gate to refuse", () => {
    expect(fromLocalInput("")).toBe("")
    expect(fromLocalInput("tomorrow")).toBe("tomorrow")
  })
})

describe("buildEditedIntent", () => {
  test("puts the edited values in and keeps every other argument as it was", () => {
    expect(
      buildEditedIntent(SEND, {
        to: "c@example.invalid ,  d@example.invalid,",
        body: "Hi",
      })
    ).toEqual({
      kind: "email.send",
      args: {
        to: ["c@example.invalid", "d@example.invalid"],
        cc: ["c@example.invalid"],
        subject: "Quote",
        body: "Hi",
        draftId: "draft-1",
      },
    })
  })

  test("a time left as it was keeps its original text; a changed one is written in the device's zone", () => {
    setTimeZone("America/New_York")
    expect(
      buildEditedIntent(EVENT, {
        start: "2026-11-01T09:00",
        end: "2026-11-01T11:30",
        guests: "",
      })
    ).toEqual({
      kind: "calendar.create",
      args: {
        entity: "personal",
        title: "Lease review",
        start: "2026-11-01T14:00:00Z",
        end: "2026-11-01T11:30:00-05:00",
        allDay: false,
        location: "Office",
        description: "Bring the lease",
        guests: [],
      },
    })
  })

  test("is undefined for a payload that cannot be read", () => {
    expect(buildEditedIntent("{", {})).toBeUndefined()
  })
})

describe("hasEdits", () => {
  test("is false until a value differs from the card", () => {
    expect(hasEdits(SEND, {})).toBe(false)
    expect(hasEdits(SEND, { subject: "Quote" })).toBe(false)
    expect(hasEdits(SEND, { subject: "Quote 2" })).toBe(true)
  })
})

describe("editRefusal", () => {
  test("a tier change says why and leaves the fields editable", () => {
    expect(editRefusal({ code: "tier_changed", message: "x" })).toEqual({
      message:
        "This change moves the request to a different approval tier, so it was not saved. Reject it and ask again instead.",
      locked: false,
      retry: false,
    })
  })

  test("an invalid edit carries the gate's own words", () => {
    expect(
      editRefusal({ code: "invalid_request", message: "to: not an address" })
    ).toEqual({
      message: "The gate could not accept these changes.",
      detail: "to: not an address",
      locked: false,
      retry: false,
    })
  })

  test("a forbidden edit locks the form", () => {
    expect(editRefusal({ code: "forbidden", message: "x" })).toEqual({
      message: "You cannot edit this request.",
      locked: true,
      retry: false,
    })
  })

  test("an unreachable gate offers Retry", () => {
    expect(editRefusal({ code: "network", message: "x" })).toEqual({
      message: "The gate is not reachable. Your changes are kept.",
      locked: false,
      retry: true,
    })
  })

  test("any other refusal shows the gate's message", () => {
    expect(editRefusal({ code: "other", message: "from the gate" })).toEqual({
      message: "from the gate",
      locked: false,
      retry: false,
    })
  })
})
