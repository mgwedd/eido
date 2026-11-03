import type { DatabaseSync } from "node:sqlite"
import { parseAmountField, parseDueDateField } from "@eido/schemas"
import { writeQueueFor } from "../db/write-queue"
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../extraction/pipeline"
import { LedgerError } from "./errors"
import type { ExtractionFieldName } from "./types"

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
      .get(extractionId)
    if (row === undefined) {
      throw new LedgerError("extraction_not_found", "no such extraction")
    }
    if (row["status"] !== "extracted") {
      throw new LedgerError(
        "invalid_status",
        "extraction status is not extracted"
      )
    }

    let fields: Record<string, any>
    try {
      fields = JSON.parse(String(row["fields_json"]))
    } catch {
      throw new LedgerError("invalid_fields", "stored fields_json is malformed")
    }

    const currentField = fields[field]
    if (currentField === undefined) {
      throw new LedgerError(
        "field_not_found",
        `field ${field} not found in extraction`
      )
    }

    const timestamp = now ?? new Date().toISOString()

    if (value !== undefined) {
      if (field === "amount") {
        let parsedAmount: any
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
          typeof (value as any).amount_minor === "number" &&
          typeof (value as any).currency === "string"
        ) {
          parsedAmount = value
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
        throw new LedgerError("invalid_field", `unknown field ${field}`)
      }
    } else {
      const confirmedValue =
        "value" in currentField && currentField.value !== null
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
        .get(docId)
      if (docRow && docRow["entity_id"]) {
        const entityId = String(docRow["entity_id"])
        const existingObl = db
          .prepare("SELECT id FROM obligations WHERE doc_id = ? LIMIT 1")
          .get(docId)

        const action =
          fields.action?.confirmed_value ?? fields.action?.raw ?? "Obligation"
        const party =
          fields.party?.confirmed_value ?? fields.party?.raw ?? undefined
        const dueAt =
          fields.due_date?.status === "parsed" ||
          fields.due_date?.confirmed_value
            ? (fields.due_date.confirmed_value ?? fields.due_date.value)
            : undefined
        const span =
          fields.action?.span ??
          fields.amount?.span ?? { start: 0, end: 1 }

        if (existingObl) {
          obligationId = Number(existingObl["id"])
          db.prepare(
            "UPDATE obligations SET party = ?, action = ?, due_at = ? WHERE id = ?"
          ).run(party ?? null, action, dueAt ?? null, obligationId)
        } else {
          const res = db
            .prepare(
              `INSERT INTO obligations (entity_id, party, action, due_at, status, doc_id, source_span, injection_suspected, injection_reasons)
               VALUES (?, ?, ?, ?, 'open', ?, ?, 0, '[]')`
            )
            .run(
              entityId,
              party ?? null,
              action,
              dueAt ?? null,
              docId,
              JSON.stringify(span)
            )
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
