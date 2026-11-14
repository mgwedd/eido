import {
  validateGateAppleCalendarList,
  validateGateAppleEventList,
  validateGateAppleReminderList,
} from "@eido/schemas"
import type {
  GateAppleCalendarList,
  GateAppleEventList,
  GateAppleReminderList,
  ValidationResult,
} from "@eido/schemas"
import { AppleError } from "./runner"
import type { AppleRunner } from "./runner"
import type { ConnectorProbe } from "../connector-connect"

export interface AppleReads {
  listCalendars(this: void): Promise<GateAppleCalendarList>
  listReminderLists(this: void): Promise<GateAppleCalendarList>
  listEvents(
    this: void,
    calendarId: string,
    start: string,
    end: string
  ): Promise<GateAppleEventList>
  listReminders(
    this: void,
    listId: string,
    completedSince: string
  ): Promise<GateAppleReminderList>
}

function checked<T>(
  result: unknown,
  validate: (value: unknown) => ValidationResult<T>
): T {
  const value = validate(result)
  if (!value.ok) throw new AppleError("unavailable")
  return value.value
}

export function createAppleReads(run: AppleRunner): AppleReads {
  return {
    listCalendars: async () =>
      checked(
        await run({ operation: "list_calendars", args: {} }),
        validateGateAppleCalendarList
      ),
    listReminderLists: async () =>
      checked(
        await run({ operation: "list_reminder_lists", args: {} }),
        validateGateAppleCalendarList
      ),
    listEvents: async (calendarId, start, end) =>
      checked(
        await run({
          operation: "list_events",
          args: { calendarId, start, end },
        }),
        validateGateAppleEventList
      ),
    listReminders: async (listId, completedSince) =>
      checked(
        await run({
          operation: "list_reminders",
          args: { listId, completedSince },
        }),
        validateGateAppleReminderList
      ),
  }
}

/** Explicit owner reconnect: check both EventKit grants, revealing no calendar content in logs. */
export function appleProbe(reads: AppleReads): ConnectorProbe {
  return async () => {
    try {
      await reads.listCalendars()
      await reads.listReminderLists()
      return "ok"
    } catch (error) {
      return error instanceof AppleError && error.code === "permission_denied"
        ? "auth_failed"
        : "unavailable"
    }
  }
}
