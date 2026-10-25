import type { DatabaseSync } from "node:sqlite"
import { deriveDigestFingerprint, fingerprintTurns } from "./fingerprint"
import type { SummaryStart } from "./compact"
import { ensureConversationSchema } from "./schema"
import {
  ensureIndex,
  indexTurn,
  replaceDigestPassages,
  searchIndex,
} from "./search-index"
import type {
  ConversationDigest,
  RawTurn,
  SearchHit,
  SearchKind,
  SourceTag,
} from "./types"

export type SearchOptions = { limit?: number; kind?: SearchKind | "any" }

export type ContextHit = ConversationDigest & { score: number }

export interface ConversationStore {
  /** Add a raw turn, once. It is never edited or deleted. Creates the conversation on its first turn. */
  appendTurn(conversationId: string, turn: RawTurn): void
  /** The raw turns of a conversation in order; empty when it does not exist. */
  getTurns(conversationId: string): RawTurn[]
  /** Fingerprint of the raw turns (#48), or undefined for an unknown conversation. */
  fingerprint(conversationId: string): string | undefined
  /** Best first. */
  searchConversations(query: string, opts?: SearchOptions): SearchHit[]
  /**
   * Store the final compaction of `turns` as the conversation's digest, replacing the old one
   * and its index entry. `parentRawFingerprint` is the fingerprint of the turns it summarized;
   * `start` is the model's summary of them before references were appended, and their count.
   */
  putDigest(
    conversationId: string,
    text: string,
    parentRawFingerprint: string,
    createdAt: string,
    start: SummaryStart
  ): ConversationDigest
  getConversationDigest(conversationId: string): ConversationDigest | undefined
  /** The stored digest's summary and turn count, for the next build to fold new turns into. */
  digestStart(conversationId: string): SummaryStart | undefined
  /** Digests matching `query`, best first, one per conversation, with their parent link. */
  retrieveContext(query: string, opts?: { limit?: number }): ContextHit[]
  /** Idle for at least `ttlMinutes` at `now`, and no digest of its current raw transcript. */
  dueForDigest(now: Date, ttlMinutes: number): string[]
  /** The tag of `sourceRef` in this conversation: the existing one, or the next unused `M<n>`. */
  allocateSourceTag(conversationId: string, sourceRef: string): string
  resolveSourceTag(conversationId: string, tag: string): string | undefined
  sourceTags(conversationId: string): SourceTag[]
}

export interface ConversationStoreDeps {
  /** The data plane database (`eido-data.db`). */
  db: DatabaseSync
  /** The search index file, from `openConversationIndex`. */
  index: DatabaseSync
  /** Injected clock; stamps `last_activity_at`. */
  now?: () => Date
}

function readSources(json: string): string[] {
  const parsed: unknown = JSON.parse(json)
  return Array.isArray(parsed)
    ? parsed.filter((s): s is string => typeof s === "string")
    : []
}

function toTurn(row: Record<string, unknown>): RawTurn {
  return {
    id: String(row["id"]),
    role: row["role"] === "assistant" ? "assistant" : "user",
    text: String(row["text"]),
    at: String(row["at"]),
    sources: readSources(String(row["sources_json"])),
  }
}

