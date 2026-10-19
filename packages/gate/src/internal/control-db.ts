import { DatabaseSync } from "node:sqlite"

// Ordered migrations, tracked with PRAGMA user_version. Append new entries; never edit applied ones.
const MIGRATIONS: readonly string[] = [
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
        db.exec(sql)
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
