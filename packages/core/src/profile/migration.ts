/** Schema v2 of eido-data.db: the owner profile, entities and their account assignments. */
export const PROFILE_MIGRATION_SQL = `
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  timezone TEXT NOT NULL,
  working_hours_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE profile_addresses (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'property', 'company')),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) > 0),
  tag TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (
    length(tag) BETWEEN 1 AND 24
    AND instr(tag, '[') = 0 AND instr(tag, ']') = 0
    AND instr(tag, char(10)) = 0 AND instr(tag, char(13)) = 0
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE entity_assignments (
  connector TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  PRIMARY KEY (connector, account_ref)
);
CREATE INDEX entity_assignments_entity ON entity_assignments(entity_id);

CREATE TABLE profile_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_json TEXT NULL,
  new_json TEXT NULL
);
CREATE TRIGGER profile_history_no_update BEFORE UPDATE ON profile_history
BEGIN SELECT RAISE(ABORT, 'profile history is append-only'); END;
CREATE TRIGGER profile_history_no_delete BEFORE DELETE ON profile_history
BEGIN SELECT RAISE(ABORT, 'profile history is append-only'); END;
`
