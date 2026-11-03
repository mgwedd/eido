import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CoreApiConversationGet, CoreApiError } from "@eido/schemas"
import {
  validateCoreApiConversationGet,
  validateCoreApiConversationSearch,
} from "@eido/schemas"
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
    "c1",
    rawTurn(3, "We should schedule a contractor inspection.")
  )

  await store.putDigest(
    "c1",
    "Summary of zebrafish lease discussions and roof repair.",
    store.fingerprint("c1") ?? "fingerprint-c1",
    "2025-10-20T10:00:00Z",
    {
      summary: "Zebrafish lease summary.",
      coveredTurns: 2,
    }
  )

  await store.appendTurn("c2", rawTurn(4, "Meeting notes on Q1 budget."))
  await store.appendTurn("c2", rawTurn(5, "Approved budget for Q1."))

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

async function getConversation(
  path: string,
  h: ApiHandler = handle
): Promise<CoreApiConversationGet> {
  const response = await get(path, h)
  expect(response.status).toBe(200)
  const result = validateCoreApiConversationGet(await response.json())
  if (!result.ok) throw new Error("response does not match the schema")
  return result.value
}

describe("GET /conversations/:id", () => {
  it("fetches a stored conversation and gets its turns in order with turn ids matching search hits' turn ids", async () => {
    const searchRes = await handle(
      new Request("http://core.test/conversations/search?q=zebrafish", {
        method: "GET",
        headers: { host: "core.test" },
      })
    )
    expect(searchRes.status).toBe(200)
    const searchValidation = validateCoreApiConversationSearch(
      await searchRes.json()
    )
    expect(searchValidation.ok).toBe(true)
    if (!searchValidation.ok) return
    const rawHit = searchValidation.value.hits.find((h) => h.kind === "raw")
    expect(rawHit?.turnId).toBe("t1")

    const conversation = await getConversation("/conversations/c1")
    expect(conversation.id).toBe("c1")
    expect(conversation.conversationId).toBe("c1")
    expect(conversation.turns).toHaveLength(3)

    expect(conversation.turns[0]?.id).toBe("t1")
    expect(conversation.turns[0]?.id).toBe(rawHit?.turnId)
    expect(conversation.turns[0]?.role).toBe("user")
    expect(conversation.turns[0]?.text).toBe(
      "Please review the zebrafish lease renewal."
    )

    expect(conversation.turns[1]?.id).toBe("t2")
    expect(conversation.turns[1]?.role).toBe("assistant")
    expect(conversation.turns[1]?.text).toBe(
      "The renewal asks for roof repair before March."
    )

    expect(conversation.turns[2]?.id).toBe("t3")
    expect(conversation.turns[2]?.role).toBe("user")
    expect(conversation.turns[2]?.text).toBe(
      "We should schedule a contractor inspection."
    )

    expect(conversation.turns.map((t) => t.id)).toEqual(["t1", "t2", "t3"])
  })

  it("appropriately marks digests on turns", async () => {
    const withDigest = await getConversation("/conversations/c1")
    expect(withDigest.digest).toEqual({
      text: "Summary of zebrafish lease discussions and roof repair.",
      createdAt: "2025-10-20T10:00:00Z",
      coveredTurns: 2,
    })

    expect(withDigest.turns[0]?.digested).toBe(true)
    expect(withDigest.turns[0]?.digest).toBe(true)
    expect(withDigest.turns[1]?.digested).toBe(true)
    expect(withDigest.turns[1]?.digest).toBe(true)
    expect(withDigest.turns[2]?.digested).toBe(false)
    expect(withDigest.turns[2]?.digest).toBe(false)

    const withoutDigest = await getConversation("/conversations/c2")
    expect(withoutDigest.digest).toBeNull()
    expect(withoutDigest.turns[0]?.digested).toBe(false)
    expect(withoutDigest.turns[0]?.digest).toBe(false)
    expect(withoutDigest.turns[1]?.digested).toBe(false)
    expect(withoutDigest.turns[1]?.digest).toBe(false)
  })

  it("returns 404 with core error shape for an unknown id", async () => {
    const response = await get("/conversations/unknown-id")
    expect(response.status).toBe(404)
    const body = (await response.json()) as CoreApiError
    expect(body).toEqual({
      error: {
        code: "not_found",
        message: "conversation not found",
      },
    })
  })

  it("returns 404 when conversations store is absent", async () => {
    const profileDb = openIndex(":memory:")
    const bare = createApiHandler({
      profile: createProfileStore(profileDb, {
        audit: () => Promise.resolve(),
      }),
      allowedHosts: ["core.test"],
    })
    const response = await get("/conversations/c1", bare)
    expect(response.status).toBe(404)
    const body = (await response.json()) as CoreApiError
    expect(body).toEqual({
      error: {
        code: "not_found",
        message: "no such route",
      },
    })
  })

  it("validates missing or invalid id parameter", async () => {
    const missingTrailing = await get("/conversations/")
    expect(missingTrailing.status).toBe(422)
    const missingTrailingBody = (await missingTrailing.json()) as CoreApiError
    expect(missingTrailingBody.error.code).toBe("invalid")
    expect(missingTrailingBody.error.fields).toEqual([
      { field: "id", message: "conversation id is required" },
    ])

    const missingRoot = await get("/conversations")
    expect(missingRoot.status).toBe(422)
    const missingRootBody = (await missingRoot.json()) as CoreApiError
    expect(missingRootBody.error.code).toBe("invalid")
    expect(missingRootBody.error.fields).toEqual([
      { field: "id", message: "conversation id is required" },
    ])

    const whitespace = await get("/conversations/%20%20")
    expect(whitespace.status).toBe(422)
    const whitespaceBody = (await whitespace.json()) as CoreApiError
    expect(whitespaceBody.error.code).toBe("invalid")
    expect(whitespaceBody.error.fields).toEqual([
      { field: "id", message: "conversation id must not be empty" },
    ])

    const malformed = await get("/conversations/%FF")
    expect(malformed.status).toBe(422)
    const malformedBody = (await malformed.json()) as CoreApiError
    expect(malformedBody.error.code).toBe("invalid")
    expect(malformedBody.error.fields).toEqual([
      { field: "id", message: "malformed conversation id" },
    ])

    const overlong = await get(`/conversations/${"x".repeat(257)}`)
    expect(overlong.status).toBe(422)
    const overlongBody = (await overlong.json()) as CoreApiError
    expect(overlongBody.error.code).toBe("invalid")
    expect(overlongBody.error.fields).toEqual([
      {
        field: "id",
        message: "conversation id must be at most 256 characters",
      },
    ])
  })

  it("returns 405 Method Not Allowed for non-GET requests", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await handle(
        new Request("http://core.test/conversations/c1", {
          method,
          headers: { host: "core.test" },
        })
      )
      expect(response.status).toBe(405)
      const body = (await response.json()) as CoreApiError
      expect(body).toEqual({
        error: {
          code: "method_not_allowed",
          message: "method not allowed",
        },
      })
    }
  })

  it("decodes URI-encoded conversation id", async () => {
    await fixture.store.appendTurn(
      "chat:session:1",
      rawTurn(6, "Special characters in conversation id.")
    )

    const conversation = await getConversation(
      "/conversations/chat%3Asession%3A1"
    )
    expect(conversation.id).toBe("chat:session:1")
    expect(conversation.turns[0]?.text).toBe(
      "Special characters in conversation id."
    )
  })

  it("serves under a configured basePath", async () => {
    const profileDb = openIndex(":memory:")
    const prefixed = createApiHandler({
      profile: createProfileStore(profileDb, {
        audit: () => Promise.resolve(),
      }),
      allowedHosts: ["core.test"],
      conversations: fixture.store,
      basePath: "/api/core",
    })

    const prefixedRes = await prefixed(
      new Request("http://core.test/api/core/conversations/c1", {
        method: "GET",
        headers: { host: "core.test" },
      })
    )
    expect(prefixedRes.status).toBe(200)

    const unPrefixedRes = await prefixed(
      new Request("http://core.test/conversations/c1", {
        method: "GET",
        headers: { host: "core.test" },
      })
    )
    expect(unPrefixedRes.status).toBe(404)
  })

  it("returns 500 internal error if conversation response fails schema validation", async () => {
    const brokenStore = {
      ...fixture.store,
      getTurns: () => [
        {
          id: "t1",
          role: "invalid-role" as unknown as "user",
          text: "Broken turn",
          at: "2025-10-10T09:00:00Z",
          sources: [],
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
    const response = await get("/conversations/c1", h)
    expect(response.status).toBe(500)
    const body = (await response.json()) as CoreApiError
    expect(body.error.code).toBe("internal")
  })
})
