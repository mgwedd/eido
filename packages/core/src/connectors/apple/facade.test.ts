import { describe, expect, test, vi } from "vitest"
import type { AppleClient, IntentProposal } from "@eido/gate"
import type { GateProposeResult } from "@eido/schemas"
import { createAppleFacade } from "./facade"
import { appleManifest } from "./manifest"

const START = "2026-11-13T09:00:00Z"
const END = "2026-11-13T10:00:00Z"
const EVENT = {
  calendarId: "cal-1",
  title: "Planning",
  start: START,
  end: END,
  allDay: false,
}
function setup() {
  const client = {
    listCalendars: vi.fn(() =>
      Promise.resolve({
        calendars: [{ id: "cal-1", title: "Personal", writable: true }],
      })
    ),
    listReminderLists: vi.fn(() =>
      Promise.resolve({
        calendars: [{ id: "list-1", title: "Tasks", writable: true }],
      })
    ),
    listEvents: vi.fn(() =>
      Promise.resolve({
        events: [
          {
            id: "event-1",
            ...EVENT,
            notes: null,
            location: null,
            modifiedAt: null,
          },
        ],
      })
    ),
    listReminders: vi.fn(() => Promise.resolve({ reminders: [] })),
  } satisfies AppleClient
  const propose = vi
    .fn<(proposal: IntentProposal) => Promise<GateProposeResult>>()
    .mockResolvedValue({ id: "intent-1", tier: "approval", state: "pending" })
  return {
    client,
    propose,
    facade: createAppleFacade({ client, intents: { propose } }),
  }
}

describe("Apple facade", () => {
  test("reads forward through the gate client and never propose writes", async () => {
    const { client, propose, facade } = setup()
    expect(await facade.list_calendars()).toEqual({
      calendars: [{ id: "cal-1", title: "Personal", writable: true }],
    })
    expect(await facade.list_reminder_lists()).toEqual({
      calendars: [{ id: "list-1", title: "Tasks", writable: true }],
    })
    expect(
      await facade.list_events({ calendarId: "cal-1", start: START, end: END })
    ).toMatchObject({ events: [{ id: "event-1", title: "Planning" }] })
    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "cal-1",
      start: START,
      end: END,
    })
    expect(
      await facade.list_reminders({ listId: "list-1", completedSince: START })
    ).toEqual({ reminders: [] })
    expect(client.listReminders).toHaveBeenCalledWith({
      listId: "list-1",
      completedSince: START,
    })
    expect(propose).not.toHaveBeenCalled()
  })
  test("all mutation methods submit distinct approval proposals", async () => {
    const { client, propose, facade } = setup()
    expect(
      await facade.create_event(EVENT, {
        rationale: " Requested planning event ",
      })
    ).toEqual({ intentId: "intent-1" })
    expect(propose).toHaveBeenNthCalledWith(1, {
      intent: { kind: "apple.event_create", args: EVENT },
      origin: "reactive",
      rationale: "Requested planning event",
    })
    await facade.update_event({ id: "event-1", ...EVENT })
    await facade.create_reminder({ listId: "list-1", title: "Call doctor" })
    await facade.complete_reminder({ id: "reminder-1" })
    expect(propose.mock.calls.map(([p]) => p.intent)).toEqual([
      { kind: "apple.event_create", args: EVENT },
      { kind: "apple.event_update", args: { id: "event-1", ...EVENT } },
      {
        kind: "apple.reminder_create",
        args: { listId: "list-1", title: "Call doctor" },
        sensitivity: "sensitive",
      },
      { kind: "apple.reminder_complete", args: { id: "reminder-1" } },
    ])
    expect(client.listCalendars).not.toHaveBeenCalled()
    expect(client.listEvents).not.toHaveBeenCalled()
  })
  test("rejects malformed mutation arguments before sending a proposal", async () => {
    const { propose, facade } = setup()
    await expect(facade.create_event({ ...EVENT, title: "" })).rejects.toThrow(
      "invalid Apple intent"
    )
    expect(propose).not.toHaveBeenCalled()
  })
  test("propagates gate refusal and preserves proactive origin", async () => {
    const { client, propose } = setup()
    propose.mockRejectedValueOnce(new Error("connector disabled"))
    const facade = createAppleFacade({
      client,
      intents: { propose },
      origin: "proactive",
    })
    await expect(
      facade.complete_reminder({ id: "reminder-1" })
    ).rejects.toThrow("connector disabled")
    expect(propose).toHaveBeenCalledWith({
      intent: { kind: "apple.reminder_complete", args: { id: "reminder-1" } },
      origin: "proactive",
    })
  })
  test("manifest exposes exactly the facade operations, marks reads untrusted and all writes approval-only", () => {
    const { facade } = setup()
    const manifest = appleManifest()
    expect(manifest.operations.map((op) => op.name).sort()).toEqual(
      Object.keys(facade).sort()
    )
    expect(
      manifest.operations
        .filter((op) => op.effect === "write")
        .map((op) => [op.name, op.intentKind, op.defaultTier])
    ).toEqual([
      ["create_event", "apple.event_create", "approval"],
      ["update_event", "apple.event_update", "approval"],
      ["create_reminder", "apple.reminder_create", "approval"],
      ["complete_reminder", "apple.reminder_complete", "approval"],
    ])
    expect(
      manifest.operations
        .filter((op) => op.effect === "read")
        .map((op) => [op.name, op.untrustedOutput])
    ).toEqual([
      ["list_calendars", true],
      ["list_reminder_lists", true],
      ["list_events", true],
      ["list_reminders", true],
    ])
    expect(manifest.egress).toEqual({ hosts: [] })
  })
})
