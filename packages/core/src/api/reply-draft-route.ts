import type { DatabaseSync } from "node:sqlite"
import type { IntentClient } from "@eido/gate"
import type { CoreApiError, CoreApiReplyDraftResponse } from "@eido/schemas"
import { GMAIL_CONNECTOR } from "../connectors/gmail/routes"
import { CONNECTOR_NAME as PROTON_MANIFEST_NAME } from "../connectors/proton/manifest"
import { writeQueueFor } from "../db/write-queue"
import type { InferenceQueue } from "../inference/queue"
import type { ProposalLimiter } from "../propose/limiter"
import { proposeIntents } from "../propose/propose"
import type { ProposalResult, ProposedIntent } from "../propose/propose"
import {
  draftStateIsLive,
  liveDraftStatus,
  storedDraftIntentIds,
} from "./reply-draft-live"

// POST /replies/draft (#540): draft one reply for the thread of an open owed-reply obligation.
// The model is offered email.draft and nothing else, at most one intent is kept, and the intent
// goes to the gate pinned to the connector the thread came from. One live draft intent per
// thread: a repeat call returns the stored one, and concurrent calls for a thread run one at a
// time, so the second sees the first one's draft. A discarded draft (#549) no longer counts.

export const REPLY_DRAFT_PATH = "/replies/draft"

/** The owner's words for the model: fixed, so no message text or header lands in the trusted part. */
export const REPLY_DRAFT_REQUEST_TEXT =
  "Draft one reply (email.draft) to the newest message in this thread from the other party. Address it to that message's sender, set inReplyToMessageId to that message's id, and keep the subject. Do not send anything."

/**
 * The gate's pinned connector name to put on the intent, by the document source of the thread's
 * anchor message. Mail from any other source has no draft writer.
 */
