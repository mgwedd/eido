import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CoreApiConversationSearch } from "@eido/schemas"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"
import {
  rawTurn,
  storeFixture,
} from "../conversation/conversation.test-support"
import type { StoreFixture } from "../conversation/conversation.test-support"

let fixture: StoreFixture
let handle: ApiHandler

beforeEach(async () => {
  fixture = storeFixture()
  const { store } = fixture

  await store.appendTurn(
    "c1",
    rawTurn(1, "Please review the zebrafish lease renewal.")
  )
  await store.appendTurn(
    "c1",
    rawTurn(2, "The renewal asks for roof repair before March.")
  )
  await store.appendTurn(
    "c2",
    rawTurn(3, "Did we ever repair the roof last year?")
  )
  await store.appendTurn(
    "c3",
    rawTurn(4, "Lease agreement for office building.")
  )

  await store.appendTurn("c4", rawTurn(5, "Initial discussion about animals."))

  await store.putDigest(
    "c4",
    "Summary of discussions regarding pangolin habitat and lease options.",
    fixture.store.fingerprint("c4") ?? "fingerprint-c4",
    "2025-10-20T10:00:00Z",
    {
      summary: "Pangolin habitat notes.",
      coveredTurns: 1,
    }
  )

  const profileDb = openIndex(":memory:")
  handle = createApiHandler({
    profile: createProfileStore(profileDb, { audit: () => Promise.resolve() }),
    allowedHosts: ["core.test"],
    conversations: fixture.store,
  })
})

afterEach(() => {
  fixture.cleanup()
})

function get(path: string, h: ApiHandler = handle): Promise<Response> {
  return h(
    new Request(`http://core.test${path}`, {
      method: "GET",
      headers: { host: "core.test" },
    })
  )
}

describe("GET /conversations/search", () => {
  it("returns 404 when conversations store is absent", async () => {
    const profileDb = openIndex(":memory:")
    const bare = createApiHandler({
      profile: createProfileStore(profileDb, {
        audit: () => Promise.resolve(),
      }),
      allowedHosts: ["core.test"],
    })
    const response = await get("/conversations/search?q=zebrafish", bare)
    expect(response.status).toBe(404)
  })

  it("returns 405 for methods other than GET", async () => {
    const response = await handle(
      new Request("http://core.test/conversations/search?q=zebrafish", {
        method: "POST",
        headers: { host: "core.test" },
      })
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
  })

  it("returns empty list for empty or non-searchable queries", async () => {
    for (const url of [
      "/conversations/search",
      "/conversations/search?q=",
      "/conversations/search?q=   ",
      '/conversations/search?q=  "" * ',
    ]) {
      const response = await get(url)
      expect(response.status).toBe(200)
      const data = (await response.json()) as CoreApiConversationSearch
      expect(data.hits).toEqual([])
    }
  })

  it("validates limit and kind parameters", async () => {
    const invalidLimit = await get("/conversations/search?q=lease&limit=0")
    expect(invalidLimit.status).toBe(422)
    const limitBody = (await invalidLimit.json()) as {
      error: { fields: { field: string; message: string }[] }
    }
    expect(limitBody.error.fields).toEqual([
      { field: "limit", message: "must be an integer from 1 to 100" },
    ])

    const invalidKind = await get("/conversations/search?q=lease&kind=foo")
    expect(invalidKind.status).toBe(422)
    const kindBody = (await invalidKind.json()) as {
      error: { fields: { field: string; message: string }[] }
    }
    expect(kindBody.error.fields).toEqual([
      { field: "kind", message: 'must be "raw", "digest" or "any"' },
    ])
  })

  it("matches raw turns and returns snippets with turnId and kind raw", async () => {
    const response = await get("/conversations/search?q=zebrafish")
    expect(response.status).toBe(200)
    const data = (await response.json()) as CoreApiConversationSearch
    expect(data.hits).toHaveLength(1)
    const hit = data.hits[0]
    expect(hit?.conversationId).toBe("c1")
    expect(hit?.turnId).toBe("t1")
    expect(hit?.kind).toBe("raw")
    expect(hit?.snippet).toContain("[zebrafish]")
    expect(typeof hit?.score).toBe("number")
  })

  it("matches digests and returns snippet with kind digest without turnId", async () => {
    const response = await get("/conversations/search?q=pangolin")
    expect(response.status).toBe(200)
    const data = (await response.json()) as CoreApiConversationSearch
    expect(data.hits).toHaveLength(1)
    const hit = data.hits[0]
    expect(hit?.conversationId).toBe("c4")
    expect(hit?.turnId).toBeUndefined()
    expect(hit?.kind).toBe("digest")
    expect(hit?.snippet).toContain("[pangolin]")
    expect(typeof hit?.score).toBe("number")
  })

  it("respects limit parameter", async () => {
    const responseAll = await get("/conversations/search?q=lease")
    const dataAll = (await responseAll.json()) as CoreApiConversationSearch
    expect(dataAll.hits.length).toBeGreaterThan(1)

    const responseLimited = await get("/conversations/search?q=lease&limit=1")
    const dataLimited =
      (await responseLimited.json()) as CoreApiConversationSearch
    expect(dataLimited.hits).toHaveLength(1)
    expect(dataLimited.hits[0]?.conversationId).toBe(
      dataAll.hits[0]?.conversationId
    )
  })

  it("filters by kind", async () => {
    // "lease" matches raw turns in c1, c3 and digest in c4
    const responseRaw = await get("/conversations/search?q=lease&kind=raw")
    const dataRaw = (await responseRaw.json()) as CoreApiConversationSearch
    expect(dataRaw.hits.length).toBeGreaterThanOrEqual(1)
    expect(dataRaw.hits.every((h) => h.kind === "raw")).toBe(true)

    const responseDigest = await get(
      "/conversations/search?q=lease&kind=digest"
    )
    const dataDigest =
      (await responseDigest.json()) as CoreApiConversationSearch
    expect(dataDigest.hits).toHaveLength(1)
    expect(dataDigest.hits[0]?.kind).toBe("digest")
    expect(dataDigest.hits[0]?.conversationId).toBe("c4")

    const responseAny = await get("/conversations/search?q=lease&kind=any")
    const dataAny = (await responseAny.json()) as CoreApiConversationSearch
    const kinds = new Set(dataAny.hits.map((h) => h.kind))
    expect(kinds.has("raw")).toBe(true)
    expect(kinds.has("digest")).toBe(true)
  })

  it("returns internal error if search hit fails validation", async () => {
    const brokenStore = {
      ...fixture.store,
      searchConversations: () => [
        {
          conversationId: "c1",
          kind: "bogus" as unknown as "raw",
          snippet: "s",
          score: 1,
        },
      ],
    }
    const profileDb = openIndex(":memory:")
    const h = createApiHandler({
      profile: createProfileStore(profileDb, {
        audit: () => Promise.resolve(),
      }),
      allowedHosts: ["core.test"],
      conversations: brokenStore,
    })
    const response = await get("/conversations/search?q=test", h)
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("internal")
  })
})
