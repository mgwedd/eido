import { validateIntentResult } from "@eido/schemas"
import type { Intent } from "@eido/schemas"
import { ID_DEPENDENT_THINGS_KINDS } from "../context/tools"
import { parseAddress } from "./draft-recipients"
import type { DraftBounds } from "./draft-recipients"
import type { ProposalFailure, ReferableMessage } from "./prompt"

export type CheckedReply =
  | { ok: true; intents: Intent[]; note?: string }
  | { ok: false; failures: ProposalFailure[] }

export interface CheckContext {
  /** The intent kinds offered for the request. */
  kinds: ReadonlySet<string>
  referable: readonly ReferableMessage[]
  /** The ids of the to-dos shown in the Todos block. A to-do intent may name only these. */
  todoIds?: ReadonlySet<string>
  /**
   * Set for a reply draft: every `email.draft` must go only to people on the seed's thread, with
   * no bcc, and reply only to the seed message.
   */
  draft?: DraftBounds
}

/** Args that name a message by its connector id. */
const MESSAGE_ID_FIELDS = ["messageId", "inReplyToMessageId"] as const

/** "$.intents[0].args.to: required" → "$.intents[0].args.to"; validator errors never carry values. */
function pathOf(error: string): string {
  return error.replace(/: [\s\S]*$/, "")
}

function referenceFailures(
  intent: Intent,
  at: string,
  context: CheckContext
): ProposalFailure[] {
  const ids = new Set(context.referable.map((m) => m.messageId))
  const hashes = new Set(context.referable.map((m) => m.messageSha256))
  const args: Record<string, unknown> = { ...intent.args }
  const failures: ProposalFailure[] = []
  const unknown = (path: string): void => {
    failures.push({ code: "unknown_reference", path })
  }
  for (const field of MESSAGE_ID_FIELDS) {
    const value = args[field]
    if (typeof value === "string" && !ids.has(value))
      unknown(`${at}.args.${field}`)
  }
  const list = args["messageIds"]
  if (Array.isArray(list)) {
    list.forEach((value, i) => {
      if (typeof value === "string" && !ids.has(value))
        unknown(`${at}.args.messageIds[${String(i)}]`)
    })
  }
  const hash = args["messageSha256"]
  if (typeof hash === "string" && !hashes.has(hash))
    unknown(`${at}.args.messageSha256`)
  return failures
}

/** An intent on an existing to-do must carry an id the Todos block showed. */
function todoFailures(
  intent: Intent,
  at: string,
  shown: ReadonlySet<string>
): ProposalFailure[] {
  if (!ID_DEPENDENT_THINGS_KINDS.has(intent.kind)) return []
  const id = (intent.args as Record<string, unknown>)["id"]
  return typeof id === "string" && shown.has(id)
    ? []
    : [{ code: "unknown_reference", path: `${at}.args.id` }]
}

function draftFailures(
  intent: Intent,
  at: string,
  bounds: DraftBounds
): ProposalFailure[] {
  if (intent.kind !== "email.draft") return []
  const args: Record<string, unknown> = { ...intent.args }
  const failures: ProposalFailure[] = []
  for (const field of ["to", "cc"] as const) {
    const list = args[field]
    if (!Array.isArray(list)) continue
    list.forEach((value, i) => {
      const address = typeof value === "string" ? parseAddress(value) : null
      if (address === null || !bounds.allowed.has(address))
        failures.push({
          code: "recipient_not_on_thread",
          path: `${at}.args.${field}[${String(i)}]`,
        })
    })
  }
  const bcc = args["bcc"]
  if (Array.isArray(bcc) && bcc.length > 0)
    failures.push({ code: "bcc_not_allowed", path: `${at}.args.bcc` })
  const replyTo = args["inReplyToMessageId"]
  if (replyTo !== undefined && replyTo !== bounds.seedMessageId)
    failures.push({
      code: "reply_target_not_seed",
      path: `${at}.args.inReplyToMessageId`,
    })
  return failures
}

/**
 * Parse and check one model reply: the whole reply against the intent-result schema, then, for the
 * first `maxIntents` intents (the caller drops the rest), that each kind was offered and that every
 * message it names is in the context pack.
 */
export function checkReply(
  text: string,
  context: CheckContext,
  maxIntents: number
): CheckedReply {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, failures: [{ code: "invalid_json", path: "$" }] }
  }
  const result = validateIntentResult(parsed)
  if (!result.ok)
    return {
      ok: false,
      failures: result.errors.map((error) => ({
        code: "schema_mismatch",
        path: pathOf(error),
      })),
    }
  if (result.value.result === "none")
    return { ok: true, intents: [], note: result.value.reason }

  const intents = result.value.intents
  const failures = intents.slice(0, maxIntents).flatMap((intent, i) => {
    const at = `$.intents[${String(i)}]`
    if (!context.kinds.has(intent.kind))
      return [{ code: "kind_not_offered", path: `${at}.kind` }]
    return [
      ...referenceFailures(intent, at, context),
      ...todoFailures(intent, at, context.todoIds ?? new Set()),
      ...(context.draft === undefined
        ? []
        : draftFailures(intent, at, context.draft)),
    ]
  })
  return failures.length === 0 ? { ok: true, intents } : { ok: false, failures }
}
