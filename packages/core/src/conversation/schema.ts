import type { DatabaseSync } from "node:sqlite"

// Tables of the data plane (`eido-data.db`) for conversations. Every statement is idempotent so
// the store can apply the schema when it opens; folding it into the ledger migration chain
// belongs to whoever owns the data-db open path.

export const CONVERSATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS conversations_identity_immutable BEFORE UPDATE OF id, created_at ON conversations
BEGIN SELECT RAISE(ABORT, 'conversations are immutable apart from last activity'); END;
CREATE TRIGGER IF NOT EXISTS conversations_no_delete BEFORE DELETE ON conversations
BEGIN SELECT RAISE(ABORT, 'conversations are immutable'); END;

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE TRIGGER IF NOT EXISTS conversation_turns_no_update BEFORE UPDATE ON conversation_turns
BEGIN SELECT RAISE(ABORT, 'conversation turns are immutable'); END;
CREATE TRIGGER IF NOT EXISTS conversation_turns_no_delete BEFORE DELETE ON conversation_turns
BEGIN SELECT RAISE(ABORT, 'conversation turns are immutable'); END;

CREATE TABLE IF NOT EXISTS conversation_digests (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  fingerprint TEXT NOT NULL UNIQUE,
  parent_raw_fingerprint TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_source_tags (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  tag TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  PRIMARY KEY (conversation_id, tag),
  UNIQUE (conversation_id, source_ref)
);
CREATE TRIGGER IF NOT EXISTS conversation_source_tags_no_update BEFORE UPDATE ON conversation_source_tags
BEGIN SELECT RAISE(ABORT, 'source tags are never reassigned'); END;
CREATE TRIGGER IF NOT EXISTS conversation_source_tags_no_delete BEFORE DELETE ON conversation_source_tags
BEGIN SELECT RAISE(ABORT, 'source tags are never reused'); END;
`

export function ensureConversationSchema(db: DatabaseSync): void {
  db.exec(CONVERSATION_SCHEMA_SQL)
}
