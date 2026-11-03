import type { DatabaseSync } from "node:sqlite"
import type { ExtractedFields } from "@eido/schemas"
import {
  insertExtraction,
  insertObligation,
  type ObligationInput,
} from "../ledger/index"
import { ledgerFixture, sha } from "../ledger/ledger.test-support"
import type { BriefConfig } from "./types"

export const CONFIG: BriefConfig = {
  timezone: "Europe/Zurich",
  time: "07:00",
  dueWithinDays: 14,
  maxLines: 8,
  confirmThreshold: 0.8,
}

/** 13:00 in Zurich on 2026-11-02 (CET). */
export const NOW = new Date("2026-11-02T12:00:00.000Z")

export type Fixture = Awaited<ReturnType<typeof ledgerFixture>> & {
  entityId: string
}

export async function fixture(): Promise<Fixture> {
  const base = await ledgerFixture()
  return { ...base, entityId: base.property.id }
}

/** Stores a document with a chosen ingest time; returns its sha256. */
export function putDoc(
  db: DatabaseSync,
  entityId: string,
  name: string,
  ingestedAt: string,
  mime = "message/rfc822"
): string {
  const sha256 = sha(name)
  db.prepare(
    `INSERT INTO documents (sha256, source, source_ref, mime, entity_id, ingested_at)
     VALUES (?, 'gmail', ?, ?, ?, ?)`
  ).run(sha256, `ref-${name}`, mime, entityId, ingestedAt)
  return sha256
}

export function putObligation(
  db: DatabaseSync,
  entityId: string,
  docId: string,
  over: Partial<ObligationInput> & { action: string }
): Promise<number> {
  return insertObligation(db, {
    entityId,
    status: "open",
    docId,
    span: { start: 4, end: 20 },
    ...over,
  })
}

/** Marks a document as read: an extraction row with nothing extracted. */
export function markRead(db: DatabaseSync, docId: string): Promise<number> {
  return insertExtraction(db, {
    docId,
    schema: "obligations",
    status: "processed_empty",
    model: "none",
    createdAt: "2026-11-02T06:00:00.000Z",
  })
}

export function unconfirmedAmount(
  db: DatabaseSync,
  docId: string,
  confidence: number
): Promise<number> {
  const fields: ExtractedFields = {
    action: { raw: "Pay the invoice", span: { start: 0, end: 15 } },
    amount: {
      raw: "CHF 120.00",
      span: { start: 30, end: 40, page: 2 },
      status: "parsed",
      value: { amount_minor: 12000, currency: "CHF" },
    },
  }
  return insertExtraction(db, {
    docId,
    schema: "obligations",
    status: "extracted",
    fields,
    confidence: { action: 0.95, amount: confidence },
    model: "test-model",
    createdAt: "2026-11-02T06:00:00.000Z",
  })
}
