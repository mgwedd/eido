// Synthetic fixtures for the Today page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.cjs).
import type { PendingIntent } from "../../lib/today"

const NOW = new Date("2026-10-18T12:00:00.000Z")

/** Two pending intents, newest first on purpose: the card must reorder them. */
const pendingIntents = [
  {
    id: "intent-new",
    kind: "email.send",
    tier: "approval",
    state: "pending",
    origin: "reactive",
    createdAt: "2026-10-18T06:00:00.000Z",
  },
  {
    id: "intent-old",
    kind: "calendar.create",
    tier: "approval",
    state: "pending",
    origin: "proactive",
    createdAt: "2026-10-17T14:00:00.000Z",
  },
] as const satisfies readonly PendingIntent[]

export { NOW, pendingIntents }
