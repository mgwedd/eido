import { describe, expect, test } from "vitest"
import {
  validateCoreApiDocumentList,
  validateCoreApiDocumentType,
  validateCoreApiDocumentTypeRequest,
  validateCoreApiDocumentView,
} from "."

// Synthetic payloads only: invented names, ids and amounts.
const summary = {
  sha256: "a".repeat(64),
  name: "quote-example.pdf",
  source: "drive",
  sourceRef: "file-1",
  mime: "application/pdf",
  type: "Quote",
  typeSource: "model",
  entity: { id: "ent-1", kind: "property", name: "Test Property", tag: "PROP" },
  ingestedAt: "2030-01-02T03:04:05.000Z",
  occurredAt: null,
}

describe("documents API schemas", () => {
  test("an empty list is valid", () => {
    expect(
      validateCoreApiDocumentList({ documents: [], nextOffset: null }).ok
    ).toBe(true)
  })

  test("a list rejects a malformed sha256", () => {
    expect(
      validateCoreApiDocumentList({
        documents: [{ ...summary, sha256: "xyz" }],
        nextOffset: null,
      }).ok
    ).toBe(false)
  })

  test("a viewer payload with a highlight and typed fields is valid", () => {
    expect(
      validateCoreApiDocumentView({
        document: summary,
        lines: [{ n: 1, start: 0, text: "Total: $10.00" }],
        highlight: {
          start: 7,
          end: 13,
          text: "$10.00",
          fromLine: 1,
          toLine: 1,
        },
        extractions: [
          {
            id: 1,
            createdAt: "2030-01-02T03:04:05.000Z",
            confirmedAt: null,
            fields: [
              {
                field: "amount",
                raw: "$10.00",
                value: { amount_minor: 1000, currency: "USD" },
                span: { start: 7, end: 13 },
                line: 1,
                confidence: 1,
                verified: true,
              },
            ],
          },
        ],
      }).ok
    ).toBe(true)
  })

  test("a viewer field outside the closed field set is rejected", () => {
    expect(
      validateCoreApiDocumentView({
        document: summary,
        lines: [],
        highlight: null,
        extractions: [
          {
            id: 1,
            createdAt: "2030-01-02T03:04:05.000Z",
            confirmedAt: null,
            fields: [
              {
                field: "note",
                raw: "x",
                value: null,
                span: { start: 0, end: 1 },
                line: null,
                confidence: 1,
                verified: false,
              },
            ],
          },
        ],
      }).ok
    ).toBe(false)
  })
})

describe("document type schemas", () => {
  test("the request accepts a type from the set and nothing else", () => {
    expect(validateCoreApiDocumentTypeRequest({ type: "Tax bill" }).ok).toBe(
      true
    )
    expect(validateCoreApiDocumentTypeRequest({ type: "Memo" }).ok).toBe(false)
    expect(validateCoreApiDocumentTypeRequest({}).ok).toBe(false)
    expect(
      validateCoreApiDocumentTypeRequest({ type: "Quote", extra: 1 }).ok
    ).toBe(false)
  })

  test("the response needs a stored type and its source", () => {
    const ok = {
      sha256: "a".repeat(64),
      type: "Quote",
      typeSource: "user",
    }
    expect(validateCoreApiDocumentType(ok).ok).toBe(true)
    expect(validateCoreApiDocumentType({ ...ok, typeSource: "guess" }).ok).toBe(
      false
    )
  })
})
