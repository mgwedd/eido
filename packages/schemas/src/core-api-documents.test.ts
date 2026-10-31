import { describe, expect, test } from "vitest"
import { validateCoreApiDocumentList, validateCoreApiDocumentView } from "."

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
