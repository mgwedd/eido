import type { DatabaseSync } from "node:sqlite"
import type { InferenceQueue } from "../inference/index"
import { buildDigestLines, DIGEST_PROMPT_VERSION } from "./build"
import {
  applyDigestMigration,
  readDigest,
  readLatestDigest,
  writeDigest,
} from "./cache"
import type { StoredDigest } from "./cache"
import {
  digestKey,
  fingerprintDocument,
  fingerprintThread,
  sha256Hex,
} from "./fingerprint"
import { DEFAULT_REPLY_TOKENS, DEFAULT_SECTION_TOKENS } from "./types"
import type {
  Digest,
  DigestConfig,
  DigestMissing,
  DigestSubject,
} from "./types"

export interface DigestServiceOptions {
  db: DatabaseSync
  /** Every model call goes through this queue, on the background lane. */
  queue: InferenceQueue
  /** Part of the cache key: a different model is a different digest. */
  modelId: string
  config?: Partial<DigestConfig>
  /** Part of the cache key. Defaults to the module's `DIGEST_PROMPT_VERSION`. */
  promptVersion?: string
  now?: () => Date
  /** Called when a background build fails. The failed build stores nothing. */
  onError?: (error: unknown, subject: DigestSubject) => void
}

export interface DigestService {
  /** The stored digest for this exact content, or why there is none. Never calls the model. */
  getDigest(subject: DigestSubject): Digest | DigestMissing
  /**
   * The newest stored digest of the same thread or document, even when the content has changed
   * since (`current` false): the old digest stays readable until the rebuild is stored.
   */
  getLatestDigest(
    subject: DigestSubject
  ): (Digest & { current: boolean }) | undefined
  /** Queues a background build unless the digest is stored or already being built. */
  scheduleDigest(subject: DigestSubject): void
  /** Resolves when no build is pending. */
  whenIdle(): Promise<void>
  /** The cache key of a subject under this service's prompt version and model. */
  keyFor(subject: DigestSubject): string
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer of at least 1`)
  }
  return value
}

function rawFingerprint(subject: DigestSubject): string {
  return subject.kind === "thread"
    ? fingerprintThread(
        subject.messages.map((m) => ({
          id: m.id,
          bodySha256: sha256Hex(m.body),
        }))
      )
    : fingerprintDocument(subject.docSha256)
}

const subjectRef = (subject: DigestSubject): string =>
  subject.kind === "thread" ? subject.threadId : subject.docSha256

export function createDigestService(
  options: DigestServiceOptions
): DigestService {
  const { db, queue, modelId } = options
  const promptVersion = options.promptVersion ?? DIGEST_PROMPT_VERSION
  const config: DigestConfig = {
    sectionTokens: positiveInteger(
      "sectionTokens",
      options.config?.sectionTokens ?? DEFAULT_SECTION_TOKENS
    ),
    replyTokens: positiveInteger(
      "replyTokens",
      options.config?.replyTokens ?? DEFAULT_REPLY_TOKENS
    ),
  }
  const now = options.now ?? (() => new Date())
  applyDigestMigration(db)

  const pending = new Map<string, Promise<void>>()

  const keyFor = (subject: DigestSubject): string =>
    digestKey(promptVersion, modelId, rawFingerprint(subject))

  async function build(subject: DigestSubject, key: string): Promise<void> {
    const { lines, coverage } = await buildDigestLines(queue, subject, config)
    const row: StoredDigest = {
      key,
      kind: subject.kind,
      subjectRef: subjectRef(subject),
      promptVersion,
      modelId,
      fingerprint: rawFingerprint(subject),
      lines,
      coverage,
      createdAt: now().toISOString(),
    }
    writeDigest(db, row)
  }

  function getDigest(subject: DigestSubject): Digest | DigestMissing {
    const key = keyFor(subject)
    const hit = readDigest(db, key)
    if (hit !== undefined) return hit
    return { status: pending.has(key) ? "pending" : "absent" }
  }

  function getLatestDigest(
    subject: DigestSubject
  ): (Digest & { current: boolean }) | undefined {
    const stored = readLatestDigest(db, subject.kind, subjectRef(subject))
    if (stored === undefined) return undefined
    return {
      key: stored.key,
      lines: stored.lines,
      coverage: stored.coverage,
      current: stored.key === keyFor(subject),
    }
  }

  function scheduleDigest(subject: DigestSubject): void {
    const key = keyFor(subject)
    if (pending.has(key) || readDigest(db, key) !== undefined) return
    const job = build(subject, key)
      .catch((error: unknown) => {
        options.onError?.(error, subject)
      })
      .finally(() => {
        pending.delete(key)
      })
    pending.set(key, job)
  }

  async function whenIdle(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending.values()])
  }

  return { getDigest, getLatestDigest, scheduleDigest, whenIdle, keyFor }
}
