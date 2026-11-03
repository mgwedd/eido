import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CoreApiConversationSearch } from "@eido/schemas"
import { validateCoreApiConversationSearch } from "@eido/schemas"
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

async function search(
  path: string,
  h: ApiHandler = handle
): Promise<CoreApiConversationSearch> {
  const response = await get(path, h)
  expect(response.status).toBe(200)
  const result = validateCoreApiConversationSearch(await response.json())
  if (!result.ok) throw new Error("response does not match the schema")
  return result.value
}

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
      expect((await search(url)).hits).toEqual([])
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
    const data = await search("/conversations/search?q=zebrafish")
    expect(data.hits).toHaveLength(1)
    const hit = data.hits[0]
    expect(hit?.conversationId).toBe("c1")
    expect(hit?.turnId).toBe("t1")
    expect(hit?.kind).toBe("raw")
    expect(hit?.snippet).toContain("\uE000zebrafish\uE001")
    expect(typeof hit?.score).toBe("number")
  })

  it("matches digests and returns snippet with kind digest without turnId", async () => {
    const data = await search("/conversations/search?q=pangolin")
    expect(data.hits).toHaveLength(1)
    const hit = data.hits[0]
    expect(hit?.conversationId).toBe("c4")
    expect(hit?.turnId).toBeUndefined()
    expect(hit?.kind).toBe("digest")
    expect(hit?.snippet).toContain("\uE000pangolin\uE001")
    expect(typeof hit?.score).toBe("number")
  })

  it("respects limit parameter", async () => {
    const dataAll = await search("/conversations/search?q=lease")
    expect(dataAll.hits).toHaveLength(3)

    const dataLimited = await search("/conversations/search?q=lease&limit=2")
    expect(dataLimited.hits).toHaveLength(2)
    expect(dataLimited.hits.map((h) => h.conversationId)).toEqual(
      dataAll.hits.slice(0, 2).map((h) => h.conversationId)
    )
  })

  it("filters by kind", async () => {
    // "lease" matches raw turns in c1, c3 and digest in c4
    const dataRaw = await search("/conversations/search?q=lease&kind=raw")
    expect(dataRaw.hits.map((h) => [h.kind, h.conversationId])).toEqual([
      ["raw", "c3"],
      ["raw", "c1"],
    ])

    const dataDigest = await search("/conversations/search?q=lease&kind=digest")
    expect(dataDigest.hits).toHaveLength(1)
    expect(dataDigest.hits[0]?.kind).toBe("digest")
    expect(dataDigest.hits[0]?.conversationId).toBe("c4")

    const dataAny = await search("/conversations/search?q=lease&kind=any")
    expect(dataAny.hits.map((h) => h.kind).sort()).toEqual([
      "digest",
      "raw",
      "raw",
    ])
  })

  it.each(["foo AND", "NEAR(", '"unbalanced', "a-b", "(", "col:x", "*"])(
    "answers 200 for the hostile FTS string %s",
    async (q) => {
      const data = await search(
        `/conversations/search?q=${encodeURIComponent(q)}`
      )
      expect(Array.isArray(data.hits)).toBe(true)
    }
  )

  it("rejects a query longer than 256 characters with 422 and the q field", async () => {
    const atCap = await get(`/conversations/search?q=${"a".repeat(256)}`)
    expect(atCap.status).toBe(200)

    const response = await get(`/conversations/search?q=${"a".repeat(257)}`)
    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { fields: { field: string; message: string }[] }
    }
    expect(body.error.fields).toEqual([
      { field: "q", message: "must be at most 256 characters" },
    ])
  })

  it("keeps literal brackets in turn text distinct from match markers", async () => {
    await fixture.store.appendTurn(
      "c5",
      rawTurn(6, "See item [1] about the quokka enclosure.")
    )
    const data = await search("/conversations/search?q=quokka")
    expect(data.hits[0]?.snippet).toBe(
      "See item [1] about the \uE000quokka\uE001 enclosure."
    )
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
