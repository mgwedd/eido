import type { DatabaseSync } from "node:sqlite"
import type {
  CoreApiDocumentList,
  CoreApiDocumentView,
  CoreApiError,
  ExtractedFields,
} from "@eido/schemas"
import {
  validateCoreApiDocumentList,
  validateCoreApiDocumentView,
} from "@eido/schemas"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { confirmExtraction, insertExtraction } from "../ledger/index"
import {
  addDocs,
  ledgerFixture,
  sha,
  testDoc,
} from "../ledger/ledger.test-support"
import type { ProfileStore } from "../profile/store"
import type { Entity } from "../profile/types"
import { DEFAULT_LIMIT } from "./documents-route"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

// Synthetic text only; offsets below are computed from it, never hard-coded.
const INVOICE = [
  "Invoice 2030-17",
  "Please pay CHF 120.00 to Example Utility.",
  "Due by 2030-02-01.",
].join("\n")

let db: DatabaseSync
let profile: ProfileStore
let property: Entity
let company: Entity
let handle: ApiHandler
let invoice: string
let quote: string
let pdf: string

function at(time: string, docs: Parameters<typeof addDocs>[1]): string[] {
  vi.setSystemTime(new Date(time))
  return addDocs(db, docs)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  ;({ db, profile, property, company } = await ledgerFixture())
  ;[invoice = ""] = at("2030-01-01T00:00:00.000Z", [
    testDoc("invoice", {
      entityId: property.id,
      title: "Water invoice",
      body: INVOICE,
      occurredAt: "2029-12-30T08:00:00.000Z",
    }),
  ])
  ;[quote = ""] = at("2030-01-02T00:00:00.000Z", [
    testDoc("quote", {
      entityId: company.id,
      title: "Roof repair quote",
      body: "Quote for roof repair\nTotal CHF 900.00",
    }),
  ])
  ;[pdf = ""] = at("2030-01-03T00:00:00.000Z", [
    testDoc("pdf", {
      entityId: property.id,
      source: "upload",
      mime: "application/pdf",
      body: "Insurance policy renewal",
    }),
    // A drive file with no head row is a superseded version: the list hides it.
    testDoc("stale", { entityId: property.id, source: "drive" }),
  ])
  handle = createApiHandler({
    profile,
    allowedHosts: ["core.test"],
    basePath: "/api/core",
    documents: { db },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const get = (path: string): Promise<Response> =>
  handle(new Request(`http://core.test/api/core${path}`))

async function list(query = ""): Promise<CoreApiDocumentList> {
  const response = await get(`/documents${query}`)
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const checked = validateCoreApiDocumentList(body)
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value
}

async function view(sha256: string, query = ""): Promise<CoreApiDocumentView> {
  const response = await get(`/documents/${sha256}${query}`)
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const checked = validateCoreApiDocumentView(body)
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value
}

async function errorOf(
  response: Response
): Promise<CoreApiError["error"] & { status: number }> {
  const body = (await response.json()) as CoreApiError
  return { status: response.status, ...body.error }
}

const shas = (body: CoreApiDocumentList): string[] =>
  body.documents.map((d) => d.sha256)

function spanOf(needle: string): { start: number; end: number } {
  const start = INVOICE.indexOf(needle)
  if (start === -1) throw new Error(`fixture lacks ${needle}`)
  return { start, end: start + needle.length }
}

describe("GET /documents", () => {
  test("lists live documents newest first with their entity", async () => {
    const body = await list()
    expect(shas(body)).toEqual([pdf, quote, invoice])
    expect(body.nextOffset).toBeNull()
    expect(body.documents[2]).toEqual({
      sha256: invoice,
      name: "Water invoice",
      source: "gmail",
      sourceRef: "ref-invoice",
      type: "message/rfc822",
      entity: {
        id: property.id,
        kind: "property",
        name: property.name,
        tag: property.tag,
      },
      ingestedAt: "2030-01-01T00:00:00.000Z",
      occurredAt: "2029-12-30T08:00:00.000Z",
    })
    expect(body.documents[0]).toMatchObject({ name: null, occurredAt: null })
  })

  test("filters by entity, type and source", async () => {
    expect(shas(await list(`?entity=${property.id}`))).toEqual([pdf, invoice])
    expect(shas(await list(`?entity=${company.id}`))).toEqual([quote])
    expect(shas(await list("?type=application%2Fpdf"))).toEqual([pdf])
    expect(shas(await list("?source=gmail"))).toEqual([quote, invoice])
    expect(
      shas(await list(`?entity=${property.id}&type=message%2Frfc822`))
    ).toEqual([invoice])
  })

  test("blank filters are ignored", async () => {
    expect(shas(await list("?entity=&type=%20&q=%20%20"))).toEqual([
      pdf,
      quote,
      invoice,
    ])
  })

  test("searches title and body, all terms required", async () => {
    expect(shas(await list("?q=roof"))).toEqual([quote])
    expect(shas(await list("?q=Example%20Utility"))).toEqual([invoice])
    expect(shas(await list("?q=chf"))).toEqual(
      expect.arrayContaining([quote, invoice])
    )
    expect(shas(await list(`?q=chf&entity=${company.id}`))).toEqual([quote])
    expect(shas(await list("?q=roof%20utility"))).toEqual([])
  })

  test("ranks title matches over body matches", async () => {
    at("2030-01-04T00:00:00.000Z", [
      testDoc("mention", {
        entityId: company.id,
        title: "Weekly notes",
        body: "a quote came in",
      }),
    ])
    expect(shas(await list("?q=quote"))[0]).toBe(quote)
  })

  test("query syntax in q is treated as plain text", async () => {
    expect(shas(await list("?q=%22roof%22%20OR%20NEAR(x)"))).toEqual([])
    expect(shas(await list("?q=roof*"))).toEqual([quote])
  })

  test("no match is an empty list, not an error", async () => {
    expect(await list("?q=nonexistent")).toEqual({
      documents: [],
      nextOffset: null,
    })
    expect(await list("?q=%2A%2A%2A")).toEqual({
      documents: [],
      nextOffset: null,
    })
    expect(await list("?entity=no-such-entity")).toEqual({
      documents: [],
      nextOffset: null,
    })
  })

  test("pages with limit and offset", async () => {
    const first = await list("?limit=2")
    expect(shas(first)).toEqual([pdf, quote])
    expect(first.nextOffset).toBe(2)
    const second = await list("?limit=2&offset=2")
    expect(shas(second)).toEqual([invoice])
    expect(second.nextOffset).toBeNull()
    expect(await list("?offset=10")).toEqual({
      documents: [],
      nextOffset: null,
    })
  })

  test("defaults to a page of DEFAULT_LIMIT", async () => {
    at(
      "2030-02-01T00:00:00.000Z",
      Array.from({ length: DEFAULT_LIMIT }, (_, i) =>
        testDoc(`bulk-${String(i)}`, { entityId: company.id })
      )
    )
    const body = await list()
    expect(body.documents).toHaveLength(DEFAULT_LIMIT)
    expect(body.nextOffset).toBe(DEFAULT_LIMIT)
  })

  test.each([
    ["?limit=0", "limit"],
    ["?limit=201", "limit"],
    ["?limit=ten", "limit"],
    ["?limit=1.5", "limit"],
    ["?offset=-1", "offset"],
  ])("rejects %s", async (query, field) => {
    const error = await errorOf(await get(`/documents${query}`))
    expect(error).toMatchObject({ status: 422, code: "invalid" })
    expect(error.fields?.map((f) => f.field)).toEqual([field])
  })

  test("only GET is allowed", async () => {
    const response = await handle(
      new Request("http://core.test/api/core/documents", { method: "POST" })
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })
})

describe("GET /documents/:sha256", () => {
  test("returns the stored text by line with no highlight", async () => {
    const body = await view(invoice)
    expect(body.document.sha256).toBe(invoice)
    expect(body.lines).toEqual([
      { n: 1, start: 0, text: "Invoice 2030-17" },
      { n: 2, start: 16, text: "Please pay CHF 120.00 to Example Utility." },
      { n: 3, start: 58, text: "Due by 2030-02-01." },
    ])
    expect(body.highlight).toBeNull()
    expect(body.extractions).toEqual([])
  })

  test("highlights the requested span", async () => {
    const span = spanOf("CHF 120.00")
    const body = await view(
      invoice,
      `?start=${String(span.start)}&end=${String(span.end)}`
    )
    expect(body.highlight).toEqual({
      ...span,
      text: "CHF 120.00",
      fromLine: 2,
      toLine: 2,
    })
  })

  test("a span across lines reports both lines", async () => {
    const span = spanOf("Utility.\nDue")
    const body = await view(
      invoice,
      `?start=${String(span.start)}&end=${String(span.end)}`
    )
    expect(body.highlight).toMatchObject({ fromLine: 2, toLine: 3 })
  })

  test("a span ending at a line break stays on its line", async () => {
    const span = spanOf("Invoice 2030-17\n")
    const body = await view(
      invoice,
      `?start=${String(span.start)}&end=${String(span.end)}`
    )
    expect(body.highlight).toMatchObject({ fromLine: 1, toLine: 1 })
  })

  test.each([
    ["?start=3", "together"],
    ["?end=3", "together"],
    ["?start=a&end=3", "integers"],
    ["?start=-1&end=3", "integers"],
    ["?start=5&end=5", "outside"],
    ["?start=6&end=5", "outside"],
    [`?start=0&end=${String(INVOICE.length + 1)}`, "outside"],
  ])("rejects span %s", async (query, words) => {
    const error = await errorOf(await get(`/documents/${invoice}${query}`))
    expect(error).toMatchObject({ status: 400, code: "bad_request" })
    expect(error.message).toContain(words)
  })

  test("the span may reach the end of the text", async () => {
    const body = await view(invoice, `?start=0&end=${String(INVOICE.length)}`)
    expect(body.highlight).toMatchObject({ fromLine: 1, toLine: 3 })
  })

  test("an unknown or malformed id is 404", async () => {
    for (const id of ["0".repeat(64), "not-a-hash", invoice.toUpperCase()]) {
      const error = await errorOf(await get(`/documents/${id}`))
      expect(error).toMatchObject({ status: 404, code: "not_found" })
    }
  })

  test("a superseded drive version still opens in the viewer", async () => {
    expect((await view(sha("stale"))).document.source).toBe("drive")
  })

  test("only GET is allowed", async () => {
    const response = await handle(
      new Request(`http://core.test/api/core/documents/${invoice}`, {
        method: "DELETE",
      })
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })

  describe("extracted fields", () => {
    const amount = spanOf("CHF 120.00")
    const due = spanOf("2030-02-01")
    const party = spanOf("Example Utility")
    const action = spanOf("Please pay")
    const FIELDS: ExtractedFields = {
      action: { raw: "Please pay", span: action },
      party: { raw: "Example Utility", span: party },
      amount: {
        raw: "CHF 120.00",
        span: amount,
        status: "parsed",
        value: { amount_minor: 12000, currency: "CHF" },
      },
      due_date: {
        raw: "2030-02-01",
        span: due,
        status: "parsed",
        value: "2030-02-01",
      },
    }

    const store = (
      fields: ExtractedFields,
      confidence: Partial<Record<keyof ExtractedFields, number>>
    ): number =>
      insertExtraction(db, {
        docId: invoice,
        schema: "invoice.v1",
        status: "extracted",
        fields,
        confidence,
        model: "test-model",
        createdAt: "2030-01-05T00:00:00.000Z",
      })

    test("lists fields with value, line, confidence and verified", async () => {
      const id = store(FIELDS, {
        action: 0.95,
        party: 0.9,
        amount: 0.99,
        due_date: 0.85,
      })
      const body = await view(invoice)
      expect(body.extractions).toEqual([
        {
          id,
          createdAt: "2030-01-05T00:00:00.000Z",
          confirmedAt: null,
          fields: [
            {
              field: "action",
              raw: "Please pay",
              value: null,
              span: action,
              line: 2,
              confidence: 0.95,
              verified: true,
            },
            {
              field: "party",
              raw: "Example Utility",
              value: null,
              span: party,
              line: 2,
              confidence: 0.9,
              verified: true,
            },
            {
              field: "amount",
              raw: "CHF 120.00",
              value: { amount_minor: 12000, currency: "CHF" },
              span: amount,
              line: 2,
              confidence: 0.99,
              verified: true,
            },
            {
              field: "due_date",
              raw: "2030-02-01",
              value: "2030-02-01",
              span: due,
              line: 3,
              confidence: 0.85,
              verified: true,
            },
          ],
        },
      ])
    })

    test("low confidence is unverified until the extraction is confirmed", async () => {
      const id = store({ action: FIELDS.action }, { action: 0.5 })
      expect((await view(invoice)).extractions[0]?.fields[0]?.verified).toBe(
        false
      )
      confirmExtraction(db, id, "2030-01-06T00:00:00.000Z")
      const confirmed = (await view(invoice)).extractions[0]
      expect(confirmed?.confirmedAt).toBe("2030-01-06T00:00:00.000Z")
      expect(confirmed?.fields[0]?.verified).toBe(true)
    })

    test("a confidence threshold can be configured", async () => {
      store({ action: FIELDS.action }, { action: 0.85 })
      const strict = createApiHandler({
        profile,
        allowedHosts: ["core.test"],
        documents: { db, threshold: 0.9 },
      })
      const response = await strict(
        new Request(`http://core.test/documents/${invoice}`)
      )
      const body = (await response.json()) as CoreApiDocumentView
      expect(body.extractions[0]?.fields[0]?.verified).toBe(false)
    })

    test("a field that did not parse is never verified", async () => {
      store(
        {
          action: FIELDS.action,
          amount: {
            raw: "CHF 120.00",
            span: amount,
            status: "parse_failed",
            value: null,
          },
        },
        { action: 0.99, amount: 0.99 }
      )
      const [, field] = (await view(invoice)).extractions[0]?.fields ?? []
      expect(field).toMatchObject({
        field: "amount",
        value: null,
        verified: false,
      })
    })

    test("a quote that differs from the stored text is unverified", async () => {
      store(
        {
          action: { raw: "Please pay", span: party },
          reference_number: {
            raw: "2030-17",
            span: { start: INVOICE.length - 3, end: INVOICE.length + 4 },
          },
        },
        { action: 0.99, reference_number: 0.99 }
      )
      const fields = (await view(invoice)).extractions[0]?.fields ?? []
      expect(fields.map((f) => [f.field, f.line, f.verified])).toEqual([
        ["action", 2, false],
        ["reference_number", 3, false],
      ])
    })

    test("a span starting past the stored text has no line", async () => {
      store(
        {
          action: {
            raw: "Please pay",
            span: { start: INVOICE.length, end: INVOICE.length + 10 },
          },
        },
        { action: 0.99 }
      )
      const [field] = (await view(invoice)).extractions[0]?.fields ?? []
      expect(field).toMatchObject({ line: null, verified: false })
    })

    test("empty extractions are left out; rows come oldest first", async () => {
      insertExtraction(db, {
        docId: invoice,
        schema: "invoice.v1",
        status: "processed_empty",
        model: "none",
        createdAt: "2030-01-04T00:00:00.000Z",
      })
      const first = store({ action: FIELDS.action }, { action: 0.9 })
      const second = store(
        { party: FIELDS.party, action: FIELDS.action },
        {
          action: 0.9,
          party: 0.9,
        }
      )
      const body = await view(invoice)
      expect(body.extractions.map((e) => e.id)).toEqual([first, second])
    })
  })
})

test("documents are not served without the documents dependency", async () => {
  const bare = createApiHandler({ profile, allowedHosts: ["core.test"] })
  const response = await bare(new Request("http://core.test/documents"))
  expect(response.status).toBe(404)
})
