export type EventKind =
  | "new-obligation"
  | "confirm-field"
  | "reply-owed"
  | "waiting-on"
  | "due-soon"
  | "due-today"
  | "overdue"

/** What the score is a function of. */
export type ScoreSignals = {
  /** Whole days until the due date; negative when overdue. Absent when there is none. */
  daysToDue?: number
  moneyPresent?: boolean
  /** Whole days since the message the event is about. */
  threadAgeDays?: number
}

/** The weights. Each part is added, then the sum is clamped to 0..1. */
export const SCORE_WEIGHTS = {
  kind: {
    overdue: 0.5,
    "due-today": 0.5,
    "due-soon": 0.3,
    "reply-owed": 0.35,
    "waiting-on": 0.2,
    "new-obligation": 0.3,
    "confirm-field": 0.25,
  },
  /** Added by days to due: the first row whose `upTo` is at least `daysToDue`. */
  dueUrgency: [
    { upTo: 0, add: 0.25 },
    { upTo: 2, add: 0.2 },
    { upTo: 7, add: 0.1 },
  ],
  moneyPresent: 0.15,
  /** Per day of thread age, up to `max`. */
  threadAge: { perDay: 0.01, max: 0.1 },
} as const satisfies {
  kind: Record<EventKind, number>
  dueUrgency: readonly { upTo: number; add: number }[]
  moneyPresent: number
  threadAge: { perDay: number; max: number }
}

/**
 * Deterministic score in 0..1 from the kind, days to due or overdue, money present and thread
 * age. No model and no clock: the same signals always give the same score.
 */
export function scoreEvent(kind: EventKind, signals: ScoreSignals): number {
  const w = SCORE_WEIGHTS
  let score: number = w.kind[kind]
  if (signals.daysToDue !== undefined) {
    const days = signals.daysToDue
    score += w.dueUrgency.find((row) => days <= row.upTo)?.add ?? 0
  }
  if (signals.moneyPresent === true) score += w.moneyPresent
  if (signals.threadAgeDays !== undefined) {
    score += Math.min(
      w.threadAge.max,
      Math.max(0, signals.threadAgeDays) * w.threadAge.perDay
    )
  }
  return Math.round(Math.min(1, score) * 1000) / 1000
}
