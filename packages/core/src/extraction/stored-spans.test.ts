import { afterEach, describe, expect, test } from "vitest"
import { documentsRoute } from "../api/documents-route"
import { pdfAttachmentText } from "../connectors/mail/pdf-text"
import { parseMessage } from "../connectors/mail/parse"
import { createModelClient } from "../inference/client"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer } from "../inference/stub-server"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { buildText } from "../parsers/offsets"
import type { Parser } from "../parsers/parse-document"
import { buildStoredOffsets } from "./stored-text"
import { jsonReply } from "./extraction.test-support"
import { createExtractor } from "./pipeline"

// Synthetic documents only. Each case stores a document the way a connector does, extracts from
// it and checks the stored spans against `document_text.body` (#389).

let server: StubModelServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

type StoredField = {
  raw: string
  span: { start: number; end: number; page?: number; line: number }
}
type StoredFields = Record<string, StoredField>

type Stored = { sha256: string; body: string }

async function extractFrom(
  build: (entityId: string) => ReturnType<typeof testDoc>,
  quotes: Record<string, { quote: string }>
) {
  const { db, property } = await ledgerFixture()
  const doc = build(property.id)
  addDocs(db, [doc])
  server = await startStubModelServer({
    replies: [
      jsonReply({ nothing_found: false, items: [quotes] }),
      jsonReply({ nothing_found: false, items: [quotes] }),
    ],
  })
  const extractor = createExtractor({
    db,
    model: createModelClient({
      baseUrl: server.url,
      contextTokens: 1_000_000,
      maxReplyTokens: 1024,
    }),
    config: { model: "stub-model" },
  })
  const result = await extractor.extractDocument(doc.sha256)
  const row = db
    .prepare("SELECT body FROM document_text WHERE sha256 = ?")
    .get(doc.sha256)
  const stored: Stored = { sha256: doc.sha256, body: String(row?.["body"]) }
  const fields = db
    .prepare("SELECT fields_json FROM extractions WHERE doc_id = ?")
    .all(doc.sha256)
    .map((r) => JSON.parse(String(r["fields_json"])) as StoredFields)
  return { db, result, stored, fields }
}

function expectSpansIndexBody(
  fields: StoredFields,
  body: string
): Array<{ start: number; end: number; page?: number; line: number }> {
  const spans = Object.values(fields).map((f) => f.span)
  expect(spans.length).toBeGreaterThan(0)
  for (const field of Object.values(fields)) {
    expect(body.slice(field.span.start, field.span.end)).toBe(field.raw)
  }
  return spans
}

describe("stored mail", () => {
  test("spans index the stored body, which parseMessage trimmed and stripped", async () => {
    const raw = [
      "From: Example Supply Co. <billing@example.invalid>",
      "To: owner@example.invalid",
      "Subject: Invoice INV-2041",
      "Message-ID: <m-2041@example.invalid>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "​",
      "Hello,​",
      "",
      "Payment of $4,800.00 is due by March 15, 2031.",
      "Reference INV-2041.",
      "",
    ].join("\r\n")
    const parsed = await parseMessage(new TextEncoder().encode(raw))
    // The parser's text starts after the stripped and trimmed lines, so offsets that index the
    // untrimmed text would be off.
    expect(parsed.text.startsWith("Hello,")).toBe(true)
    const { db, result, stored, fields } = await extractFrom(
      (entityId) =>
        testDoc("mail", {
          entityId,
          title: parsed.subject,
          body: parsed.text,
          headers: { messageId: parsed.messageId ?? "" },
        }),
      {
        action: { quote: "Payment of $4,800.00 is due" },
        amount: { quote: "$4,800.00" },
        due_date: { quote: "March 15, 2031" },
        reference_number: { quote: "INV-2041" },
      }
    )
    expect(result.status).toBe("ok")
    expect(stored.body).toBe(parsed.text)
    const [field] = fields
    const spans = expectSpansIndexBody(field ?? {}, stored.body)
    expect(spans[0]).toMatchObject({ message_id: "<m-2041@example.invalid>" })

    const view = documentsRoute(
      "GET",
      `/documents/${stored.sha256}`,
      new URLSearchParams(),
      { db }
    )
    if (view === null || !view.ok) throw new Error("viewer did not answer")
    const viewed = (view.body as { extractions: Array<{ fields: unknown[] }> })
      .extractions[0]?.fields as Array<{ verified: boolean; line: number }>
    expect(viewed.length).toBe(4)
    expect(viewed.every((f) => f.verified && f.line !== null)).toBe(true)
  })
})

