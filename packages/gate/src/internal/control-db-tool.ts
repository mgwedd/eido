import { DatabaseSync } from "node:sqlite"
import { reject } from "./approvals"
import { openControlDb } from "./control-db"
import { MAIL_OPS, auditRows, manifest, signedPin } from "./test-fixtures"
import type { AuditRow } from "./test-fixtures"

// Test support for the two-process tests (packages/core/src/planes): the harness runs this file
// by path, as its own process, to seed a temp control DB before the gate starts and to read it
// afterwards. Nothing imports it from outside the gate, so gate internals stay private.

/** Pins the synthetic mail connector, so email.send is approval tier and email.draft auto. */
export function seedControlDb(path: string): void {
  const db = openControlDb(path)
  try {
    signedPin(db, manifest("mail", MAIL_OPS), "owner")
  } finally {
    db.close()
  }
}

export type ControlDbView = { audit: AuditRow[]; intentIds: string[] }

/** The audit rows and intent ids, read without writing. */
export function inspectControlDb(path: string): ControlDbView {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      audit: auditRows(db),
      intentIds: db
        .prepare("SELECT id FROM intents ORDER BY rowid")
        .all()
        .map((row) => String(row["id"])),
    }
  } finally {
    db.close()
  }
}

/** The owner's reject of a pending intent, as the approval path will record it. */
export function rejectIntent(path: string, intentId: string): string {
  const db = openControlDb(path)
  try {
    return JSON.stringify(reject(db, intentId, "other"))
  } finally {
    db.close()
  }
}

/** `seed <path>`, `inspect <path>` or `reject <path> <id>`; returns the JSON line to print. */
export function runTool(args: readonly string[]): string {
  const [command, path, id] = args
  if (path === undefined) {
    throw new Error("usage: seed|inspect|reject <control db path> [intent id]")
  }
  switch (command) {
    case "reject":
      return rejectIntent(path, id ?? "")
    case "seed":
      seedControlDb(path)
      return JSON.stringify({ seeded: path })
    case "inspect":
      return JSON.stringify(inspectControlDb(path))
    default:
      throw new Error(`unknown command ${String(command)}`)
  }
}

if (import.meta.main) {
  process.stdout.write(`${runTool(process.argv.slice(2))}\n`)
}
