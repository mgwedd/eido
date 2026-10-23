import type { Link, LinkKind } from "./types"

export interface HeaderLinkMessage {
  docSha256: string
  messageId: string
  inReplyTo?: string
  /** The References header, in header order. */
  references?: string[]
  threadId?: string
  /** For an attachment document: the Message-ID of the message it is attached to. */
  attachmentOf?: string
}

/** Maps header values to stored documents; null when no stored document matches. */
export interface HeaderLinkResolver {
  /** The sha256 of the document with this Message-ID. */
  message: (messageId: string) => string | null
  /** The sha256 of the first document of this thread. */
  threadRoot: (threadId: string) => string | null
}

/**
 * The deterministic edges a message's headers give: reply_to (In-Reply-To), references (one per
 * References entry, in header order), thread (to the thread's first document) and attachment_of
 * (attachment to its message). Each has confidence 1 and origin `header:<name>`. A value that
 * resolves to no document gives no edge, and a document never links to itself. Pure: the same
 * input gives the same links in the same order.
 */
export function deriveHeaderLinks(
  msg: HeaderLinkMessage,
  resolve: HeaderLinkResolver
): Link[] {
  const links: Link[] = []
  const seen = new Set<string>()
  const add = (kind: LinkKind, header: string, target: string | null) => {
    if (target === null || target === msg.docSha256) return
    const key = `${kind} ${target}`
    if (seen.has(key)) return
    seen.add(key)
    links.push({
      src: `doc:${msg.docSha256}`,
      dst: `doc:${target}`,
      kind,
      confidence: 1,
      origin: `header:${header}`,
    })
  }
  if (msg.inReplyTo !== undefined) {
    add("reply_to", "in-reply-to", resolve.message(msg.inReplyTo))
  }
  for (const reference of msg.references ?? []) {
    add("references", "references", resolve.message(reference))
  }
  if (msg.threadId !== undefined) {
    add("thread", "thread-id", resolve.threadRoot(msg.threadId))
  }
  if (msg.attachmentOf !== undefined) {
    add("attachment_of", "attachment-of", resolve.message(msg.attachmentOf))
  }
  return links
}
