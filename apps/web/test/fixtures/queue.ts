// Synthetic fixtures for the Queue page. Imported by tests only; never by app code.
import type { GatePrepareApproval } from "@eido/schemas"
import type { PendingIntent } from "../../lib/today"
import { FLAGGED_SHA } from "./mail-signals"

const NOW = new Date("2026-10-18T12:00:00.000Z")

const queued = [
  {
    id: "intent-a",
    kind: "email.reply",
    tier: "approval",
    state: "pending",
    origin: "reactive",
    createdAt: "2026-10-17T10:00:00.000Z",
  },
] as const satisfies readonly PendingIntent[]

export { NOW, queued }

export const mailQueued: readonly PendingIntent[] = [
  { ...queued[0], messageSha256: FLAGGED_SHA },
]

export const mailPayload = JSON.stringify({
  args: {
    body: "Please confirm the revised quote.",
    messageId: "synthetic-message",
    messageSha256: FLAGGED_SHA,
    replyAll: false,
    to: ["sender@example.invalid"],
  },
  kind: "email.reply",
})

export function mailPrepared(payloadHash: string): GatePrepareApproval {
  return {
    intentId: "intent-a",
    kind: "email.reply",
    origin: "reactive",
    state: "pending",
    payload: mailPayload,
    payloadHash,
    nonce: "n".repeat(43),
    documentIds: [],
  }
}
