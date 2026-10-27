import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import type { IntentClient } from "@eido/gate"
import type {
  EmailArchiveIntent,
  EmailDraftIntent,
  EmailForwardIntent,
  EmailLabelIntent,
  EmailMarkReadIntent,
  EmailReplyIntent,
  EmailSendIntent,
  EmailTrashIntent,
  GateIntentOrigin,
} from "@eido/schemas"
import { search } from "../../index/index"
import { isPdfMime, isTextMime } from "../mail/parse"
import type { SearchHit } from "../../index/index"
import { rationaleField } from "../proposal-rationale"
import type { ProposalNote } from "../proposal-rationale"
import type { ProfileStore } from "../../profile/store"
import { replyRecipients, storedAddresses } from "../reply-target"
import { appendDraftSignature } from "../draft-signature"
import { GmailError } from "./errors"
import { GMAIL_SOURCE } from "./routes"

export type GmailIntentReceipt = { intentId: string }

/**
 * Everything a read verb returns carries `untrusted: true`: message bodies, snippets and
 * attachment text were written by other people and may contain instructions aimed at the model.
 */
export type Untrusted<T> = T & { untrusted: true }

export type GmailMessage = Untrusted<{
  /** Gmail's message id: the id write verbs take. */
  messageId: string
  /** SHA-256 of the raw message: reply and forward bind to it, so a planted look-alike is never the target. */
  sha256: string
  /** The RFC 5322 Message-ID header, when the message has one. */
  headerMessageId?: string
  threadId?: string
  subject: string
  text: string
  occurredAt?: string
}>

export type GmailAttachmentText = Untrusted<{
  filename: string
  mime: string
  /** Null when the attachment is not a text type or PDF, or a PDF had no readable text. */
  text: string | null
}>

/** What the model gives for a reply: the hash and the recipients are core's to fill. */
export type GmailReplyRequest = {
  messageId: string
  replyAll: boolean
  body: string
}

/** What the model gives for a forward: the hash is core's to fill. */
export type GmailForwardRequest = {
  messageId: string
  to: EmailForwardIntent["args"]["to"]
  note?: string
}

export type GmailFacadeDeps = {
  db: DatabaseSync
  intents: IntentClient
  /** The assistant's Gmail address: never a recipient of its own reply. */
  identity: string
  /** Profile settings used to apply the owner's signature to every new draft. */
  profile: Pick<ProfileStore, "getProfile">
  origin?: GateIntentOrigin
}

const FROM = `FROM document_text t JOIN documents d ON d.sha256 = t.sha256
  WHERE d.source = '${GMAIL_SOURCE}' AND t.attachment_of IS NULL`
const COLUMNS = `d.sha256, d.source_ref, t.message_id, t.title, t.body, t.occurred_at, t.thread_id`

function messages(
  db: DatabaseSync,
  where: string,
  ...params: SQLInputValue[]
): GmailMessage[] {
  return db
    .prepare(`SELECT ${COLUMNS} ${FROM} ${where}`)
    .all(...params)
    .map((row) => {
      const text = (key: string): string | undefined => {
        const value = row[key]
        return typeof value === "string" ? value : undefined
      }
      const headerMessageId = text("message_id")
      const threadId = text("thread_id")
      const occurredAt = text("occurred_at")
      return {
        messageId: String(row["source_ref"]),
        sha256: String(row["sha256"]),
        ...(headerMessageId === undefined ? {} : { headerMessageId }),
        ...(threadId === undefined ? {} : { threadId }),
        subject: text("title") ?? "",
        text: String(row["body"]),
        ...(occurredAt === undefined ? {} : { occurredAt }),
        untrusted: true,
      }
    })
}

/**
 * The verbs the model sees. Read verbs answer from the local index. Write verbs only propose an
 * intent to the gate and return its id; they make no Gmail request. The gate tiers the intent and
 * its executor performs it.
 */
export function createGmailFacade(deps: GmailFacadeDeps) {
  const { db, intents, identity, profile } = deps
  const origin = deps.origin ?? "reactive"
  /** The indexed message the Gmail id names: its raw-byte hash and its stored addresses. */
  const target = (messageId: string) => {
    const row = db
      .prepare(`SELECT d.sha256 ${FROM} AND d.source_ref = ? LIMIT 1`)
      .get(messageId)
    if (row === undefined)
      throw new GmailError("not_found", "no such message in the index")
    const sha256 = String(row["sha256"])
    return { sha256, addresses: storedAddresses(db, sha256) }
  }
  const propose = async (
    intent: { kind: string; args: object },
    note?: ProposalNote
  ): Promise<GmailIntentReceipt> => {
    const result = await intents.propose({
      intent: { ...intent, connector: GMAIL_SOURCE },
      origin,
      ...rationaleField(note),
    })
    return { intentId: result.id }
  }
  return {
    mail_search: (query: {
      text: string
      limit?: number
    }): Untrusted<SearchHit>[] =>
      search(db, {
        text: query.text,
        source: GMAIL_SOURCE,
        limit: query.limit ?? 20,
      }).map((hit) => ({ ...hit, untrusted: true })),

    mail_get: (args: { messageId: string }): GmailMessage | undefined =>
      messages(db, "AND d.source_ref = ? LIMIT 1", args.messageId)[0],

    mail_thread: (args: { threadId: string }): GmailMessage[] =>
      messages(
        db,
        "AND t.thread_id = ? ORDER BY t.occurred_at, d.source_ref",
        args.threadId
      ),

    attachment_text: (args: {
      messageId: string
      attachmentIndex: number
    }): GmailAttachmentText => {
      const row = db
        .prepare(
          `SELECT d.mime, t.title, t.body
           FROM document_text t JOIN documents d ON d.sha256 = t.sha256
           WHERE d.source = '${GMAIL_SOURCE}' AND t.attachment_of = ? AND d.source_ref = ?`
        )
        .get(args.messageId, `${args.messageId}#${args.attachmentIndex}`)
      if (row === undefined)
        throw new GmailError("not_found", "the message has no such attachment")
      const mime = String(row["mime"])
      const body = String(row["body"])
      const readable = isTextMime(mime) || (isPdfMime(mime) && body !== "")
      return {
        filename: String(row["title"]),
        mime,
        text: readable ? body : null,
        untrusted: true,
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
    label: (args: EmailLabelIntent["args"], note?: ProposalNote) =>
      propose({ kind: "email.label", args }, note),
    archive: (args: EmailArchiveIntent["args"], note?: ProposalNote) =>
      propose({ kind: "email.archive", args }, note),
    mark_read: (args: EmailMarkReadIntent["args"], note?: ProposalNote) =>
      propose({ kind: "email.markRead", args }, note),
    send: (args: EmailSendIntent["args"], note?: ProposalNote) =>
      propose({ kind: "email.send", args }, note),
    reply: (args: GmailReplyRequest, note?: ProposalNote) => {
      // Only the named fields pass: a hash or recipients in model output are dropped, not trusted.
      const { sha256, addresses } = target(args.messageId)
      const { to, cc } = replyRecipients(addresses, args.replyAll, identity)
      if (to.length === 0)
        throw new GmailError(
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
    forward: (args: GmailForwardRequest, note?: ProposalNote) =>
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

export type GmailFacade = ReturnType<typeof createGmailFacade>
