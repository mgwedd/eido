import { createHash } from "node:crypto"
import { afterEach, describe, expect, test } from "vitest"
import { createModelClient } from "../inference/client"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer } from "../inference/stub-server"
import { ledgerFixture } from "../ledger/ledger.test-support"
import type { ParseResult } from "../parsers/types"
import {
  formatReport,
  mimeFor,
  parseLabels,
  runAccuracy,
  scoreAccuracy,
} from "./accuracy"
import { jsonReply, parsedText } from "./extraction.test-support"

// Synthetic documents and labels only.

describe("parseLabels", () => {
  test("accepts the documented shape", () => {
    expect(
      parseLabels([
        {
          file: "letters/a.pdf",
          expected: [{ action: "Pay rent", party: "Example Co.", amount: "$10.00" }],
        },
        { file: "b.eml", expected: [] },
      ])
    ).toEqual([
      {
        file: "letters/a.pdf",
        expected: [{ action: "Pay rent", party: "Example Co.", amount: "$10.00" }],
      },
      { file: "b.eml", expected: [] },
    ])
  })

  test.each([
    [{}, "labels must be an array"],
    [[null], "labels[0] must be an object"],
    [[{ file: "a.pdf", expected: [], note: "x" }], "labels[0] has an unknown key note"],
    [[{ file: "/abs/a.pdf", expected: [] }], "labels[0].file must be a relative path inside the documents directory"],
    [[{ file: "../a.pdf", expected: [] }], "labels[0].file must be a relative path inside the documents directory"],
    [[{ file: "x/../../a.pdf", expected: [] }], "labels[0].file must be a relative path inside the documents directory"],
    [[{ file: "..", expected: [] }], "labels[0].file must be a relative path inside the documents directory"],
    [[{ file: "", expected: [] }], "labels[0].file must be a relative path inside the documents directory"],
    [[{ file: "a.pdf", expected: {} }], "labels[0].expected must be an array"],
    [[{ file: "a.pdf", expected: ["x"] }], "labels[0].expected[0] must be an object"],
    [[{ file: "a.pdf", expected: [{ action: "a", status: "paid" }] }], "labels[0].expected[0] has an unknown key status"],
    [[{ file: "a.pdf", expected: [{ action: 1 }] }], "labels[0].expected[0].action must be a string"],
    [[{ file: "a.pdf", expected: [{ party: "Example Co." }] }], "labels[0].expected[0].action is required"],
  ])("refuses %j", (value, message) => {
    expect(() => parseLabels(value)).toThrow(message)
  })
})

test("mimeFor maps parser-readable extensions, case-insensitively", () => {
  expect(mimeFor("scan.PDF")).toBe("application/pdf")
  expect(mimeFor("mail/x.eml")).toBe("message/rfc822")
  expect(mimeFor("photo.jpeg")).toBe("image/jpeg")
  expect(mimeFor("notes.docx")).toBeNull()
  expect(mimeFor("README")).toBeNull()
})

describe("scoreAccuracy and formatReport", () => {
  test("an empty run has no ratios", () => {
    const report = scoreAccuracy([])
    expect(report.verifiedRate).toBeNull()
    expect(report.fields.action).toEqual({
      expected: 0,
      extracted: 0,
      matched: 0,
      precision: null,
      recall: null,
    })
    expect(formatReport(report).split("\n").slice(0, 2)).toEqual([
      "documents: 0 (skipped 0, failed 0)",
      "statuses: none",
    ])
  })

  test("a value matches as often as it appears on both sides", () => {
    const report = scoreAccuracy([
      {
        file: "a.pdf",
        kind: "extracted",
        status: "ok",
        proposed: 3,
        verified: 3,
        needsConfirmation: 0,
        expected: [{ action: "Pay" }, { action: "Pay" }],
        extracted: [{ action: "Pay" }, { action: "Pay" }, { action: "Pay" }],
      },
    ])
    expect(report.fields.action).toMatchObject({ matched: 2, precision: 2 / 3, recall: 1 })
  })
})

