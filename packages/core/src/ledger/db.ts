import type { DatabaseSync } from "node:sqlite"
import { DEFAULT_DB_PATH, openIndex } from "../index/schema"
import { LedgerError } from "./errors"
import { LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION } from "./migration"

export interface OpenDataDbOptions {
  /**
   * The entity given to documents stored before the ledger existed (they have no entity_id).
   * Required only when such documents exist; it must be an existing entity.
   */
  defaultEntityId?: string
}

function ledgerVersion(db: DatabaseSync): number {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_schema'"
    )
    .get()
  if (table === undefined) return 0
  return Number(
    db.prepare("SELECT version FROM ledger_schema WHERE id = 1").get()?.[
      "version"
    ] ?? 0
  )
}

/** Give every document stored without an entity the default entity, once, at migration time. */
function backfillDocumentEntities(
  db: DatabaseSync,
  defaultEntityId: string | undefined
): void {
  const missing = db
    .prepare("SELECT 1 FROM documents WHERE entity_id IS NULL LIMIT 1")
    .get()
  if (missing === undefined) return
  if (defaultEntityId === undefined) {
    throw new LedgerError(
      "default_entity_required",
      "documents without an entity exist; a default entity is required"
    )
  }
  if (
    db.prepare("SELECT 1 FROM entities WHERE id = ?").get(defaultEntityId) ===
    undefined
  ) {
    throw new LedgerError("entity_not_found", "no such default entity")
  }
  db.prepare("UPDATE documents SET entity_id = ? WHERE entity_id IS NULL").run(
    defaultEntityId
  )
}

/** Apply any pending ledger migrations to an already-open index database. */
export function activateDataLedger(
  db: DatabaseSync,
  options: OpenDataDbOptions = {}
): void {
  const version = ledgerVersion(db)
  if (version > LEDGER_SCHEMA_VERSION) {
    throw new LedgerError(
      "newer_schema",
      `ledger schema version ${version} is newer than supported ${LEDGER_SCHEMA_VERSION}`
    )
  }
  for (let next = version + 1; next <= LEDGER_SCHEMA_VERSION; next++) {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(LEDGER_MIGRATIONS[next - 1] ?? "")
      if (next === 1) backfillDocumentEntities(db, options.defaultEntityId)
      db.prepare(
        `INSERT INTO ledger_schema (id, version) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version`
      ).run(next)
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
  }
}

/**
 * Open (or create) eido-data.db with the index schema and the ledger schema at their current
 * versions. Idempotent. Each ledger migration, its backfill and its version bump commit together.
 */
export function openDataDb(
  path: string = DEFAULT_DB_PATH,
  options: OpenDataDbOptions = {}
): DatabaseSync {
  const db = openIndex(path)
  try {
    activateDataLedger(db, options)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
