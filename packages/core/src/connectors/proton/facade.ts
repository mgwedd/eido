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
import { search } from "../../index"
import type { SearchHit } from "../../index"
import type { ProtonConfig } from "./config"
import type { ConnectionFactory } from "./connection"
import { ProtonError } from "./errors"
import { connectImap } from "./imap-client"
import { attachmentText, parseMessage } from "./mime"
import { CONNECTOR } from "./sync"

export type IntentReceipt = { intentId: string }

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
  config: ProtonConfig
  /** Used by attachment_text only. The facade's write verbs never open a connection. */
  connect: ConnectionFactory
  intents: IntentClient
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
 * The verbs the model sees. Reads answer from the local index (and, for attachments, a live IMAP
 * read). Write verbs only propose an intent to the gate and return its id: no SMTP, no IMAP write.
 */
export function createProtonFacade(deps: ProtonFacadeDeps) {
  const { db, config, connect, intents } = deps
  const origin = deps.origin ?? "reactive"
  const propose = async (intent: {
    kind: string
    args: object
  }): Promise<IntentReceipt> => {
    const result = await intents.propose({ intent, origin })
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

    attachment_text: async (args: {
      messageId: string
      attachmentIndex: number
      folder?: string
    }): Promise<AttachmentTextResult> => {
      const client = await connectImap(connect, config)
      try {
        for (const folder of args.folder === undefined
          ? config.folders
          : [args.folder]) {
          await client.select(folder)
          const uid = (await client.searchMessageId(args.messageId))[0]
          if (uid === undefined) continue
          const raw = await client.fetchOne(uid)
          if (raw === undefined) continue
          const attachment = parseMessage(raw).attachments[args.attachmentIndex]
          if (attachment === undefined)
            throw new ProtonError(
              "not_found",
              "the message has no such attachment"
            )
          return {
            filename: attachment.filename,
            mime: attachment.mime,
            text: attachmentText(attachment),
          }
        }
        throw new ProtonError(
          "not_found",
          "no such message in the configured folders"
        )
      } finally {
        await client.close()
      }
    },

    draft_create: (args: EmailDraftIntent["args"]) =>
      propose({ kind: "email.draft", args }),
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

export type ProtonFacade = ReturnType<typeof createProtonFacade>
