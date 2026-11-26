import type { DatabaseSync } from "node:sqlite"
import { GateRequestError } from "@eido/gate"
import type { IntentClient, IntentState, Tier } from "@eido/gate"
import { INTENT_KINDS } from "@eido/schemas"
import type { GateIntentInjection, Intent } from "@eido/schemas"
import {
  APPLE_CALENDAR_CONNECTOR,
  appleEventDetails,
  isAppleEventId,
} from "../connectors/apple-calendar/sync"
import { assembleContext } from "../context/assemble"
import { listOpenTodos, renderTodosBlock } from "../context/todos"
import { listMatchingEvents, renderEventsBlock } from "../context/events"
import type { EventLine } from "../context/events"
import {
  APPLE_EVENT_UPDATE_KIND,
  ID_DEPENDENT_THINGS_KINDS,
  selectTools,
} from "../context/tools"
import { PromptTooLargeError } from "../inference/errors"
import { INJECTION_REASONS } from "../inference/fence"
import type { PromptPart } from "../inference/fence"
import type { InferenceQueue } from "../inference/queue"
import type { ToolDef } from "../inference/types"
import { carryAppleDetails, checkReply } from "./check"
import type { AppleUpdateTarget } from "./check"
import { draftBounds } from "./draft-recipients"
import { recordProposalFailure } from "./failure-log"
import type { ProposalLimiter } from "./limiter"
import {
  buildProposalRequest,
  referableMessages,
  type ProposalFailure,
} from "./prompt"

// Plain language in, proposed intents out. Core only proposes: every intent goes to the gate's
// intent API, which validates, canonicalizes, hashes and tiers it and stores it for approval.
// Nothing here calls a connector or an executor.

export interface ProposalRequest {
  /** The caller's id for this request; it goes into the rejection log. */
  id: string
  /** The owner's words: the trusted part of the prompt. */
  text: string
  /** sha256 of the document the request is about; the context pack is built from it. */
  seed: string
  /**
   * The only kinds this request may propose, in place of the kinds `selectTools` picks from the
   * text. A caller that offers one kind (the draft-reply route offers `email.draft`) gets nothing
   * else: any other kind in the reply fails the check as `kind_not_offered`.
   */
  kinds?: readonly Intent["kind"][]
  /** The connector pinned on every proposed intent, overriding any the model named. */
  connector?: string
  /**
   * A reply draft: each `email.draft` must go only to the seed's sender or a participant of the
   * seed's thread, carry no bcc, and reply only to the seed. A draft that breaks this fails the
   * check like any other bad reply.
   */
  replyDraft?: boolean
}

/** From configuration. */
export interface ProposeConfig {
  /** The context budget for `propose` (`ContextBudgets.propose`), in estimated tokens. */
  budgetTokens: number
  /** Intents past this many in one reply are dropped and counted in `limited`. */
  maxIntentsPerRequest: number
  /** Characters per estimated token, as configured for the model client. */
  charsPerToken: number
}

export interface ProposeDeps {
  /** eido-data.db: the index, the context packs and `proposal_failures`. */
  db: DatabaseSync
  queue: InferenceQueue
  /** The gate's intent API (`createIntentClient` from `@eido/gate`). */
  gate: Pick<IntentClient, "propose">
  /** Holds `maxProposalsPerHour` (`createProposalLimiter`). */
  limiter: ProposalLimiter
  config: ProposeConfig
  now?: () => Date
}

export interface ProposedIntent {
  intentId: string
  status: IntentState
  tier: Tier
  /** The gate's reason when policy refused the intent (state rejected), e.g. `connector_disabled`. */
  reason?: string
}

export interface ProposalResult {
  status: "proposed" | "empty" | "rejected" | "refused" | "rate_limited"
  intents: ProposedIntent[]
  retried: boolean
  /** Intents dropped because the reply held more than `maxIntentsPerRequest`. */
  limited: number
  /** Code-built: why the request was refused, rejected or rate limited. */
  reason?: string
  /** The model's own words (its reason for proposing nothing). Never part of what the owner approves. */
  modelNote?: string
}

/** Every intent kind as a write verb, so `selectTools` picks the kinds a request may propose. */
const INTENT_TOOLS: ToolDef[] = INTENT_KINDS.map((name) => ({
  type: "function",
  function: { name },
}))

/** A gate refusal of the intent at `index`, with its field paths moved under `$.intents[index]`. */
function gateFailures(
  error: GateRequestError,
  index: number
): ProposalFailure[] {
  const at = `$.intents[${String(index)}]`
  if (error.errors.length === 0) return [{ code: error.code, path: at }]
  return error.errors.map((e) => ({
    code: error.code,
    path: `${at}${e.replace(/: [\s\S]*$/, "").replace(/^\$/, "")}`,
  }))
}

