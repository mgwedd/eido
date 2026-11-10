import type { DatabaseSync } from "node:sqlite"
import { GateRequestError } from "@eido/gate"
import type { IntentClient, IntentState, Tier } from "@eido/gate"
import { INTENT_KINDS } from "@eido/schemas"
import type { GateIntentInjection, Intent } from "@eido/schemas"
import { assembleContext } from "../context/assemble"
import { selectTools } from "../context/tools"
import { PromptTooLargeError } from "../inference/errors"
import { INJECTION_REASONS } from "../inference/fence"
import type { InferenceQueue } from "../inference/queue"
import type { ToolDef } from "../inference/types"
import { checkReply } from "./check"
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
 * What `fence` found in the pack's members, for the gate's approval card: every reason any member
 * was flagged for, in the fence's fixed order. Absent when no member was flagged, so a proposal
 * from clean material carries no flag.
 */
function injectionFlag(pack: {
  members: readonly {
    injectionSuspected: boolean
    injectionReasons: readonly string[]
  }[]
}): { injection?: GateIntentInjection } {
  const flagged = pack.members.filter((m) => m.injectionSuspected)
  if (flagged.length === 0) return {}
  const reasons = INJECTION_REASONS.filter((reason) =>
    flagged.some((m) => m.injectionReasons.includes(reason))
  )
  return { injection: { reasons } }
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

  const kinds =
    request.kinds === undefined
      ? selectTools({ text: request.text, task: "propose" }, INTENT_TOOLS).map(
          (tool) => tool.function.name
        )
      : [...new Set(request.kinds)].sort()
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
  const input = { request: request.text, pack, referable, kinds }
  const draft = request.replyDraft
    ? draftBounds(deps.db, referable, request.seed)
    : undefined
  // A reply draft whose seed is not a referable message has no thread to hold it to: refuse it.
  if (request.replyDraft && draft === undefined)
    return { ...base, status: "refused", reason: "no_reply_seed" }
  const context = {
    kinds: new Set(kinds),
    referable,
    ...(draft === undefined ? {} : { draft }),
  }
  const injection = injectionFlag(pack)
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
        .map((intent) => ({ ...intent, ...pin }))
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
