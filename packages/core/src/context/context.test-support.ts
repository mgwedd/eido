// Synthetic mail for context tests: invented names, example.invalid addresses, filler text.
import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { ingestBatch } from "../index/ingest"
import type { IndexedDocument } from "../index/ingest"

export const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex")

const PEOPLE = ["Ada Quill", "Bram Oster", "Cleo Varn", "Dov Pellam"]
const FILLER =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."

const address = (name: string): string =>
  `${name.toLowerCase().replace(" ", ".")}@example.invalid`

export interface MailSpec {
  id: string
  date: string
  subject?: string
  body: string
  from?: string
  to?: string[]
  messageId?: string
  inReplyTo?: string
  references?: string[]
  threadId?: string
}

export function mail(spec: MailSpec): IndexedDocument {
  const from = spec.from ?? "Ada Quill"
  const to = spec.to ?? ["Bram Oster"]
  return {
    sha256: sha(spec.id),
    source: "gmail",
    sourceRef: spec.id,
    mime: "message/rfc822",
    title: spec.subject ?? "Quarterly plan",
    body: spec.body,
    occurredAt: spec.date,
    headers: {
      messageId: spec.messageId ?? `<${spec.id}@example.invalid>`,
      ...(spec.inReplyTo === undefined ? {} : { inReplyTo: spec.inReplyTo }),
      ...(spec.references === undefined ? {} : { references: spec.references }),
      ...(spec.threadId === undefined ? {} : { threadId: spec.threadId }),
    },
    addresses: [
      { role: "from", address: address(from) },
      ...to.map((n) => ({ role: "to" as const, address: address(n) })),
    ],
  }
}

export function attachment(
  id: string,
  parentRef: string,
  body: string
): IndexedDocument {
  return {
    sha256: sha(id),
    source: "gmail",
    sourceRef: `${parentRef}#0`,
    mime: "text/plain",
    title: `${id}.txt`,
    body,
    headers: { attachmentOf: parentRef },
  }
}

export function ingest(db: DatabaseSync, documents: IndexedDocument[]): void {
  ingestBatch(db, {
    connector: "gmail",
    stream: "inbox",
    documents,
    nextCursor: "c",
  })
}

/**
 * A thread of `count` messages, each replying to the previous one and quoting it, with one to three
 * filler paragraphs of new text. Dates rise by one hour per message.
 */
export function generateThread(
  count: number,
  threadId = "t-200"
): IndexedDocument[] {
  const docs: IndexedDocument[] = []
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `${threadId}-m${i}`
    const messageId = `<${id}@example.invalid>`
    const author = PEOPLE[i % PEOPLE.length] ?? "Ada Quill"
    const reader = PEOPLE[(i + 1) % PEOPLE.length] ?? "Bram Oster"
    const fresh = Array.from(
      { length: 1 + (i % 3) },
      (_, k) => `Point ${i}.${k}: ${FILLER}`
    ).join("\n\n")
    const previous = i === 0 ? "" : `Point ${i - 1}.0: ${FILLER}`
    const quoted =
      i === 0
        ? ""
        : `\n\nOn 2030-01-01, ${PEOPLE[(i - 1) % PEOPLE.length] ?? ""} wrote:\n> ${previous}\n> ${FILLER}`
    const date = new Date(Date.UTC(2030, 0, 1, i)).toISOString()
    docs.push(
      mail({
        id,
        date,
        subject: "Re: Quarterly plan",
        body: `${fresh}${quoted}`,
        from: author,
        to: [reader],
        messageId,
        ...(i === 0 ? {} : { inReplyTo: ids[i - 1] }),
        references: ids.slice(-10),
        threadId,
      })
    )
    ids.push(messageId)
  }
  return docs
}
