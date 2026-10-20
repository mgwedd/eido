import type { DatabaseSync } from "node:sqlite"

let savepoints = 0

/** Runs `work` in one write transaction, or in a savepoint when the caller already holds one. */
export function atomically<T>(db: DatabaseSync, work: () => T): T {
  const name = db.isTransaction ? `gate_${++savepoints}` : undefined
  db.exec(name === undefined ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`)
  try {
    const result = work()
    db.exec(name === undefined ? "COMMIT" : `RELEASE ${name}`)
    return result
  } catch (error) {
    db.exec(
      name === undefined ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`
    )
    throw error
  }
}
