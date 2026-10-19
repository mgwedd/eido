import { DatabaseSync } from "node:sqlite"

export const DEFAULT_DB_PATH = "eido-data.db"
export const SCHEMA_VERSION = 1

const SCHEMA_V1 = `
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
`

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
  if (version < 1) {
    db.exec("BEGIN")
    try {
      db.exec(SCHEMA_V1)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  return db
}
