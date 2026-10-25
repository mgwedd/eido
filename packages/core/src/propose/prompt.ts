import type { DatabaseSync } from "node:sqlite"
import { INTENT_PROMPT_TEXT, INTENT_RESULT_JSON_SCHEMA } from "@eido/schemas"
import { COMPACTION_LEGEND } from "../context/compact"
import { blockParts } from "../context/pack-store"
import type { ContextPack } from "../context/pack-store"
import { MATERIAL_RULES } from "../inference/fence"
import type { PromptPart } from "../inference/fence"
import type { InferenceRequest } from "../inference/types"

/** A pack member the model may name in an intent: the connector's message id and the raw message hash. */
export interface ReferableMessage {
  tag: string
  messageId: string
  messageSha256: string
}

/** One reason a reply was refused: a code and a field path, never a value. */
export interface ProposalFailure {
  code: string
  path: string
}

/** At most this many failures are named in a retry note, so the note stays short. */
const MAX_NOTED_FAILURES = 10

/**
 * The stable prefix: identical for every request, so the server can reuse its prompt cache.
 * Nothing from the request or the pack goes here.
 */
export const PROPOSE_SYSTEM_PROMPT = [
  "You propose writes for the owner's request. You only propose: nothing runs until the owner approves it.",
  'Reply with JSON only: {"result":"intents","intents":[...]} with the intents that carry out the request, or {"result":"none","reason":"..."} when nothing should be done.',
  "Use only the intent kinds offered for the request. Refer to messages only by the ids listed under Messages you may refer to.",
  MATERIAL_RULES,
  COMPACTION_LEGEND,
  INTENT_PROMPT_TEXT,
].join("\n\n")

/** The pack members that are messages (not attachments), with the ids an intent may use. */
export function referableMessages(
  db: DatabaseSync,
  pack: ContextPack
): ReferableMessage[] {
  const row = db.prepare(
    "SELECT d.source_ref, t.attachment_of FROM documents d JOIN document_text t ON t.sha256 = d.sha256 WHERE d.sha256 = ?"
  )
  return pack.members.flatMap((member) => {
    const found = row.get(member.sha256)
    if (found === undefined || found["attachment_of"] !== null) return []
    return [
      {
        tag: member.tag,
        messageId: String(found["source_ref"]),
        messageSha256: member.sha256,
      },
    ]
  })
}

export interface PromptInput {
  /** The owner's request text: trusted. */
  request: string
  pack: ContextPack
  referable: ReferableMessage[]
  /** The intent kinds offered for this request, sorted. */
  kinds: string[]
}

/** The note a retry adds: each failure by code and field path, never a value. */
export function retryNote(failures: readonly ProposalFailure[]): string {
  const named = failures
    .slice(0, MAX_NOTED_FAILURES)
    .map((f) => `- ${f.code} at ${f.path}`)
  const more = failures.length - named.length
  return [
    "Your previous reply was refused. Fix these and reply again:",
    ...named,
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
  ].join("\n")
}

/**
 * The stable prefix, then one user message: the ids the intents may use, the pack's material
 * blocks, then the offered kinds and the owner's request, after the last block. A retry passes
 * the failures of the first reply, which adds the retry note at the end.
 */
export function buildProposalRequest(
  input: PromptInput,
  failures: readonly ProposalFailure[] = []
): InferenceRequest {
  const ids =
    input.referable.length === 0
      ? "(none)"
      : input.referable
          .map(
            (m) =>
              `${m.tag} messageId: ${m.messageId} | messageSha256: ${m.messageSha256}`
          )
          .join("\n")
  const task = [
    `Intent kinds offered for this request: ${input.kinds.length === 0 ? "(none)" : input.kinds.join(", ")}`,
    `Owner request:\n${input.request}`,
    ...(failures.length === 0 ? [] : [retryNote(failures)]),
  ]
  const content: PromptPart[] = [
    `Messages you may refer to:\n${ids}\n\nMessages:`,
    ...input.pack.blocks.flatMap(blockParts),
    `\n\n${task.join("\n\n")}`,
  ]
  return {
    system: PROPOSE_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    jsonSchema: { ...INTENT_RESULT_JSON_SCHEMA },
    temperature: 0,
  }
}
