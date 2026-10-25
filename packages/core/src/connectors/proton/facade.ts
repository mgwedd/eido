import type { DatabaseSync } from "node:sqlite"
import type { IntentClient } from "@eido/gate"
import type {
  EmailDraftIntent,
  EmailForwardIntent,
  EmailReplyIntent,
  EmailSendIntent,
  EmailTrashIntent,
  GateIntentOrigin,
} from "@eido/schemas"
import { search } from "../../index/index"
import type { SearchHit } from "../../index/index"
import { ProtonError } from "./errors"
import { isTextMime } from "../mail/parse"
import { rationaleField } from "../proposal-rationale"
import type { ProposalNote } from "../proposal-rationale"
import type { ProfileStore } from "../../profile/store"
import { replyRecipients, storedAddresses } from "../reply-target"
import { appendDraftSignature } from "../draft-signature"
import { CONNECTOR } from "./sync"
import { CONNECTOR_NAME } from "./manifest"

export type IntentReceipt = { intentId: string }

/** What the model gives for a reply: the hash and the recipients are core's to fill. */
export type ReplyRequest = {
  messageId: string
  replyAll: boolean
  body: string
}

/** What the model gives for a forward: the hash is core's to fill. */
export type ForwardRequest = {
  messageId: string
  to: EmailForwardIntent["args"]["to"]
  note?: string
}

export type MailDocument = {
  messageId: string
  subject: string
  text: string
  occurredAt?: string
  threadId?: string
  inReplyTo?: string
}

export type AttachmentTextResult = {
  filename: string
  mime: string
  /** Null when the attachment is not a text type. */
  text: string | null
}

export type ProtonFacadeDeps = {
  db: DatabaseSync
  intents: IntentClient
  /** The assistant address: never a recipient of its own reply. */
  identity: string
  /** Profile settings used to apply the owner's signature to every new draft. */
  profile: Pick<ProfileStore, "getProfile">
  origin?: GateIntentOrigin
}

function documentRow(
  db: DatabaseSync,
  sql: string,
  ...params: string[]
): MailDocument[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((r) => {
      const field = (key: string): string | undefined =>
        typeof r[key] === "string" ? r[key] : undefined
      const occurredAt = field("occurred_at")
      const threadId = field("thread_id")
      const inReplyTo = field("in_reply_to")
      return {
        messageId: String(r["message_id"]),
        subject: field("title") ?? "",
        text: String(r["body"]),
        ...(occurredAt === undefined ? {} : { occurredAt }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
      }
    })
}

const COLUMNS = `t.message_id, t.title, t.body, t.occurred_at, t.thread_id, t.in_reply_to`
const FROM = `FROM document_text t JOIN documents d ON d.sha256 = t.sha256
  WHERE d.source = '${CONNECTOR}' AND t.message_id IS NOT NULL`

/**
 * The verbs the model sees. Reads answer from the local index only. Write verbs only propose an intent to the gate and return its id: no source call.
 */
export function createProtonFacade(deps: ProtonFacadeDeps) {
  const { db, intents, identity, profile } = deps
  const origin = deps.origin ?? "reactive"
  /** The indexed message the Message-ID names: its raw-byte hash and its stored addresses. */
  const target = (messageId: string) => {
    const row = db
      .prepare(
        `SELECT d.sha256 ${FROM} AND t.message_id = ? AND t.attachment_of IS NULL LIMIT 1`
      )
      .get(messageId)
    if (row === undefined)
      throw new ProtonError("not_found", "no such message in the index")
    const sha256 = String(row["sha256"])
    return { sha256, addresses: storedAddresses(db, sha256) }
  }
  const propose = async (
    intent: { kind: string; args: object },
    note?: ProposalNote
  ): Promise<IntentReceipt> => {
    const result = await intents.propose({
      intent: { ...intent, connector: CONNECTOR_NAME },
      origin,
      ...rationaleField(note),
    })
    return { intentId: result.id }
  }
  return {
    mail_search: (query: { text: string; limit?: number }): SearchHit[] =>
      search(db, {
        text: query.text,
        source: CONNECTOR,
        limit: query.limit ?? 20,
      }),

    mail_get: (args: { messageId: string }): MailDocument | undefined =>
      documentRow(
        db,
        `SELECT ${COLUMNS} ${FROM} AND t.message_id = ? LIMIT 1`,
        args.messageId
      )[0],

    mail_thread: (args: { messageId: string }): MailDocument[] => {
      const row = db
        .prepare(`SELECT t.thread_id ${FROM} AND t.message_id = ? LIMIT 1`)
        .get(args.messageId)
      const thread = row?.["thread_id"]
      if (typeof thread !== "string") return []
      return documentRow(
        db,
        `SELECT ${COLUMNS} ${FROM} AND t.thread_id = ? ORDER BY t.occurred_at, t.sha256`,
        thread
      )
    },

    attachment_text: (args: {
      messageId: string
      attachmentIndex: number
    }): AttachmentTextResult => {
      const row = db
        .prepare(
          `SELECT d.mime, t.title, t.body
           FROM document_text t JOIN documents d ON d.sha256 = t.sha256
           WHERE d.source = '${CONNECTOR}' AND t.attachment_of = ? AND d.source_ref = ?`
        )
        .get(args.messageId, `${args.messageId}#${args.attachmentIndex}`)
      if (row === undefined)
        throw new ProtonError("not_found", "the message has no such attachment")
      const mime = String(row["mime"])
      return {
        filename: String(row["title"]),
        mime,
        text: isTextMime(mime) ? String(row["body"]) : null,
      }
    },

    draft_create: async (
      args: EmailDraftIntent["args"],
      note?: ProposalNote
    ) => {
      const owner = await profile.getProfile()
      return propose(
        {
          kind: "email.draft",
          args: {
            ...args,
            body: appendDraftSignature(args.body, owner?.signature ?? ""),
          },
        },
        note
      )
    },
    send: (args: EmailSendIntent["args"], note?: ProposalNote) =>
      propose({ kind: "email.send", args }, note),
    reply: (args: ReplyRequest, note?: ProposalNote) => {
      // Only the named fields pass: a hash or recipients in model output are dropped, not trusted.
      const { sha256, addresses } = target(args.messageId)
      const { to, cc } = replyRecipients(addresses, args.replyAll, identity)
      if (to.length === 0)
        throw new ProtonError(
          "no_recipients",
          "the message yields no recipient to reply to"
        )
      return propose(
        {
          kind: "email.reply",
          args: {
            messageId: args.messageId,
            messageSha256: sha256,
            replyAll: args.replyAll,
            to,
            ...(cc.length === 0 ? {} : { cc }),
            body: args.body,
          } satisfies EmailReplyIntent["args"],
        },
        note
      )
    },
    forward: (args: ForwardRequest, note?: ProposalNote) =>
      propose(
        {
          kind: "email.forward",
          args: {
            messageId: args.messageId,
            messageSha256: target(args.messageId).sha256,
            to: args.to,
            ...(args.note === undefined ? {} : { note: args.note }),
          } satisfies EmailForwardIntent["args"],
        },
        note
      ),
    trash: (args: EmailTrashIntent["args"], note?: ProposalNote) =>
      propose({ kind: "email.trash", args }, note),
  }
}

export type ProtonFacade = ReturnType<typeof createProtonFacade>
