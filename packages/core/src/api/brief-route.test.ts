import type { DatabaseSync } from "node:sqlite"
import type { CoreApiBrief, CoreApiError } from "@eido/schemas"
import { validateCoreApiBrief } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { generateBrief } from "../brief/index"
import type { Brief } from "../brief/index"
import { insertBrief } from "../brief/store"
import {
  CONFIG,
  NOW,
  fixture,
  putDoc,
  putObligation,
} from "../brief/brief.test-support"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

let db: DatabaseSync
let handle: ApiHandler
let entityId: string

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)

beforeEach(async () => {
  const f = await fixture()
  db = f.db
  entityId = f.entityId
  handle = createApiHandler({
    profile: f.profile,
    allowedHosts: ["core.test"],
    basePath: "/api/core",
    documents: { db },
  })
})

const get = (path: string, method = "GET"): Promise<Response> =>
  handle(new Request(`http://core.test/api/core/brief/${path}`, { method }))

async function errorOf(response: Response): Promise<CoreApiError["error"]> {
  const body = (await response.json()) as CoreApiError
  return body.error
}

function stored(forDate: string, over: Partial<Brief> = {}): Brief {
  return {
    id: `brief-${forDate}`,
    forDate,
    generatedAt: `${forDate}T06:02:00.000Z`,
    windowStart: "2026-10-31T06:00:00.000Z",
    windowEnd: `${forDate}T06:00:00.000Z`,
    lines: [],
    coverage: {
      messagesRead: 212,
      messagesTotal: 212,
      documentsRead: 5,
      documentsTotal: 6,
      windowStart: "2026-10-31T06:00:00.000Z",
      windowEnd: `${forDate}T06:00:00.000Z`,
      skipped: 0,
    },
    coverageLine: "Read 212 new messages and 5 of 6 documents since yesterday.",
    ...over,
  }
}

describe("GET /brief/latest", () => {
  test("is 404 when no brief exists", async () => {
    const response = await get("latest")
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe("not_found")
  })

  test("returns the newest local date's brief, not the most recently inserted", async () => {
    insertBrief(db, stored("2026-11-02"))
    insertBrief(db, stored("2026-10-30"))
    const response = await get("latest")
    expect(response.status).toBe(200)
    const body = (await response.json()) as CoreApiBrief
    expect(body.date).toBe("2026-11-02")
    expect(body.id).toBe("brief-2026-11-02")
  })

  test("carries lines with ledger refs and source spans, coverage, generated time and date", async () => {
    const doc = putDoc(db, entityId, "old", "2026-10-20T05:00:00.000Z")
    const id = await putObligation(db, entityId, doc, {
      action: "Reply to the landlord",
      party: "Landlord Example",
      dueAt: "2026-10-30",
      span: { start: 4, end: 20, message_id: "m-old" },
    })
    const generated = await generateBrief(db, NOW, CONFIG)
    const response = await get("latest")
    const body = (await response.json()) as CoreApiBrief
    expect(validateCoreApiBrief(body).ok).toBe(true)
    expect(body.date).toBe("2026-11-02")
    expect(body.generatedAt).toBe(generated.generatedAt)
    expect(body.coverageLine).toBe(generated.coverageLine)
    expect(body.coverage).toEqual(generated.coverage)
    expect(body.lines).toEqual([
      {
        kind: "overdue",
        text: "Reply to the landlord (Landlord Example): 3 days overdue",
        ledger: { type: "obligation", id: String(id) },
        source: {
          documentId: doc,
          span: { start: 4, end: 20, message_id: "m-old" },
        },
      },
    ])
  })

  test("serves detail cites and the more line", async () => {
    insertBrief(
      db,
      stored("2026-11-02", {
        lines: [
          {
            kind: "due",
            text: "Pay the estimated tax: due 2026-11-15",
            ledger: { type: "obligation", id: "7" },
            source: { docSha256: SHA_A, page: 2, start: 30, end: 40 },
            detail: {
              text: "The notice opens a 30 day window.",
              cites: [
                {
                  docSha256: SHA_B,
                  page: 3,
                  injectionSuspected: false,
                  reasons: [],
                },
                { messageId: "m1", injectionSuspected: false, reasons: [] },
              ],
            },
          },
          {
            kind: "more",
            text: "and 4 more in the ledger",
            count: 4,
            ledger: { type: "ledger" },
          },
        ],
      })
    )
    const body = (await (await get("latest")).json()) as CoreApiBrief
    expect(validateCoreApiBrief(body).ok).toBe(true)
    expect(body.lines).toEqual([
      {
        kind: "due",
        text: "Pay the estimated tax: due 2026-11-15",
        ledger: { type: "obligation", id: "7" },
        source: {
          documentId: SHA_A,
          span: { start: 30, end: 40, page: 2 },
        },
        detail: {
          text: "The notice opens a 30 day window.",
          cites: [{ documentId: SHA_B, page: 3 }, { messageId: "m1" }],
        },
      },
      {
        kind: "more",
        text: "and 4 more in the ledger",
        count: 4,
        ledger: { type: "ledger" },
      },
    ])
  })

  test("an empty brief is served with no lines", async () => {
    insertBrief(db, stored("2026-11-02"))
    const body = (await (await get("latest")).json()) as CoreApiBrief
    expect(body.lines).toEqual([])
    expect(validateCoreApiBrief(body).ok).toBe(true)
  })
})

describe("GET /brief/:date", () => {
  test("returns that local date's brief", async () => {
    insertBrief(db, stored("2026-11-02"))
    insertBrief(db, stored("2026-10-30"))
    const response = await get("2026-10-30")
    expect(response.status).toBe(200)
    expect(((await response.json()) as CoreApiBrief).id).toBe(
      "brief-2026-10-30"
    )
  })

  test("is 404 for a date with no brief", async () => {
    insertBrief(db, stored("2026-11-02"))
    const response = await get("2026-11-01")
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe("not_found")
  })

  test.each([
    ["not a date", "yesterday"],
    ["wrong separators", "2026%2F11%2F02"],
    ["no zero padding", "2026-1-2"],
    ["month 13", "2026-13-01"],
    ["day not in month", "2026-02-30"],
    ["trailing text", "2026-11-02x"],
    ["bad escape", "%E0%A4%A"],
  ])("is 400 for a malformed date (%s)", async (_name, value) => {
    insertBrief(db, stored("2026-11-02"))
    const response = await get(value)
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe("bad_request")
  })

  test("accepts a leap day", async () => {
    insertBrief(db, stored("2028-02-29"))
    expect((await get("2028-02-29")).status).toBe(200)
  })

  test("only GET is allowed", async () => {
    const response = await get("latest", "POST")
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })
})

describe("without a data DB", () => {
  test("the brief is not served", async () => {
    const f = await fixture()
    const bare = createApiHandler({
      profile: f.profile,
      allowedHosts: ["core.test"],
    })
    const response = await bare(new Request("http://core.test/brief/latest"))
    expect(response.status).toBe(404)
  })
})