function toDigest(row: Record<string, unknown>): ConversationDigest {
  return {
    conversationId: String(row["conversation_id"]),
    fingerprint: String(row["fingerprint"]),
    parentRawFingerprint: String(row["parent_raw_fingerprint"]),
    text: String(row["text"]),
    createdAt: String(row["created_at"]),
  }
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = work()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function createConversationStore(
  deps: ConversationStoreDeps
): ConversationStore {
  const { db, index } = deps
  const now = deps.now ?? ((): Date => new Date())
  ensureConversationSchema(db)

  function getTurns(conversationId: string): RawTurn[] {
    return db
      .prepare(
        "SELECT id, role, text, at, sources_json FROM conversation_turns WHERE conversation_id = ? ORDER BY seq"
      )
      .all(conversationId)
      .map(toTurn)
  }

  function getConversationDigest(
    conversationId: string
  ): ConversationDigest | undefined {
    const row = db
      .prepare(
        "SELECT conversation_id, fingerprint, parent_raw_fingerprint, text, created_at FROM conversation_digests WHERE conversation_id = ?"
      )
      .get(conversationId)
    return row === undefined ? undefined : toDigest(row)
  }

  function fingerprint(conversationId: string): string | undefined {
    const turns = getTurns(conversationId)
    return turns.length === 0 ? undefined : fingerprintTurns(turns)
  }

  ensureIndex(index, {
    turns: db
      .prepare(
        "SELECT conversation_id, id, seq, text FROM conversation_turns ORDER BY conversation_id, seq"
      )
      .all()
      .map((r) => ({
        conversationId: String(r["conversation_id"]),
        turnId: String(r["id"]),
        seq: Number(r["seq"]),
        text: String(r["text"]),
      })),
    digests: db
      .prepare("SELECT conversation_id, text FROM conversation_digests")
      .all()
      .map((r) => ({
        conversationId: String(r["conversation_id"]),
        text: String(r["text"]),
      })),
  })

  return {
    appendTurn(conversationId, turn) {
      if (Number.isNaN(Date.parse(turn.at))) {
        throw new RangeError("a turn's `at` must be an ISO 8601 timestamp")
      }
      const seq = transaction(db, () => {
        const stamp = now().toISOString()
        db.prepare(
          "INSERT OR IGNORE INTO conversations (id, created_at, last_activity_at) VALUES (?, ?, ?)"
        ).run(conversationId, stamp, stamp)
        const next = Number(
          db
            .prepare(
              "SELECT coalesce(max(seq), -1) + 1 AS next FROM conversation_turns WHERE conversation_id = ?"
            )
            .get(conversationId)?.["next"] ?? 0
        )
        db.prepare(
          "INSERT INTO conversation_turns (id, conversation_id, seq, role, text, at, sources_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          turn.id,
          conversationId,
          next,
          turn.role,
          turn.text,
          turn.at,
          JSON.stringify(turn.sources)
        )
        db.prepare(
          "UPDATE conversations SET last_activity_at = ? WHERE id = ?"
        ).run(stamp, conversationId)
        return next
      })
      indexTurn(index, {
        conversationId,
        turnId: turn.id,
        seq,
        text: turn.text,
      })
    },

    getTurns,
    fingerprint,

    searchConversations(query, opts) {
      return searchIndex(index, query, opts)
    },

    putDigest(conversationId, text, parentRawFingerprint, createdAt, start) {
      const digest: ConversationDigest = {
        conversationId,
        fingerprint: deriveDigestFingerprint(parentRawFingerprint, text),
        parentRawFingerprint,
        text,
        createdAt,
      }
      transaction(db, () => {
        db.prepare(
          "DELETE FROM conversation_digests WHERE conversation_id = ?"
        ).run(conversationId)
        db.prepare(
          "INSERT INTO conversation_digests (conversation_id, fingerprint, parent_raw_fingerprint, text, created_at, summary, covered_turns) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          conversationId,
          digest.fingerprint,
          parentRawFingerprint,
          text,
          createdAt,
          start.summary,
          start.coveredTurns
        )
      })
      replaceDigestPassages(index, conversationId, text)
      return digest
    },

    getConversationDigest,

    digestStart(conversationId) {
      const row = db
        .prepare(
          "SELECT summary, covered_turns FROM conversation_digests WHERE conversation_id = ?"
        )
        .get(conversationId)
      return row === undefined
        ? undefined
        : {
            summary: String(row["summary"]),
            coveredTurns: Number(row["covered_turns"]),
          }
    },

    retrieveContext(query, opts) {
      const limit = opts?.limit ?? 5
      const seen = new Set<string>()
      const out: ContextHit[] = []
      // A digest has one hit per matching paragraph; keep each conversation's best.
      for (const hit of searchIndex(index, query, { kind: "digest" })) {
        if (seen.has(hit.conversationId)) continue
        const digest = getConversationDigest(hit.conversationId)
        if (digest === undefined) continue
        seen.add(hit.conversationId)
        out.push({ ...digest, score: hit.score })
        if (out.length >= limit) break
      }
      return out
    },

    dueForDigest(at, ttlMinutes) {
      const cutoff = at.getTime() - ttlMinutes * 60_000
      return db
        .prepare("SELECT id, last_activity_at FROM conversations ORDER BY id")
        .all()
        .filter((r) => Date.parse(String(r["last_activity_at"])) <= cutoff)
        .map((r) => String(r["id"]))
        .filter(
          (id) =>
            getConversationDigest(id)?.parentRawFingerprint !== fingerprint(id)
        )
    },

    allocateSourceTag(conversationId, sourceRef) {
      return transaction(db, () => {
        const existing = db
          .prepare(
            "SELECT tag FROM conversation_source_tags WHERE conversation_id = ? AND source_ref = ?"
          )
          .get(conversationId, sourceRef)
        if (existing !== undefined) return String(existing["tag"])
        // Rows are never deleted, so the highest number ever used is the highest present.
        const next =
          Number(
            db
              .prepare(
                "SELECT coalesce(max(CAST(substr(tag, 2) AS INTEGER)), 0) AS n FROM conversation_source_tags WHERE conversation_id = ?"
              )
              .get(conversationId)?.["n"] ?? 0
          ) + 1
        const tag = `M${String(next)}`
        db.prepare(
          "INSERT INTO conversation_source_tags (conversation_id, tag, source_ref) VALUES (?, ?, ?)"
        ).run(conversationId, tag, sourceRef)
        return tag
      })
    },

    resolveSourceTag(conversationId, tag) {
      const row = db
        .prepare(
          "SELECT source_ref FROM conversation_source_tags WHERE conversation_id = ? AND tag = ?"
        )
        .get(conversationId, tag)
      return row === undefined ? undefined : String(row["source_ref"])
    },

    sourceTags(conversationId) {
      return db
        .prepare(
          "SELECT tag, source_ref FROM conversation_source_tags WHERE conversation_id = ? ORDER BY CAST(substr(tag, 2) AS INTEGER)"
        )
        .all(conversationId)
        .map((r) => ({
          tag: String(r["tag"]),
          sourceRef: String(r["source_ref"]),
        }))
    },
  }
}
