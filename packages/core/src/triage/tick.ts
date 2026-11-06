import type { DatabaseSync } from "node:sqlite"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentClient, IntentProposal } from "@eido/gate"
import { writeQueueFor } from "../db/write-queue"
import { validateTriageConfig } from "./config"
import type { TriageConfig } from "./config"
import { localDay } from "./day"
import type { EventKind } from "./score"
import { cardsDecidedBetween, decideEvent, queuedEvents } from "./store"
import type { Disposition, TriageEvent } from "./store"

/**
 * Builds the intent a card proposes for an event, or nothing when the event has no card to show.
 * Card content belongs to the issue of each event kind (replies, confirm-field); triage only
 * budgets them and sets the origin, so a builder cannot choose it.
 */
export type CardBuilder = (
  event: TriageEvent
) =>
  | Omit<IntentProposal, "origin">
  | undefined
  | Promise<Omit<IntentProposal, "origin"> | undefined>

export type TriageDeps = {
  db: DatabaseSync
  /** The gate's intent API (`createIntentClient` from `@eido/gate`). */
  gate: Pick<IntentClient, "propose">
  /** One builder per event kind that can become a card. */
  cards: Partial<Record<EventKind, CardBuilder>>
}

export type TriageResult = {
  cards: number
  digest: number
  ledger: number
  remainingBudget: number
}

const ticks = new WeakMap<DatabaseSync, Promise<unknown>>()

type Decision = { disposition: Disposition; reason?: string; intentId?: string }

async function propose(
  deps: TriageDeps,
  event: TriageEvent
): Promise<Decision> {
  const build = deps.cards[event.kind]
  const proposal = build === undefined ? undefined : await build(event)
  if (proposal === undefined)
    return { disposition: "digest", reason: "no_card_builder" }
  try {
    const stored = await deps.gate.propose({ ...proposal, origin: "proactive" })
    // A policy-refused intent resolves as a stored, rejected intent; it is no card.
    if (stored.state === "rejected")
      return {
        disposition: "digest",
        reason: `gate_rejected:${stored.reason ?? "policy"}`,
      }
    return { disposition: "card", intentId: stored.id }
  } catch (error) {
    if (error instanceof GateRequestError)
      return { disposition: "digest", reason: `gate_refused:${error.code}` }
    if (error instanceof GateUnavailableError)
      return { disposition: "digest", reason: "gate_unavailable" }
    throw error
  }
}

async function run(
  deps: TriageDeps,
  now: Date,
  cfg: TriageConfig
): Promise<TriageResult> {
  const day = localDay(now, cfg.timezone)
  let cardsToday = cardsDecidedBetween(deps.db, day.start, day.end)
  const result = { cards: 0, digest: 0, ledger: 0 }
  const decidedAt = now.toISOString()
  for (const event of queuedEvents(deps.db)) {
    let decision: Decision
    if (event.kind !== "confirm-field" && event.score < cfg.ledgerOnlyBelow) {
      decision = { disposition: "ledger", reason: "low-score" }
    } else if (cardsToday >= cfg.cardBudget.perDay) {
      decision = { disposition: "digest", reason: "budget" }
    } else {
      decision = await propose(deps, event)
    }
    await writeQueueFor(deps.db).run(() => {
      decideEvent(deps.db, event.id, { ...decision, decidedAt })
    })
    result[decision.disposition === "card" ? "cards" : decision.disposition] +=
      1
    if (decision.disposition === "card") cardsToday += 1
  }
  return {
    ...result,
    remainingBudget: Math.max(0, cfg.cardBudget.perDay - cardsToday),
  }
}

/**
 * Decides every queued event, highest score first: below `ledgerOnlyBelow` it is recorded in the
 * ledger; otherwise it becomes a card while fewer than `cardBudget.perDay` cards were created
 * this local day, else it goes to the digest with reason `budget`. A card is an intent proposed
 * through the gate with `origin: "proactive"`; when the gate refuses or fails, or no builder
 * exists for the kind, the event goes to the digest with that reason and uses no budget. The
 * budget is counted from this table, so a restart or a second tick cannot spend it twice. Ticks
 * on one database run one after another. No model call, no network beyond the gate.
 */
export function triageTick(
  deps: TriageDeps,
  now: Date,
  cfg: TriageConfig
): Promise<TriageResult> {
  validateTriageConfig(cfg)
  const previous = ticks.get(deps.db) ?? Promise.resolve()
  const next = previous.then(
    () => run(deps, now, cfg),
    () => run(deps, now, cfg)
  )
  ticks.set(deps.db, next)
  return next
}
