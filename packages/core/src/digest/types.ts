// Digests of long threads and documents. Data plane only: no network, no tokens. A digest is a
// lossy summary, so it never answers whether something happened; that goes to search.

/** A source a digest line points to: a message of a thread, or a page of a document. */
export type Cite = { messageId: string } | { docSha256: string; page: number }

/** One summary line. A stored line always has at least one cite. */
export interface DigestLine {
  text: string
  cites: Cite[]
}

export interface DigestCoverage {
  /** Section jobs the source was split into. */
  sections: number
  linesKept: number
  /** Lines the model produced that cited nothing real in this source. */
  linesDropped: number
  /** Messages or pages too large for one section, split at paragraph boundaries. */
  splitSegments: number
}

export interface Digest {
  key: string
  lines: DigestLine[]
  coverage: DigestCoverage
}

/** Why `getDigest` has no digest: a build is queued or running, or none was ever scheduled. */
export interface DigestMissing {
  status: "pending" | "absent"
}

export interface ThreadMessage {
  id: string
  /** The raw stored body. */
  body: string
  /** The id of the message this one answers, when it is in the same thread. */
  inReplyTo?: string
}

export interface DocumentPage {
  page: number
  /** The raw stored text of the page. */
  text: string
}

export type DigestSubject =
  | { kind: "thread"; threadId: string; messages: ThreadMessage[] }
  | { kind: "document"; docSha256: string; pages: DocumentPage[] }

export interface DigestConfig {
  /** Estimated tokens one model input (one section) may hold. Default 2000. */
  sectionTokens: number
  /** Tokens reserved for one reply. Default 600. */
  replyTokens: number
}

export const DEFAULT_SECTION_TOKENS = 2000
export const DEFAULT_REPLY_TOKENS = 600

/** Why a build produced nothing. The failed build stores no digest. */
export class DigestBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DigestBuildError"
  }
}
