// Test support for triage: a data DB, synthetic events and a stub gate. Imported by tests only.
import type { DatabaseSync } from "node:sqlite"
import { openDataDb } from "../ledger/db"
import { DEFAULT_TRIAGE_CONFIG } from "./config"
import type { TriageConfig } from "./config"
import { emitEvent } from "./store"
import type { NewEvent } from "./store"
import type { CardBuilder, TriageDeps } from "./tick"

export const CONFIG: TriageConfig = {
  ...DEFAULT_TRIAGE_CONFIG,
  timezone: "Europe/Zurich",
}

/** 13:00 in Zurich on 2026-11-02 (CET). */
export const NOW = new Date("2026-11-02T12:00:00.000Z")

export function openDb(): DatabaseSync {
  return openDataDb(":memory:")
}

let counter = 0

/** A queued event; the score follows from `signals` (default: a bare new obligation, 0.3). */
export function event(over: Partial<NewEvent> = {}): NewEvent {
  counter += 1
  return {
    source: "extraction",
    kind: "new-obligation",
    triggerKey: `obligation:${String(counter)}:new`,
    fireId: "created",
    ref: `obl:${String(counter)}`,
    signals: {},
    receivedAt: NOW.toISOString(),
    ...over,
  }
}

export function emit(db: DatabaseSync, over: Partial<NewEvent> = {}): string {
  return emitEvent(db, event(over)).id
}

/** A builder that proposes a reminder for the event; the content is synthetic. */
export const reminderCard: CardBuilder = (e) => ({
  intent: {
    kind: "reminder.create",
    args: {
      list: "Eido",
      title: `Follow up on ${e.ref}`,
      due: "2026-11-03T09:00:00.000Z",
    },
  },
})

export const ALL_CARDS: TriageDeps["cards"] = {
  "new-obligation": reminderCard,
  "confirm-field": reminderCard,
  "reply-owed": reminderCard,
  "waiting-on": reminderCard,
  "due-soon": reminderCard,
  "due-today": reminderCard,
  overdue: reminderCard,
}

export function rows(
  db: DatabaseSync,
  where = "1 = 1"
): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY id`).all()
}
