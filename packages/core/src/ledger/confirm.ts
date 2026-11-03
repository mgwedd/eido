import type { DatabaseSync } from "node:sqlite"
import { parseAmountField, parseDueDateField } from "@eido/schemas"
import type { SourceSpan } from "@eido/schemas"
import { writeQueueFor } from "../db/write-queue"
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../extraction/pipeline"
import { LedgerError } from "./errors"
import type { ExtractionFieldName } from "./types"

export interface StoredFieldEntry {
  raw: string
  span: SourceSpan
  status?: string
  value?: unknown
  confirmed_at?: string
  confirmed_value?: unknown
  edited?: boolean
}

export type StoredFieldsRecord = Record<string, StoredFieldEntry>

export interface ConfirmExtractionFieldInput {
  extractionId: number
  field: ExtractionFieldName
  value?: unknown
  now?: string
  threshold?: number
}

export interface ConfirmExtractionFieldResult {
  ok: true
  confirmedAt: string
  extractionConfirmed: boolean
  obligationId: number | null
}

export function confirmExtractionField(
  db: DatabaseSync,
  input: ConfirmExtractionFieldInput
): Promise<ConfirmExtractionFieldResult> {
  return writeQueueFor(db).run(() => {
    const { extractionId, field, value, now } = input
    const threshold = input.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD
    const row = db
      .prepare(
        "SELECT id, doc_id, schema, status, fields_json, model, created_at, confirmed_at FROM extractions WHERE id = ?"
      )
      .get(extractionId) as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new LedgerError("extraction_not_found", "no such extraction")
    }
    if (row["status"] !== "extracted") {
      throw new LedgerError(
        "invalid_status",
        "extraction status is not extracted"
      )
    }

    let fields: StoredFieldsRecord
    try {
      const parsed: unknown = JSON.parse(String(row["fields_json"]))
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("malformed")
      }
      fields = parsed as StoredFieldsRecord
    } catch {
      throw new LedgerError("invalid_fields", "stored fields_json is malformed")
    }

    const currentField = fields[field]
    if (currentField === undefined) {
      throw new LedgerError(
        "field_not_found",
        `field ${String(field)} not found in extraction`
      )
    }

    const timestamp = now ?? new Date().toISOString()

    if (value !== undefined) {
      if (field === "amount") {
        let parsedAmount: { amount_minor: number; currency: string }
        if (typeof value === "string") {
          const res = parseAmountField(value, currentField.span)
          if (res.status !== "parsed" || res.value === null) {
            throw new LedgerError(
              "invalid_value",
              "value cannot be parsed as an amount"
            )
          }
          parsedAmount = res.value
        } else if (
          typeof value === "object" &&
          value !== null &&
          "amount_minor" in value &&
          typeof value.amount_minor === "number" &&
          "currency" in value &&
          typeof value.currency === "string"
        ) {
          parsedAmount = {
            amount_minor: value.amount_minor,
            currency: value.currency,
          }
        } else {
          throw new LedgerError("invalid_value", "invalid amount format")
        }
        fields[field] = {
          ...currentField,
          raw: typeof value === "string" ? value : currentField.raw,
          status: "parsed",
          value: parsedAmount,
          confirmed_at: timestamp,
          confirmed_value: parsedAmount,
          edited: true,
        }
      } else if (field === "due_date") {
        let parsedDate: string
        if (typeof value === "string") {
          const res = parseDueDateField(value, currentField.span)
          if (res.status !== "parsed" || res.value === null) {
            throw new LedgerError(
              "invalid_value",
              "value cannot be parsed as a due date"
            )
          }
          parsedDate = res.value
        } else {
          throw new LedgerError("invalid_value", "invalid due date format")
        }
        fields[field] = {
          ...currentField,
          raw: typeof value === "string" ? value : currentField.raw,
          status: "parsed",
          value: parsedDate,
          confirmed_at: timestamp,
          confirmed_value: parsedDate,
          edited: true,
        }
      } else if (
        field === "party" ||
        field === "action" ||
        field === "reference_number"
      ) {
        if (typeof value !== "string" || value.trim() === "") {
          throw new LedgerError(
            "invalid_value",
            "value must be a non-empty string"
          )
        }
        const trimmed = value.trim()
        fields[field] = {
          ...currentField,
          raw: trimmed,
          confirmed_at: timestamp,
          confirmed_value: trimmed,
          edited: true,
        }
      } else {
        throw new LedgerError("invalid_field", "unknown field")
      }
    } else {
      const confirmedValue =
        "value" in currentField &&
        currentField.value !== null &&
        currentField.value !== undefined
          ? currentField.value
          : currentField.raw
      fields[field] = {
        ...currentField,
        confirmed_at: timestamp,
        confirmed_value: confirmedValue,
      }
    }

    const confRows = db
      .prepare(
        "SELECT field, confidence FROM extraction_field_confidence WHERE extraction_id = ?"
      )
      .all(extractionId) as Array<{ field: string; confidence: number }>
    const confMap = new Map(confRows.map((r) => [r.field, r.confidence]))

    let allConfirmed = true
    for (const [fName, fVal] of Object.entries(fields)) {
      const conf = confMap.get(fName) ?? 0
      const isFlagged = fVal.status === "parse_failed" || conf < threshold
      if (isFlagged && !fVal.confirmed_at) {
        allConfirmed = false
        break
      }
    }

    const newFieldsJson = JSON.stringify(fields)
    if (allConfirmed) {
      db.prepare(
        "UPDATE extractions SET fields_json = ?, confirmed_at = ? WHERE id = ?"
      ).run(newFieldsJson, timestamp, extractionId)
    } else {
      db.prepare("UPDATE extractions SET fields_json = ? WHERE id = ?").run(
        newFieldsJson,
        extractionId
      )
    }

    let obligationId: number | null = null
    if (allConfirmed) {
      const docId = String(row["doc_id"])
      const docRow = db
        .prepare("SELECT entity_id FROM documents WHERE sha256 = ?")
        .get(docId) as Record<string, unknown> | undefined
      if (docRow && typeof docRow["entity_id"] === "string") {
        const entityId = docRow["entity_id"]
        const existingObl = db
          .prepare("SELECT id FROM obligations WHERE doc_id = ? LIMIT 1")
          .get(docId) as Record<string, unknown> | undefined

        const actionField = fields["action"]
        const partyField = fields["party"]
        const dueDateField = fields["due_date"]
        const amountField = fields["amount"]

        const action =
          typeof actionField?.confirmed_value === "string"
            ? actionField.confirmed_value
            : typeof actionField?.raw === "string"
              ? actionField.raw
              : "Obligation"
        const party =
          typeof partyField?.confirmed_value === "string"
            ? partyField.confirmed_value
            : typeof partyField?.raw === "string"
              ? partyField.raw
              : null
        const dueAt =
          dueDateField &&
          (dueDateField.status === "parsed" || dueDateField.confirmed_value)
            ? typeof dueDateField.confirmed_value === "string"
              ? dueDateField.confirmed_value
              : typeof dueDateField.value === "string"
                ? dueDateField.value
                : null
            : null
        const span = actionField?.span ??
          amountField?.span ?? { start: 0, end: 1 }

        if (existingObl) {
          obligationId = Number(existingObl["id"])
          db.prepare(
            "UPDATE obligations SET party = ?, action = ?, due_at = ? WHERE id = ?"
          ).run(party, action, dueAt, obligationId)
        } else {
          const res = db
            .prepare(
              `INSERT INTO obligations (entity_id, party, action, due_at, status, doc_id, source_span, injection_suspected, injection_reasons)
               VALUES (?, ?, ?, ?, 'open', ?, ?, 0, '[]')`
            )
            .run(entityId, party, action, dueAt, docId, JSON.stringify(span))
          obligationId = Number(res.lastInsertRowid)
        }
      }
    }

    return {
      ok: true,
      confirmedAt: timestamp,
      extractionConfirmed: allConfirmed,
      obligationId,
    }
  })
}
