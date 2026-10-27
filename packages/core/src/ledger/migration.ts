/**
 * Ledger schema of eido-data.db, applied by `openDataDb` on top of the index schema (`openIndex`).
 * Versioned in `ledger_schema`, separate from the index's `user_version`, so `openIndex` keeps
 * opening a ledger database and the index migrations stay where #19 put them.
 *
 * Ordering rule: an index migration that changes `documents` or `entities` must keep the ledger
 * triggers intact (or recreate them) when the ledger schema is present, since on an existing file
 * it runs after the ledger migration and on a fresh one before it.
 *
 * v1: every document has an entity, plus extractions, per-field confidence, obligations and links.
 * v2: due dates must be real calendar dates, `ent:` link endpoints must exist, and an obligation
 *     carries the same entity as its source document (#259). The checks are triggers, since a
 *     column CHECK cannot be changed in place; they apply to writes from now on and leave rows
 *     stored under v1 as they are.
 */
export const LEDGER_MIGRATIONS: readonly string[] = [
  `
CREATE TABLE ledger_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);

-- Documents: entity_id (added in index v1 with no constraint) is required from now on. The one
-- update allowed is the backfill of a NULL entity_id; deletes stay blocked (index v1 trigger).
DROP TRIGGER documents_no_update;
CREATE TRIGGER documents_no_update BEFORE UPDATE ON documents
WHEN NOT (
  OLD.entity_id IS NULL AND NEW.entity_id IS NOT NULL
  AND NEW.sha256 IS OLD.sha256 AND NEW.source IS OLD.source AND NEW.source_ref IS OLD.source_ref
  AND NEW.mime IS OLD.mime AND NEW.ingested_at IS OLD.ingested_at AND NEW.blob_path IS OLD.blob_path
)
BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;
CREATE TRIGGER documents_entity_on_insert BEFORE INSERT ON documents
-- A repeat of a stored document is left to INSERT OR IGNORE (ingestBatch counts it as skipped).
WHEN (NEW.entity_id IS NULL OR NOT EXISTS (SELECT 1 FROM entities WHERE id = NEW.entity_id))
  AND NOT EXISTS (SELECT 1 FROM documents WHERE sha256 = NEW.sha256)
BEGIN SELECT RAISE(ABORT, 'document needs a known entity'); END;
CREATE TRIGGER documents_entity_on_update BEFORE UPDATE OF entity_id ON documents
WHEN NEW.entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities WHERE id = NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'document needs a known entity'); END;
CREATE INDEX documents_entity ON documents(entity_id);

CREATE TABLE extractions (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(sha256),
  schema TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('extracted', 'processed_empty')),
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK (status <> 'processed_empty' OR fields_json = '{}')
);
CREATE INDEX extractions_doc ON extractions(doc_id);
CREATE TRIGGER extractions_confirm_once BEFORE UPDATE OF confirmed_at ON extractions
WHEN OLD.confirmed_at IS NOT NULL OR NEW.confirmed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'confirmed_at is set once'); END;
CREATE TRIGGER extractions_immutable BEFORE UPDATE ON extractions
WHEN NEW.id IS NOT OLD.id OR NEW.doc_id IS NOT OLD.doc_id OR NEW.schema IS NOT OLD.schema
  OR NEW.status IS NOT OLD.status OR NEW.fields_json IS NOT OLD.fields_json
  OR NEW.model IS NOT OLD.model OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'extractions are immutable except confirmed_at'); END;
CREATE TRIGGER extractions_no_delete BEFORE DELETE ON extractions
BEGIN SELECT RAISE(ABORT, 'extractions are append-only'); END;

-- Confidence is per field: one row per extracted field, only for fields the extraction holds.
CREATE TABLE extraction_field_confidence (
  extraction_id INTEGER NOT NULL REFERENCES extractions(id),
  field TEXT NOT NULL CHECK (field IN ('amount', 'due_date', 'party', 'action', 'reference_number')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (extraction_id, field)
);
CREATE TRIGGER extraction_field_confidence_field_present BEFORE INSERT ON extraction_field_confidence
WHEN NOT EXISTS (
  SELECT 1 FROM extractions
  WHERE id = NEW.extraction_id AND json_type(fields_json, '$.' || NEW.field) IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'confidence for a field the extraction does not hold'); END;
CREATE TRIGGER extraction_field_confidence_no_update BEFORE UPDATE ON extraction_field_confidence
BEGIN SELECT RAISE(ABORT, 'field confidence is append-only'); END;
CREATE TRIGGER extraction_field_confidence_no_delete BEFORE DELETE ON extraction_field_confidence
BEGIN SELECT RAISE(ABORT, 'field confidence is append-only'); END;

-- AUTOINCREMENT: an id is never reused, so an obl:<id> link never attaches to another obligation.
CREATE TABLE obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  party TEXT,
  action TEXT NOT NULL,
  due_at TEXT CHECK (due_at IS NULL OR due_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'dismissed')),
  doc_id TEXT NOT NULL REFERENCES documents(sha256),
  source_span TEXT NOT NULL CHECK (
    typeof(source_span) = 'text' AND json_valid(source_span)
    AND json_type(source_span, '$.start') IS 'integer'
    AND json_type(source_span, '$.end') IS 'integer'
    AND json_extract(source_span, '$.start') >= 0
    AND json_extract(source_span, '$.end') > json_extract(source_span, '$.start')
  )
);
CREATE TRIGGER obligations_source_fixed BEFORE UPDATE ON obligations
WHEN NEW.id IS NOT OLD.id OR NEW.doc_id IS NOT OLD.doc_id OR NEW.source_span IS NOT OLD.source_span
BEGIN SELECT RAISE(ABORT, 'an obligation keeps its source'); END;
CREATE TRIGGER obligations_no_delete BEFORE DELETE ON obligations
BEGIN SELECT RAISE(ABORT, 'obligations are not deleted; dismiss them'); END;
CREATE INDEX obligations_entity_due ON obligations(entity_id, due_at);
CREATE INDEX obligations_doc ON obligations(doc_id);

-- Typed endpoints: doc:<sha256>, obl:<id>, ent:<id>, party:<name>. Header edges are certain
-- (confidence 1); matched edges are not (confidence below 1).
CREATE TABLE links (
  src TEXT NOT NULL CHECK (src GLOB 'doc:?*' OR src GLOB 'obl:?*' OR src GLOB 'ent:?*' OR src GLOB 'party:?*'),
  dst TEXT NOT NULL CHECK (dst GLOB 'doc:?*' OR dst GLOB 'obl:?*' OR dst GLOB 'ent:?*' OR dst GLOB 'party:?*'),
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'reply_to', 'attachment_of', 'references', 'supersedes', 'about_party')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  origin TEXT NOT NULL CHECK (
    (origin GLOB 'header:?*' AND confidence = 1) OR (origin = 'match' AND confidence < 1)
  ),
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX links_dst ON links(dst);
CREATE TRIGGER links_endpoints_exist BEFORE INSERT ON links
WHEN (NEW.src GLOB 'doc:*' AND NOT EXISTS (SELECT 1 FROM documents WHERE sha256 = substr(NEW.src, 5)))
  OR (NEW.dst GLOB 'doc:*' AND NOT EXISTS (SELECT 1 FROM documents WHERE sha256 = substr(NEW.dst, 5)))
  OR (NEW.src GLOB 'obl:*' AND NOT EXISTS (
    SELECT 1 FROM obligations WHERE id = CAST(substr(NEW.src, 5) AS INTEGER) AND 'obl:' || id = NEW.src))
  OR (NEW.dst GLOB 'obl:*' AND NOT EXISTS (
    SELECT 1 FROM obligations WHERE id = CAST(substr(NEW.dst, 5) AS INTEGER) AND 'obl:' || id = NEW.dst))
BEGIN SELECT RAISE(ABORT, 'link endpoint does not exist'); END;
CREATE TRIGGER links_immutable BEFORE UPDATE ON links
BEGIN SELECT RAISE(ABORT, 'links are immutable'); END;

-- An entity that a document or obligation references is never deleted.
CREATE TRIGGER entities_no_delete_referenced BEFORE DELETE ON entities
WHEN EXISTS (SELECT 1 FROM documents WHERE entity_id = OLD.id)
  OR EXISTS (SELECT 1 FROM obligations WHERE entity_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'entity is still referenced'); END;
`,
  `
-- date() returns NULL for an impossible date such as 2030-02-30 and normalises none, so a value
-- that survives the round trip is a real YYYY-MM-DD (the v1 GLOB already fixes the shape).
CREATE TRIGGER obligations_due_at_real_date_on_insert BEFORE INSERT ON obligations
WHEN NEW.due_at IS NOT NULL AND date(NEW.due_at) IS NOT NEW.due_at
BEGIN SELECT RAISE(ABORT, 'due_at is not a real date'); END;
CREATE TRIGGER obligations_due_at_real_date_on_update BEFORE UPDATE OF due_at ON obligations
WHEN NEW.due_at IS NOT NULL AND date(NEW.due_at) IS NOT NEW.due_at
BEGIN SELECT RAISE(ABORT, 'due_at is not a real date'); END;

-- An obligation names its source document's entity (a shared bill is one obligation per entity,
-- each with its own document). A missing document is left to the foreign key. Documents never change entity once set, so this holds for good.
CREATE TRIGGER obligations_entity_matches_document_on_insert BEFORE INSERT ON obligations
WHEN EXISTS (SELECT 1 FROM documents WHERE sha256 = NEW.doc_id AND entity_id IS NOT NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'obligation entity differs from its document entity'); END;
CREATE TRIGGER obligations_entity_matches_document_on_update BEFORE UPDATE OF entity_id ON obligations
WHEN EXISTS (SELECT 1 FROM documents WHERE sha256 = NEW.doc_id AND entity_id IS NOT NEW.entity_id)
BEGIN SELECT RAISE(ABORT, 'obligation entity differs from its document entity'); END;

DROP TRIGGER links_endpoints_exist;
CREATE TRIGGER links_endpoints_exist BEFORE INSERT ON links
WHEN (NEW.src GLOB 'doc:*' AND NOT EXISTS (SELECT 1 FROM documents WHERE sha256 = substr(NEW.src, 5)))
  OR (NEW.dst GLOB 'doc:*' AND NOT EXISTS (SELECT 1 FROM documents WHERE sha256 = substr(NEW.dst, 5)))
  OR (NEW.src GLOB 'obl:*' AND NOT EXISTS (
    SELECT 1 FROM obligations WHERE id = CAST(substr(NEW.src, 5) AS INTEGER) AND 'obl:' || id = NEW.src))
  OR (NEW.dst GLOB 'obl:*' AND NOT EXISTS (
    SELECT 1 FROM obligations WHERE id = CAST(substr(NEW.dst, 5) AS INTEGER) AND 'obl:' || id = NEW.dst))
  OR (NEW.src GLOB 'ent:*' AND NOT EXISTS (SELECT 1 FROM entities WHERE id = substr(NEW.src, 5)))
  OR (NEW.dst GLOB 'ent:*' AND NOT EXISTS (SELECT 1 FROM entities WHERE id = substr(NEW.dst, 5)))
BEGIN SELECT RAISE(ABORT, 'link endpoint does not exist'); END;
`,
  `
ALTER TABLE obligations ADD COLUMN injection_suspected INTEGER NOT NULL DEFAULT 0 CHECK (injection_suspected IN (0, 1));
ALTER TABLE obligations ADD COLUMN injection_reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(injection_reasons) AND json_type(injection_reasons) = 'array' AND injection_suspected = (json_array_length(injection_reasons) > 0));
CREATE TRIGGER obligations_injection_fixed BEFORE UPDATE OF injection_suspected, injection_reasons ON obligations
WHEN NEW.injection_suspected IS NOT OLD.injection_suspected OR NEW.injection_reasons IS NOT OLD.injection_reasons
BEGIN SELECT RAISE(ABORT, 'an obligation keeps its source'); END;
`,
]

export const LEDGER_SCHEMA_VERSION = LEDGER_MIGRATIONS.length
