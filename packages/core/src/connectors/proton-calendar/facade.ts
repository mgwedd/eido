import type { IntentClient } from "@eido/gate"
import type {
  CalendarCreateIntent,
  CalendarDeleteIntent,
  CalendarEditIntent,
  GateIntentOrigin,
} from "@eido/schemas"
import { rationaleField } from "../proposal-rationale"
import type { ProposalNote } from "../proposal-rationale"
import type { ProtonCalendarConfig } from "./config"
import { validateProtonCalendarConfig } from "./config"
import { deriveEventUid } from "./builder"
import {
  type CalendarSentRecordStore,
  createMemorySentRecordStore,
} from "./sent-record"

export type IntentReceipt = {
  intentId: string
  eventUid?: string
}

export type ProtonCalendarFacadeDeps = {
  intents: IntentClient
  config: ProtonCalendarConfig
  sentRecord?: CalendarSentRecordStore
  origin?: GateIntentOrigin
  now?: () => string
}

export class ProtonCalendarError extends Error {
  override readonly name = "ProtonCalendarError"
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function createProtonCalendarFacade(deps: ProtonCalendarFacadeDeps) {
  const config = validateProtonCalendarConfig(deps.config)
  const sentRecord = deps.sentRecord ?? createMemorySentRecordStore()
  const origin: GateIntentOrigin = deps.origin ?? "task"
  const now = deps.now ?? (() => new Date().toISOString())

  const propose = async (
    intent: { kind: string; args: object },
    note?: ProposalNote
  ): Promise<{ intentId: string }> => {
    const result = await deps.intents.propose({
      intent,
      origin,
      ...rationaleField(note),
    })
    return { intentId: result.id }
  }

  return {
    event_create: async (
      args: CalendarCreateIntent["args"],
      note?: ProposalNote
    ): Promise<IntentReceipt> => {
      const eventUid = deriveEventUid(args)
      const receipt = await propose({ kind: "calendar.create", args }, note)
      sentRecord.recordCreate(args, config.ownerAddress, now())
      return { intentId: receipt.intentId, eventUid }
    },

    event_update: async (
      args: CalendarEditIntent["args"],
      note?: ProposalNote
    ): Promise<IntentReceipt> => {
      const receipt = await propose({ kind: "calendar.edit", args }, note)
      if (sentRecord.has(args.eventUid)) {
        sentRecord.recordEdit(args, now())
      }
      return { intentId: receipt.intentId, eventUid: args.eventUid }
    },

    event_delete: async (
      args: CalendarDeleteIntent["args"],
      note?: ProposalNote
    ): Promise<IntentReceipt> => {
      const receipt = await propose({ kind: "calendar.delete", args }, note)
      if (sentRecord.has(args.eventUid)) {
        sentRecord.recordDelete(args.eventUid, now())
      }
      return { intentId: receipt.intentId, eventUid: args.eventUid }
    },
  }
}

export type ProtonCalendarFacade = ReturnType<typeof createProtonCalendarFacade>