const DRAFT_CONNECTORS: Readonly<Record<string, string>> = {
  gmail: GMAIL_CONNECTOR,
  proton: PROTON_MANIFEST_NAME,
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS reply_drafts (
  thread_key TEXT PRIMARY KEY,
  obligation_id INTEGER NOT NULL,
  intent_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)`

export interface ReplyDraftDeps {
  /** eido-data.db: obligations, the index the context pack is built from, and `reply_drafts`. */
  db: DatabaseSync
  /** The gate's intent API: `propose` stores the draft intent, `status` says whether a stored one is live. */
  gate: Pick<IntentClient, "propose" | "status">
  queue: () => Promise<InferenceQueue>
  limiter: ProposalLimiter
  /** Context budget for the draft's pack, in estimated tokens. Read per call: it can depend on the model. */
  budgetTokens: () => number
  charsPerToken: number
  now?: () => Date
}

export type ReplyDraftResult =
  | { ok: true; status: 200 | 201; body: CoreApiReplyDraftResponse }
  | {
      ok: false
      code: CoreApiError["error"]["code"]
      message: string
      fields?: { field: string; message: string }[]
    }

/** Drafts a reply for the obligation with this id (from a validated `CoreApiReplyDraftRequest`). */
export type ReplyDrafter = (obligationId: number) => Promise<ReplyDraftResult>

interface Obligation {
  direction: string | null
  status: string
  threadKey: string | null
  seed: string
  source: string | null
}

function readObligation(db: DatabaseSync, id: number): Obligation | undefined {
  const row = db
    .prepare(
      "SELECT o.direction, o.status, o.thread_id, o.doc_id, d.source FROM obligations o LEFT JOIN documents d ON d.sha256 = o.doc_id WHERE o.id = ?"
    )
    .get(id)
  if (row === undefined) return undefined
  const text = (value: unknown): string | null =>
    typeof value === "string" ? value : null
  return {
    direction: text(row["direction"]),
    status: String(row["status"]),
    threadKey: text(row["thread_id"]),
    seed: String(row["doc_id"]),
    source: text(row["source"]),
  }
}

export function activityHref(intentId: string): string {
  return `/activity?intent=${encodeURIComponent(intentId)}`
}

/** The stored draft intent for the thread while the gate still holds it live, else null. */
async function liveDraft(
  deps: ReplyDraftDeps,
  threadKey: string
): Promise<CoreApiReplyDraftResponse | null> {
  const id = storedDraftIntentIds(deps.db, [threadKey]).get(threadKey)
  if (id === undefined) return null
  const status = await liveDraftStatus(deps.gate, id)
  if (status === null) return null
  return {
    intentId: status.id,
    tier: status.tier,
    state: status.state,
    activityHref: activityHref(status.id),
    created: false,
  }
}

function noDraft(result: ProposalResult): ReplyDraftResult {
  if (result.status === "rate_limited")
    return { ok: false, code: "busy", message: "too many drafts this hour" }
  if (result.intents.some((i) => i.reason === "connector_disabled"))
    return {
      ok: false,
      code: "connector_paused",
      message: "the mail connector is paused",
    }
  if (result.intents.length > 0)
    return {
      ok: false,
      code: "no_draft",
      message: "the gate refused the draft",
    }
  if (result.status === "refused")
    return {
      ok: false,
      code: "no_draft",
      message: "the thread is too large to draft from",
    }
  if (result.status === "empty")
    return {
      ok: false,
      code: "no_draft",
      message: "the model proposed no draft",
    }
  return {
    ok: false,
    code: "no_draft",
    message: "the model's draft failed its checks twice",
  }
}

async function draft(
  deps: ReplyDraftDeps,
  obligationId: number,
  obligation: Obligation & { threadKey: string },
  connector: string
): Promise<ReplyDraftResult> {
  const live = await liveDraft(deps, obligation.threadKey)
  if (live !== null) return { ok: true, status: 200, body: live }

  const result = await proposeIntents(
    {
      id: `reply-draft-${String(obligationId)}`,
      text: REPLY_DRAFT_REQUEST_TEXT,
      seed: obligation.seed,
      kinds: ["email.draft"],
      connector,
      replyDraft: true,
    },
    {
      db: deps.db,
      queue: await deps.queue(),
      gate: deps.gate,
      limiter: deps.limiter,
      config: {
        budgetTokens: deps.budgetTokens(),
        maxIntentsPerRequest: 1,
        charsPerToken: deps.charsPerToken,
      },
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }
  )
  const stored: ProposedIntent | undefined = result.intents.find((i) =>
    draftStateIsLive(i.status)
  )
  if (stored === undefined) return noDraft(result)

  const createdAt = (deps.now?.() ?? new Date()).toISOString()
  await writeQueueFor(deps.db).run(() => {
    deps.db.exec(CREATE_TABLE)
    deps.db
      .prepare(
        "INSERT INTO reply_drafts (thread_key, obligation_id, intent_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (thread_key) DO UPDATE SET obligation_id = excluded.obligation_id, intent_id = excluded.intent_id, created_at = excluded.created_at"
      )
      .run(obligation.threadKey, obligationId, stored.intentId, createdAt)
  })
  return {
    ok: true,
    status: 201,
    body: {
      intentId: stored.intentId,
      tier: stored.tier,
      state: stored.status,
      activityHref: activityHref(stored.intentId),
      created: true,
    },
  }
}

/**
 * The POST /replies/draft work. The body names an open owed-reply obligation; the reply is
 * drafted from its anchor message's thread. Errors: not_found (no such obligation), invalid (not
 * an owed reply, or mail no draft writer handles), invalid_transition (the obligation is not
 * open), connector_paused, no_draft, and busy when the hourly draft limit is reached.
 */
export function createReplyDrafter(deps: ReplyDraftDeps): ReplyDrafter {
  // Per thread, the tail of the calls running for it: a call starts once the one before settled.
  const running = new Map<string, Promise<unknown>>()

  return async (id) => {
    const obligation = readObligation(deps.db, id)
    if (obligation === undefined)
      return { ok: false, code: "not_found", message: "no such obligation" }
    const { threadKey } = obligation
    if (obligation.direction !== "owed" || threadKey === null)
      return {
        ok: false,
        code: "invalid",
        message: "the obligation is not a reply owed",
        fields: [{ field: "obligationId", message: "not a reply owed" }],
      }
    if (obligation.status !== "open")
      return {
        ok: false,
        code: "invalid_transition",
        message: "the obligation is not open",
      }
    const connector =
      obligation.source === null
        ? undefined
        : DRAFT_CONNECTORS[obligation.source]
    if (connector === undefined)
      return {
        ok: false,
        code: "invalid",
        message: "the thread's mail has no draft connector",
        fields: [{ field: "obligationId", message: "no draft connector" }],
      }

    const before = running.get(threadKey) ?? Promise.resolve()
    const run = before.then(
      () => draft(deps, id, { ...obligation, threadKey }, connector),
      () => draft(deps, id, { ...obligation, threadKey }, connector)
    )
    running.set(threadKey, run)
    try {
      return await run
    } finally {
      if (running.get(threadKey) === run) running.delete(threadKey)
    }
  }
}
