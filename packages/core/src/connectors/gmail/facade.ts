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
import type { SearchHit } from "../../index/index"
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
  /** Null when the attachment is not a text type. */
  text: string | null
}>

export type GmailFacadeDeps = {
  db: DatabaseSync
  intents: IntentClient
  origin?: GateIntentOrigin
}

const FROM = `FROM document_text t JOIN documents d ON d.sha256 = t.sha256
  WHERE d.source = '${GMAIL_SOURCE}' AND t.attachment_of IS NULL`
const COLUMNS = `d.source_ref, t.message_id, t.title, t.body, t.occurred_at, t.thread_id`

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
  const { db, intents } = deps
  const origin = deps.origin ?? "reactive"
  const propose = async (intent: {
    kind: string
    args: object
  }): Promise<GmailIntentReceipt> => {
    const result = await intents.propose({ intent, origin })
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
      const hasText = row["body"] !== ""
      return {
        filename: String(row["title"]),
        mime: String(row["mime"]),
        text: hasText ? String(row["body"]) : null,
        untrusted: true,
      }
    },

    draft_create: (args: EmailDraftIntent["args"]) =>
      propose({ kind: "email.draft", args }),
    label: (args: EmailLabelIntent["args"]) =>
      propose({ kind: "email.label", args }),
    archive: (args: EmailArchiveIntent["args"]) =>
      propose({ kind: "email.archive", args }),
    mark_read: (args: EmailMarkReadIntent["args"]) =>
      propose({ kind: "email.markRead", args }),
    send: (args: EmailSendIntent["args"]) =>
      propose({ kind: "email.send", args }),
    reply: (args: EmailReplyIntent["args"]) =>
      propose({ kind: "email.reply", args }),
    forward: (args: EmailForwardIntent["args"]) =>
      propose({ kind: "email.forward", args }),
    trash: (args: EmailTrashIntent["args"]) =>
      propose({ kind: "email.trash", args }),
  }
}

export type GmailFacade = ReturnType<typeof createGmailFacade>
