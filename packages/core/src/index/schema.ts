import { DatabaseSync } from "node:sqlite"
import {
  DEFAULT_ENTITY_MIGRATION_SQL,
  PROFILE_MIGRATION_SQL,
} from "../profile/migration"

export const DEFAULT_DB_PATH = "eido-data.db"
export const SCHEMA_VERSION = 7

export const MIGRATIONS: readonly string[] = [
  // v1: documents, FTS5 index, name keys, sync cursors
  `
CREATE TABLE documents (
  sha256 TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  mime TEXT NOT NULL,
  entity_id TEXT NULL,
  ingested_at TEXT NOT NULL,
  blob_path TEXT NULL
);
CREATE TRIGGER documents_no_update BEFORE UPDATE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;
CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;

CREATE TABLE document_text (
  sha256 TEXT PRIMARY KEY REFERENCES documents(sha256),
  title TEXT,
  body TEXT NOT NULL,
  occurred_at TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  thread_id TEXT,
  attachment_of TEXT
);
CREATE VIRTUAL TABLE document_fts USING fts5(
  title, body, content='document_text', content_rowid='rowid'
);
CREATE TRIGGER document_text_ai AFTER INSERT ON document_text
BEGIN INSERT INTO document_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
CREATE TRIGGER document_text_no_update BEFORE UPDATE ON document_text
BEGIN SELECT RAISE(ABORT, 'document text is immutable'); END;
CREATE TRIGGER document_text_no_delete BEFORE DELETE ON document_text
BEGIN SELECT RAISE(ABORT, 'document text is immutable'); END;
CREATE VIRTUAL TABLE document_vocab USING fts5vocab(document_fts, row);

CREATE TABLE name_keys (
  sha256 TEXT NOT NULL REFERENCES documents(sha256),
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  phonetic_key TEXT NOT NULL
);
CREATE INDEX name_keys_phonetic ON name_keys(phonetic_key);

CREATE TABLE cursors (
  connector TEXT NOT NULL,
  stream TEXT NOT NULL,
  cursor TEXT NOT NULL,
  uidvalidity TEXT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connector, stream)
);
`,
  // v2: owner profile and entities
  PROFILE_MIGRATION_SQL,
  // v3: the addresses of each mail message, so a reply's recipients are computed from the stored headers
  `
CREATE TABLE mail_addresses (
  sha256 TEXT NOT NULL REFERENCES documents(sha256),
  role TEXT NOT NULL,
  position INTEGER NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (sha256, role, position)
);
CREATE TRIGGER mail_addresses_no_update BEFORE UPDATE ON mail_addresses
BEGIN SELECT RAISE(ABORT, 'mail addresses are immutable'); END;
CREATE TRIGGER mail_addresses_no_delete BEFORE DELETE ON mail_addresses
BEGIN SELECT RAISE(ABORT, 'mail addresses are immutable'); END;
`,
  // v4: the default entity of documents whose account has no assignment
  DEFAULT_ENTITY_MIGRATION_SQL,
  // v5: invalidate pre-migration Drive visibility and force a full listing. Old change
  // cursors did not record removals, so even a sole stored version may be stale.
  `
CREATE TABLE document_heads (
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  sha256 TEXT REFERENCES documents(sha256),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, source_ref)
);
CREATE TRIGGER document_heads_source_on_insert BEFORE INSERT ON document_heads
WHEN NEW.sha256 IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM documents d WHERE d.sha256 = NEW.sha256
    AND d.source = NEW.source AND d.source_ref = NEW.source_ref
)
BEGIN SELECT RAISE(ABORT, 'document head source mismatch'); END;
CREATE TRIGGER document_heads_source_on_update BEFORE UPDATE ON document_heads
WHEN NEW.sha256 IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM documents d WHERE d.sha256 = NEW.sha256
    AND d.source = NEW.source AND d.source_ref = NEW.source_ref
)
BEGIN SELECT RAISE(ABORT, 'document head source mismatch'); END;
INSERT INTO document_heads (source, source_ref, sha256, updated_at)
SELECT d.source, d.source_ref, NULL, max(d.ingested_at)
FROM documents d
WHERE d.source = 'drive' GROUP BY d.source, d.source_ref;
DELETE FROM cursors WHERE connector = 'drive' AND stream = 'files';
`,
  // v6: retain parser-confirmed pages for source-cited document digests. Existing documents have
  // no page rows until reparsed; no page number is inferred from flattened text.
  `
CREATE TABLE document_pages (
  sha256 TEXT NOT NULL REFERENCES documents(sha256),
  page INTEGER NOT NULL CHECK (page >= 1),
  text TEXT NOT NULL,
  PRIMARY KEY (sha256, page)
);
CREATE TRIGGER document_pages_no_update BEFORE UPDATE ON document_pages
BEGIN SELECT RAISE(ABORT, 'document pages are immutable'); END;
CREATE TRIGGER document_pages_no_delete BEFORE DELETE ON document_pages
BEGIN SELECT RAISE(ABORT, 'document pages are immutable'); END;
`,
  // v7: stored delivery headers distinguish automated messages from legacy mail with unknown facts.
  `
CREATE TABLE mail_message_facts (
  sha256 TEXT PRIMARY KEY REFERENCES documents(sha256),
  list_unsubscribe INTEGER NOT NULL CHECK (list_unsubscribe IN (0, 1)),
  auto_submitted TEXT,
  precedence TEXT
);
CREATE TRIGGER mail_message_facts_no_update BEFORE UPDATE ON mail_message_facts
BEGIN SELECT RAISE(ABORT, 'mail message facts are immutable'); END;
CREATE TRIGGER mail_message_facts_no_delete BEFORE DELETE ON mail_message_facts
BEGIN SELECT RAISE(ABORT, 'mail message facts are immutable'); END;
`,
]

/** Open (or create) the index database and bring its schema to the current version. Idempotent. */
export function openIndex(path: string = DEFAULT_DB_PATH): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA foreign_keys = ON")
  const row = db.prepare("PRAGMA user_version").get()
  const version = Number(row?.["user_version"] ?? 0)
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `index schema version ${version} is newer than supported ${SCHEMA_VERSION}`
    )
  }
  // Each migration and its version bump commit together, so a failure leaves the previous version.
  for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
    db.exec("BEGIN")
    try {
      db.exec(MIGRATIONS[next - 1] ?? "")
      db.exec(`PRAGMA user_version = ${next}`)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  return db
}