/**
 * What `fence` found in the pack's members and in the fenced blocks added to the prompt (the
 * Todos and Events blocks, whose titles come from Things and the calendar), for the gate's
 * approval card: every reason anything was flagged for, in the fence's fixed order. Absent when
 * nothing was flagged, so a proposal from clean material carries no flag.
 */
function injectionFlag(
  pack: {
    members: readonly {
      injectionSuspected: boolean
      injectionReasons: readonly string[]
    }[]
  },
  blocks: readonly PromptPart[]
): { injection?: GateIntentInjection } {
  const found = [
    ...pack.members
      .filter((m) => m.injectionSuspected)
      .map((m) => m.injectionReasons),
    ...blocks.flatMap((part) =>
      typeof part !== "string" && part.injectionSuspected ? [part.reasons] : []
    ),
  ]
  if (found.length === 0) return {}
  const reasons = INJECTION_REASONS.filter((reason) =>
    found.some((r) => r.includes(reason))
  )
  return { injection: { reasons } }
}

/** Calendar kinds that name an existing event by its uid: Proton invitation operations. */
const ID_DEPENDENT_CALENDAR_KINDS: ReadonlySet<string> = new Set([
  "calendar.edit",
  "calendar.delete",
])

/**
 * The Apple events the Events block offers for `apple.event_update`, with the location and notes
 * the calendar holds for each. Only the events `listMatchingEvents` marked updatable, and only
 * while the index still has their details: an event whose details are unknown is never offered.
 */
function appleUpdateTargets(
  db: DatabaseSync,
  events: readonly EventLine[]
): AppleUpdateTarget[] {
  return events.flatMap((e): AppleUpdateTarget[] => {
    if (e.appleUpdate !== true || e.calendarId === undefined) return []
    const details = appleEventDetails(db, e.calendarId, e.uid)
    return details?.known === true
      ? [
          {
            id: e.uid,
            calendarId: e.calendarId,
            location: details.location,
            notes: details.notes,
          },
        ]
      : []
  })
}

function validConfig(config: ProposeConfig): void {
  const max = config.maxIntentsPerRequest
  if (!Number.isInteger(max) || max < 1)
    throw new RangeError(
      "maxIntentsPerRequest must be an integer of at least 1"
    )
}

/**
 * Turn a plain-language request into proposed intents: select the kinds the request may propose,
 * build a context pack from the seed, generate under the intent-result schema, check the reply and
 * submit each intent to the gate with `origin: "reactive"`. A failed reply (schema, kind,
 * reference or gate refusal) is retried once with a note naming the failures; a second failure
 * rejects the request and writes a `proposal_failures` row.
 */
