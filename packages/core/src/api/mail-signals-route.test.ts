import type { DatabaseSync } from "node:sqlite"
import type { CoreApiError, CoreApiMailSignals } from "@eido/schemas"
import { validateCoreApiMailSignals } from "@eido/schemas"
import { beforeEach, describe, expect, test } from "vitest"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

// Synthetic messages only: invented domains under example.invalid.
let db: DatabaseSync
let handle: ApiHandler
let flagged: string
let clean: string
let pdf: string

beforeEach(async () => {
  const fixture = await ledgerFixture()
  db = fixture.db
  const entityId = fixture.property.id
  handle = createApiHandler({
    profile: fixture.profile,
    allowedHosts: ["core.test"],
    basePath: "/api/core",
    documents: { db },
  })
  ;[flagged = "", clean = "", pdf = ""] = addDocs(db, [
    testDoc("flagged", {
      entityId,
      // Stored out of core's order, and two link signals out of detail order.
      mailSignals: [
        {
          kind: "link_mismatch",
          detail: "shop.example.invalid -> pay.example.invalid",
        },
        { kind: "reply_to_domain", detail: "pay.example.invalid" },
        {
          kind: "link_mismatch",
          detail: "bank.example.invalid -> pay.example.invalid",
        },
        { kind: "dmarc_fail", detail: "fail" },
        { kind: "spf_fail", detail: "fail" },
      ],
    }),
    testDoc("clean", { entityId }),
    testDoc("scan", { entityId, source: "drive", mime: "application/pdf" }),
  ])
})

const get = (sha256: string, method = "GET"): Promise<Response> =>
  handle(
    new Request(`http://core.test/api/core/mail/${sha256}/signals`, { method })
  )

async function errorOf(response: Response): Promise<CoreApiError["error"]> {
  const body = (await response.json()) as CoreApiError
  return body.error
}

describe("GET /mail/:sha256/signals", () => {
  test("lists a flagged message's signals in core's kind order, auth kinds without detail", async () => {
    const response = await get(flagged)
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(validateCoreApiMailSignals(body).ok).toBe(true)
    expect(body).toEqual({
      signals: [
        { kind: "spf_fail" },
        { kind: "dmarc_fail" },
        { kind: "reply_to_domain", detail: "pay.example.invalid" },
        {
          kind: "link_mismatch",
          detail: "bank.example.invalid -> pay.example.invalid",
        },
        {
          kind: "link_mismatch",
          detail: "shop.example.invalid -> pay.example.invalid",
        },
      ],
    } satisfies CoreApiMailSignals)
  })

  test("a clean message has an empty list", async () => {
    const response = await get(clean)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ signals: [] })
  })

  test("a stored document that is not a mail message is 404", async () => {
    const response = await get(pdf)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe("not_found")
  })

  test("a message that is not stored is 404", async () => {
    const response = await get("c".repeat(64))
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe("not_found")
  })

  test("a malformed sha256 is 400", async () => {
    const response = await get("ABC")
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe("bad_request")
  })

  test("a write method is 405 with Allow: GET", async () => {
    const response = await get(flagged, "POST")
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })

  test("is not served without the data DB", async () => {
    const bare = createApiHandler({
      profile: (await ledgerFixture()).profile,
      allowedHosts: ["core.test"],
      basePath: "/api/core",
    })
    const response = await bare(
      new Request(`http://core.test/api/core/mail/${flagged}/signals`)
    )
    expect(response.status).toBe(404)
  })
})