describe("stored PDF", () => {
  const PAGE_ONE = ["Example Supply Co.", "Statement of account"]
  const PAGE_TWO = [
    "Example Supply Co.",
    "Invoice reference INV-2041",
    "Amount due by March 15, 2031: $4,800.00",
  ]

  async function storedPdf() {
    // Invisible characters in the parser's text: pdfAttachmentText strips them from the body
    // and from each page, so the body differs from the parser's text.
    const hidden = (line: string) => line.replace(/ /g, "​ ")
    const { text, offsets } = buildText([
      { page: 1, lines: PAGE_ONE.map(hidden) },
      { page: 2, lines: PAGE_TWO.map(hidden) },
    ])
    const parser = {
      storeOriginal: () => ({ sha256: "f".repeat(64), blobPath: "unused" }),
      parseDocument: () =>
        Promise.resolve({
          ok: true as const,
          sha256: "f".repeat(64),
          trust: "untrusted" as const,
          text,
          offsets,
          pages: 2,
        }),
    } as unknown as Parser
    const pdf = await pdfAttachmentText(parser, {
      filename: "statement.pdf",
      mime: "application/pdf",
      content: new Uint8Array([1]),
    })
    if (pdf === null) throw new Error("fixture parse failed")
    expect(pdf.text).not.toBe(text)
    return pdf
  }

  test("spans index the stripped body and carry the page the viewer's body offsets fall in", async () => {
    const pdf = await storedPdf()
    const { db, result, stored, fields } = await extractFrom(
      (entityId) =>
        testDoc("pdf", {
          entityId,
          mime: "application/pdf",
          body: pdf.text,
          pages: pdf.pages,
        }),
      {
        action: { quote: "Amount due by March 15, 2031" },
        party: { quote: "Example Supply Co." },
        amount: { quote: "$4,800.00" },
        reference_number: { quote: "INV-2041" },
      }
    )
    expect(result.status).toBe("ok")
    expect(stored.body).toBe(pdf.text)
    const [field] = fields
    expectSpansIndexBody(field ?? {}, stored.body)
    expect(field?.["amount"]?.span).toMatchObject({ page: 2, line: 3 })
    expect(field?.["reference_number"]?.span).toMatchObject({
      page: 2,
      line: 2,
    })

    const view = documentsRoute(
      "GET",
      `/documents/${stored.sha256}`,
      new URLSearchParams(),
      { db }
    )
    if (view === null || !view.ok) throw new Error("viewer did not answer")
    const viewed = (
      view.body as {
        extractions: Array<{ fields: unknown[] }>
      }
    ).extractions[0]?.fields as Array<{ verified: boolean }>
    expect(viewed.every((f) => f.verified)).toBe(true)
  })

  test("a span's page matches the page whose stored text holds its body offsets", async () => {
    const pdf = await storedPdf()
    const body = pdf.text
    const offsets = buildStoredOffsets(body, pdf.pages)
    for (const { page, text } of pdf.pages) {
      const start = body.indexOf(text)
      const entry = [...offsets].reverse().find((e) => e.offset <= start)
      expect(entry).toMatchObject({ page, line: 1 })
      const last = [...offsets]
        .reverse()
        .find((e) => e.offset <= start + text.length - 1)
      expect(last?.page).toBe(page)
    }
  })
})

describe("buildStoredOffsets", () => {
  test("a body with no pages numbers lines from the top and carries the message id", () => {
    expect(buildStoredOffsets("ab\ncd", [], "<m@example.invalid>")).toEqual([
      { offset: 0, messageId: "<m@example.invalid>", line: 1 },
      { offset: 3, messageId: "<m@example.invalid>", line: 2 },
    ])
  })

  test("a page whose text is not in the body is skipped", () => {
    expect(
      buildStoredOffsets("one\ntwo", [
        { page: 1, text: "one" },
        { page: 2, text: "gone" },
      ])
    ).toEqual([
      { offset: 0, page: 1, line: 1 },
      { offset: 4, line: 1 },
    ])
  })

  test("a repeated page resolves in order", () => {
    expect(
      buildStoredOffsets("same\nsame", [
        { page: 1, text: "same" },
        { page: 2, text: "same" },
      ])
    ).toEqual([
      { offset: 0, page: 1, line: 1 },
      { offset: 5, page: 2, line: 1 },
    ])
  })
})
