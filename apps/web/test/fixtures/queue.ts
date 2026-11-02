// Synthetic fixtures for the Queue page. Imported by tests only; never by app code.
import type { PendingIntent } from "../../lib/today"

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