describe("runAccuracy", () => {
  let server: StubModelServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test("stores, extracts and scores labelled documents with strict matching", async () => {
    const { db, property } = await ledgerFixture()
    const invoice = new TextEncoder().encode("%PDF-invoice")
    const broken = new TextEncoder().encode("%PDF-broken")
    const files: Record<string, Uint8Array> = {
      "invoice.pdf": invoice,
      "copy.pdf": invoice,
      "broken.pdf": broken,
      "notes.docx": new TextEncoder().encode("x"),
    }
    const shaOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    const invoiceText = parsedText(
      [
        "Example Supply Co.",
        "Payment of $4,800.00 is due by March 15, 2031.",
        "Ref INV-2041 renew",
      ].join("\n")
    )
    server = await startStubModelServer({
      replies: [
        jsonReply({
          nothing_found: false,
          items: [
            {
              action: { quote: "Payment of $4,800.00 is due" },
              party: { quote: "Example Supply Co." },
              amount: { quote: "$4,800.00" },
              due_date: { quote: "March 15, 2031" },
            },
            { action: { quote: "Ref INV-2041" }, reference_number: { quote: "INV-2041" } },
          ],
        }),
      ],
    })
    const { outcomes, report } = await runAccuracy(
      parseLabels([
        {
          file: "invoice.pdf",
          expected: [
            {
              action: "Payment of $4,800.00 is due",
              party: "Example Supply Co.",
              amount: "$4,800.00",
              // Strict: a label that differs from the document text by a comma does not match.
              due_date: "March 15 2031",
            },
            { action: "Pay the late fee" },
          ],
        },
        { file: "copy.pdf", expected: [] },
        { file: "broken.pdf", expected: [] },
        { file: "notes.docx", expected: [] },
      ]),
      {
        db,
        entityId: property.id,
        readFile: (file) => files[file] ?? new Uint8Array(),
        parser: {
          storeOriginal: (bytes) => ({ sha256: shaOf(bytes), blobPath: "unused" }),
          parseDocument: ({ blobSha256 }): Promise<ParseResult> =>
            Promise.resolve(
              blobSha256 === shaOf(invoice)
                ? {
                    ok: true,
                    sha256: blobSha256,
                    trust: "untrusted",
                    ...invoiceText,
                    pages: null,
                  }
                : { ok: false, sha256: blobSha256, reason: "malformed", detail: "bad" }
            ),
        },
        model: createModelClient({
          baseUrl: server.url,
          contextTokens: 1_000_000,
          maxReplyTokens: 1024,
        }),
        config: { model: "stub-model" },
        fieldConfidence: ({ field }) => (field === "reference_number" ? 0.5 : 1),
      }
    )

    expect(outcomes.map((o) => [o.file, o.kind])).toEqual([
      ["invoice.pdf", "extracted"],
      ["copy.pdf", "failed"],
      ["broken.pdf", "failed"],
      ["notes.docx", "skipped"],
    ])
    expect(outcomes[1]).toMatchObject({ reason: "same bytes as invoice.pdf" })
    expect(outcomes[2]).toMatchObject({
      reason: "the document could not be parsed (malformed)",
    })
    expect(formatReport(report)).toBe(
      [
        "documents: 4 (skipped 1, failed 2)",
        "statuses: ok 1",
        "field             precision  recall  matched/extracted/expected",
        "action            50.0%      50.0%   1/2/2",
        "party             100.0%     100.0%  1/1/1",
        "due_date          0.0%       0.0%    0/1/1",
        "amount            100.0%     100.0%  1/1/1",
        "reference_number  0.0%       n/a     0/1/0",
        "verified rate: 50.0% (1 of 2 proposed)",
        "sent to confirmation: 1",
      ].join("\n")
    )
  })
})
