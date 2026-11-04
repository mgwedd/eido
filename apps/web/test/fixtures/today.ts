// Synthetic fixtures for the Today page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type { CoreApiBrief } from "@eido/schemas"
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

const DOC_ID = "a".repeat(64)

/** A brief with one cited line, a coverage line, and the given extra lines. */
function briefWith(extra: CoreApiBrief["lines"]): CoreApiBrief {
  return {
    id: "brief-fixture",
    date: "2026-10-18",
    generatedAt: "2026-10-18T07:02:00.000Z",
    windowStart: "2026-10-17T07:00:00.000Z",
    windowEnd: "2026-10-18T07:00:00.000Z",
    lines: [
      {
        kind: "due",
        text: "Lorem ipsum dolor sit amet.",
        ledger: { type: "obligation", id: "10" },
        source: { documentId: DOC_ID, span: { start: 1, end: 9 } },
      },
      ...extra,
    ],
    coverage: {
      messagesRead: 4,
      messagesTotal: 4,
      documentsRead: 1,
      documentsTotal: 1,
      windowStart: "2026-10-17T07:00:00.000Z",
      windowEnd: "2026-10-18T07:00:00.000Z",
      skipped: 0,
    },
    coverageLine: "Read 4 new messages since yesterday, all of them.",
  }
}

export { NOW, pendingIntents, briefWith }
