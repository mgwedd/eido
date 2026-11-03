/** The `events` table of eido-data.db (#52): one row per thing that may become a card. */
export const TRIAGE_SCHEMA_SQL = `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  trigger_key TEXT NOT NULL,
  fire_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
  disposition TEXT CHECK (disposition IN ('ledger', 'digest', 'card')),
  reason TEXT,
  intent_id TEXT,
  received_at TEXT NOT NULL,
  decided_at TEXT,
  shown_in_brief_at TEXT,
  UNIQUE (trigger_key, fire_id),
  CHECK ((disposition IS NULL) = (decided_at IS NULL)),
  CHECK (disposition IS 'card' OR intent_id IS NULL),
  CHECK (disposition IS 'digest' OR shown_in_brief_at IS NULL)
);
CREATE INDEX events_queued ON events(score DESC) WHERE disposition IS NULL;
CREATE INDEX events_decided ON events(disposition, decided_at);
`