export async function proposeIntents(
  request: ProposalRequest,
  deps: ProposeDeps
): Promise<ProposalResult> {
  validConfig(deps.config)
  const base = { intents: [], retried: false, limited: 0 }
  if (!deps.limiter.tryAcquire())
    return { ...base, status: "rate_limited", reason: "max_proposals_per_hour" }

  const picked =
    request.kinds === undefined
      ? selectTools({ text: request.text, task: "propose" }, INTENT_TOOLS).map(
          (tool) => tool.function.name
        )
      : [...new Set(request.kinds)].sort()
  // The Todos block exists only when an id-dependent kind is offered. A to-do intent needs an id
  // the model was shown, so with no matching to-do those kinds are not offered at all. Nor are
  // they when the two best matches are equally good: the model would pick one of them (#758).
  const listed = picked.some((k) => ID_DEPENDENT_THINGS_KINDS.has(k))
    ? listOpenTodos(deps.db, request.text)
    : { todos: [], matched: 0, ambiguous: false }
  const todos = listed.ambiguous ? { todos: [], matched: 0 } : listed
  // The Events block exists only when a calendar kind is offered, so the model can name an event
  // by its uid. Ambiguous matches get no block, as for to-dos.
  const matching = picked.some(
    (k) => k.startsWith("calendar.") || k === APPLE_EVENT_UPDATE_KIND
  )
    ? listMatchingEvents(deps.db, request.text, deps.now?.() ?? new Date())
    : { events: [], matched: 0, ambiguous: false }
  const events = matching.ambiguous ? { events: [], matched: 0 } : matching
  // When the request names an indexed event, the uid-dependent calendar kinds are offered only if
  // the best match is one they can act on: they are Proton invitation operations, and an Apple
  // Calendar event is read-only. Otherwise the model can only decline, instead of proposing an
  // intent the check refuses. With no matching event they stay offered: the uid may come from an
  // invitation in the pack.
  const best = events.events[0]
  const readOnlyTarget =
    matching.ambiguous || best?.source === APPLE_CALENDAR_CONNECTOR
  // `apple.event_update` is the Apple counterpart: offered only when the best match is an Apple
  // event the Helper will write (no attendees, not recurring) and whose location and notes core
  // knows, so it can carry them (#785). Anything else, including no match at all, offers no Apple
  // write kind: the model cannot name an event the block did not list.
  const appleTargets =
    best?.appleUpdate === true ? appleUpdateTargets(deps.db, events.events) : []
  const appleUpdate = appleTargets.length > 0
  const kinds = picked.filter(
    (k) =>
      !(todos.todos.length === 0 && ID_DEPENDENT_THINGS_KINDS.has(k)) &&
      !(readOnlyTarget && ID_DEPENDENT_CALENDAR_KINDS.has(k)) &&
      !(k === APPLE_EVENT_UPDATE_KIND && !appleUpdate)
  )
  const pin =
    request.connector === undefined ? {} : { connector: request.connector }
  const assembled = await assembleContext(
    deps.db,
    {
      seed: request.seed,
      task: "propose",
      budgetTokens: deps.config.budgetTokens,
    },
    { charsPerToken: deps.config.charsPerToken }
  )
  if ("refused" in assembled)
    return { ...base, status: "refused", reason: assembled.reason }
  const pack = assembled
  const referable = referableMessages(deps.db, pack)
  const input = {
    request: request.text,
    pack,
    referable,
    kinds,
    todos: renderTodosBlock(todos),
    events: renderEventsBlock(events, { appleUpdate }),
  }
  const draft = request.replyDraft
    ? draftBounds(deps.db, referable, request.seed)
    : undefined
  // A reply draft whose seed is not a referable message has no thread to hold it to: refuse it.
  if (request.replyDraft && draft === undefined)
    return { ...base, status: "refused", reason: "no_reply_seed" }
  const context = {
    kinds: new Set(kinds),
    referable,
    todoIds: new Set(todos.todos.map((t) => t.id)),
    isAppleEvent: (eventUid: string) => isAppleEventId(deps.db, eventUid),
    appleUpdates: appleUpdate ? appleTargets : [],
    ...(draft === undefined ? {} : { draft }),
  }
  const injection = injectionFlag(pack, [...input.todos, ...input.events])
  const sources = {
    contextPackId: pack.id,
    documentIds: pack.members.map((m) => m.sha256),
  }

  // Intents the gate stored, by their JSON, so a retry does not propose the same intent twice.
  const stored = new Map<string, ProposedIntent>()
  const codes = new Set<string>()
  let failures: ProposalFailure[] = []
  let limited = 0

  for (let attempt = 0; attempt < 2; attempt++) {
    const retried = attempt > 0
    const inference = buildProposalRequest(input, failures)
    let text: string
    try {
      text = (
        await deps.queue.run("foreground", (client) =>
          client.complete(inference)
        )
      ).text
    } catch (error) {
      if (!(error instanceof PromptTooLargeError)) throw error
      return {
        intents: [...stored.values()],
        retried,
        limited,
        status: "refused",
        reason: "prompt_too_large",
      }
    }

    const checked = checkReply(text, context, deps.config.maxIntentsPerRequest)
    failures = checked.ok ? [] : checked.failures
    if (checked.ok) {
      const kept: Intent[] = checked.intents
        .slice(0, deps.config.maxIntentsPerRequest)
        .map((intent) => ({
          ...carryAppleDetails(intent, context.appleUpdates),
          ...pin,
        }))
      limited = checked.intents.length - kept.length
      for (const [index, intent] of kept.entries()) {
        const key = JSON.stringify(intent)
        if (stored.has(key)) continue
        try {
          const proposed = await deps.gate.propose({
            intent,
            origin: "reactive",
            sources,
            ...injection,
          })
          stored.set(key, {
            intentId: proposed.id,
            status: proposed.state,
            tier: proposed.tier,
            ...(proposed.reason === undefined
              ? {}
              : { reason: proposed.reason }),
          })
        } catch (error) {
          if (!(error instanceof GateRequestError)) throw error
          failures.push(...gateFailures(error, index))
        }
      }
      if (failures.length === 0) {
        const intents = [...stored.values()]
        return {
          intents,
          retried,
          limited,
          status: intents.length === 0 ? "empty" : "proposed",
          ...(checked.note === undefined ? {} : { modelNote: checked.note }),
        }
      }
    }
    for (const failure of failures) codes.add(failure.code)
  }

  await recordProposalFailure(deps.db, {
    failedAt: (deps.now?.() ?? new Date()).toISOString(),
    requestId: request.id,
    contextPackId: pack.id,
    failureCodes: [...codes],
  })
  return {
    intents: [...stored.values()],
    retried: true,
    limited,
    status: "rejected",
    reason: "reply_failed_twice",
  }
}
