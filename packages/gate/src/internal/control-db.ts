import { DatabaseSync } from "node:sqlite"
import { append } from "./audit"
import { payloadHash } from "./canonical"

// Ordered migrations, tracked with PRAGMA user_version. Append new entries; never edit applied ones.
const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
  `CREATE TABLE audit_log (
     seq         INTEGER PRIMARY KEY AUTOINCREMENT,
     ts          TEXT NOT NULL,
     actor       TEXT NOT NULL,
     action      TEXT NOT NULL,
     target      TEXT NOT NULL,
     detail_hash TEXT NOT NULL,
     prev_hash   TEXT NOT NULL
   );
   CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
   CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`,
  // Pinned connector manifests (#10). drift_json holds the added and removed tool names from the
  // checkDrift call that disabled the connector; pinManifest clears it.
  `CREATE TABLE connectors (
     name                 TEXT PRIMARY KEY,
     manifest_json        TEXT NOT NULL,
     manifest_hash        TEXT NOT NULL,
     pinned_at            TEXT NOT NULL,
     enabled              INTEGER NOT NULL CHECK (enabled IN (0, 1)),
     health               TEXT NOT NULL CHECK (health IN ('healthy', 'degraded', 'open')),
     consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
     drift_json           TEXT
   ) STRICT;`,
  // Intents and their state transitions (#11). payload_json is the canonical (RFC 8785) intent
  // and payload_hash its SHA-256; reason says why an intent was rejected. intent_events links
  // each transition to its audit_log row, so an intent's history is read from the audit chain.
  `CREATE TABLE intents (
     id              TEXT PRIMARY KEY,
     kind            TEXT NOT NULL,
     payload_json    TEXT NOT NULL,
     payload_hash    TEXT NOT NULL,
     tier            TEXT NOT NULL CHECK (tier IN ('auto', 'approval', 'forbidden')),
     state           TEXT NOT NULL CHECK (state IN ('proposed', 'pending', 'approved', 'rejected', 'executed', 'failed')),
     origin          TEXT NOT NULL CHECK (origin IN ('reactive', 'proactive', 'task')),
     edited_from     TEXT REFERENCES intents (id),
     task_id         TEXT,
     context_pack_id TEXT,
     reason          TEXT,
     created_at      TEXT NOT NULL
   ) STRICT;
   CREATE INDEX intents_state ON intents (state, created_at);
   CREATE TABLE intent_events (
     audit_seq  INTEGER PRIMARY KEY REFERENCES audit_log (seq),
     intent_id  TEXT NOT NULL REFERENCES intents (id),
     from_state TEXT,
     to_state   TEXT NOT NULL,
     reason     TEXT
   ) STRICT;
   CREATE INDEX intent_events_intent ON intent_events (intent_id, audit_seq);
   CREATE TRIGGER intent_events_no_update BEFORE UPDATE ON intent_events BEGIN SELECT RAISE(ABORT, 'intent_events is append-only'); END;
   CREATE TRIGGER intent_events_no_delete BEFORE DELETE ON intent_events BEGIN SELECT RAISE(ABORT, 'intent_events is append-only'); END;`,
  // Approvals (#15). current_nonce is the one nonce an approval of the intent may be signed over;
  // approval_nonces keeps every nonce issued, so none is valid twice. credentials holds the
  // enrolled passkeys: public_key is the SubjectPublicKeyInfo DER as base64url, sign_count the
  // highest counter seen. approvals holds one row per decision; nonce and intent_id are unique.
  // registration_challenges are the single-use challenges for passkey enrolment on the Mac.
  `ALTER TABLE intents ADD COLUMN current_nonce TEXT;
   CREATE TABLE approval_nonces (
     nonce     TEXT PRIMARY KEY,
     intent_id TEXT NOT NULL REFERENCES intents (id),
     issued_at TEXT NOT NULL,
     used_at   TEXT
   ) STRICT;
   CREATE TABLE credentials (
     credential_id TEXT PRIMARY KEY,
     public_key    TEXT NOT NULL,
     sign_count    INTEGER NOT NULL CHECK (sign_count >= 0),
     created_at    TEXT NOT NULL,
     revoked_at    TEXT
   ) STRICT;
   CREATE TABLE approvals (
     intent_id     TEXT PRIMARY KEY REFERENCES intents (id),
     bundle_hash   TEXT NOT NULL,
     decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
     signature     TEXT,
     credential_id TEXT REFERENCES credentials (credential_id),
     sign_count    INTEGER,
     nonce         TEXT UNIQUE REFERENCES approval_nonces (nonce),
     decided_at    TEXT NOT NULL,
     reason_code   TEXT,
     CHECK (decision = 'rejected' OR (signature IS NOT NULL AND credential_id IS NOT NULL AND sign_count IS NOT NULL AND nonce IS NOT NULL))
   ) STRICT;
   CREATE TABLE registration_challenges (
     challenge TEXT PRIMARY KEY,
     issued_at TEXT NOT NULL,
     used_at   TEXT
   ) STRICT;`,
  // Durable, single-attempt claims survive process restarts: an uncertain external outcome is
  // never retried automatically. Successful results and inverses are bound to an audit row.
  `CREATE TABLE execution_attempts (
     intent_id TEXT NOT NULL REFERENCES intents(id),
     direction TEXT NOT NULL CHECK(direction IN ('execute', 'undo')),
     started_at TEXT NOT NULL,
     PRIMARY KEY(intent_id, direction)
   ) STRICT;
   CREATE TABLE executions (
     intent_id TEXT PRIMARY KEY REFERENCES intents(id),
     upstream_ref TEXT,
     result TEXT NOT NULL,
     inverse_op TEXT,
     audit_seq INTEGER NOT NULL UNIQUE REFERENCES audit_log(seq)
   ) STRICT;
   CREATE TABLE execution_undos (
     intent_id TEXT PRIMARY KEY REFERENCES executions(intent_id),
     upstream_ref TEXT,
     result TEXT NOT NULL,
     audit_seq INTEGER NOT NULL UNIQUE REFERENCES audit_log(seq)
   ) STRICT;`,
  // Signed control changes (#160). Unsigned legacy pins must be reviewed before reuse.
  (db) => {
    db.exec(`ALTER TABLE connectors ADD COLUMN pin_approval_ref_hash TEXT;
      CREATE TABLE control_approvals (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK (purpose IN ('manifest.pin', 'policy.set')),
        target TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        superseded_at TEXT,
        used_at TEXT,
        approval_ref_hash TEXT UNIQUE,
        credential_hash TEXT,
        signature_hash TEXT,
        sign_count INTEGER,
        audit_seq INTEGER REFERENCES audit_log(seq),
        CHECK (used_at IS NULL OR (approval_ref_hash IS NOT NULL AND credential_hash IS NOT NULL AND signature_hash IS NOT NULL AND sign_count IS NOT NULL AND audit_seq IS NOT NULL))
      ) STRICT;
      CREATE TRIGGER control_approval_binding_immutable BEFORE UPDATE OF id, purpose, target, payload_hash, nonce, issued_at ON control_approvals BEGIN SELECT RAISE(ABORT, 'control approval binding is immutable'); END;
      CREATE TRIGGER control_approval_consumed_immutable BEFORE UPDATE ON control_approvals WHEN OLD.used_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'consumed control approval is immutable'); END;
      CREATE TRIGGER control_approval_consumed_no_delete BEFORE DELETE ON control_approvals WHEN OLD.used_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'consumed control approval is immutable'); END;
      CREATE TABLE approved_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        approval_id TEXT NOT NULL REFERENCES control_approvals(id)
      ) STRICT;`)
    for (const row of db
      .prepare("SELECT name, manifest_hash FROM connectors WHERE enabled = 1")
      .all()) {
      append(db, {
        actor: "system",
        action: "connector.disabled_unsigned",
        target: String(row["name"]),
        detailHash: payloadHash({ manifestHash: String(row["manifest_hash"]) }),
      })
    }
    db.exec("UPDATE connectors SET enabled = 0 WHERE enabled = 1")
  },
  // The phone listener (#85). rationale is the agent's display-only note on an intent, never
  // part of its payload or hash; document_ids_json the JSON array of document ids it was built
  // from. login_challenges are single-use passkey login challenges; sessions holds the SHA-256
  // of each session cookie value, never the value itself.
  `ALTER TABLE intents ADD COLUMN rationale TEXT;
   ALTER TABLE intents ADD COLUMN document_ids_json TEXT;
   CREATE TABLE login_challenges (
     challenge  TEXT PRIMARY KEY,
     issued_at  TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at    TEXT
   ) STRICT;
   CREATE TABLE sessions (
     token_hash    TEXT PRIMARY KEY,
     credential_id TEXT NOT NULL REFERENCES credentials (credential_id),
     created_at    TEXT NOT NULL,
     expires_at    TEXT NOT NULL
   ) STRICT;`,
]

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get()
  return Number(row?.["user_version"] ?? 0)
}

/** Opens (creating if needed) the gate's control database and applies pending migrations. */
export function openControlDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA journal_mode = WAL")
  for (let v = userVersion(db); v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]
    db.exec("BEGIN IMMEDIATE")
    try {
      // Re-check under the write lock so two openers never apply the same migration twice.
      if (userVersion(db) === v && sql !== undefined) {
        if (typeof sql === "string") db.exec(sql)
        else sql(db)
        db.exec(`PRAGMA user_version = ${v + 1}`)
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  return db
}
