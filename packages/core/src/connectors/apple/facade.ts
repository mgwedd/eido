import type { AppleClient, IntentClient } from "@eido/gate"
import type {
  AppleEventCreateIntent,
  AppleEventUpdateIntent,
  AppleReminderCreateIntent,
  AppleReminderCompleteIntent,
  GateIntentOrigin,
  Intent,
} from "@eido/schemas"
import { validateIntent } from "@eido/schemas"
import { classifyIntentSensitivity } from "../../propose/sensitivity"
import type { SensitivityClassifierOptions } from "../../propose/sensitivity"
import { rationaleField } from "../proposal-rationale"
import type { ProposalNote } from "../proposal-rationale"

export interface AppleFacadeDeps {
  client: AppleClient
  intents: Pick<IntentClient, "propose">
  origin?: GateIntentOrigin
  classifierOptions?: SensitivityClassifierOptions
}

/** Reads cross the gate's read socket. Mutations only submit an approval proposal. */
export function createAppleFacade({
  client,
  intents,
  origin = "reactive",
  classifierOptions,
}: AppleFacadeDeps) {
  async function propose(intent: Intent, note?: ProposalNote) {
    const checked = validateIntent(intent)
    if (!checked.ok)
      throw new Error(`invalid Apple intent: ${checked.errors.join("; ")}`)
    const classified = await classifyIntentSensitivity(
      checked.value,
      classifierOptions
    )
    const result = await intents.propose({
      intent: classified,
      origin,
      ...rationaleField(note),
    })
    return { intentId: result.id }
  }

  return {
    list_calendars: () => client.listCalendars(),
    list_reminder_lists: () => client.listReminderLists(),
    list_events: (args: Parameters<AppleClient["listEvents"]>[0]) =>
      client.listEvents(args),
    list_reminders: (args: Parameters<AppleClient["listReminders"]>[0]) =>
      client.listReminders(args),
    create_event: (args: AppleEventCreateIntent["args"], note?: ProposalNote) =>
      propose({ kind: "apple.event_create", args }, note),
    update_event: (args: AppleEventUpdateIntent["args"], note?: ProposalNote) =>
      propose({ kind: "apple.event_update", args }, note),
    create_reminder: (
      args: AppleReminderCreateIntent["args"],
      note?: ProposalNote
    ) => propose({ kind: "apple.reminder_create", args }, note),
    complete_reminder: (
      args: AppleReminderCompleteIntent["args"],
      note?: ProposalNote
    ) => propose({ kind: "apple.reminder_complete", args }, note),
  }
}

export type AppleFacade = ReturnType<typeof createAppleFacade>
