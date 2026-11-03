// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  actionableFollowUps,
  answerParts,
  computedFigures,
  loadAnswer,
  searchConversations,
  snippetParts,
  submitFollowUp,
} from "../lib/ask"
import { answered, noMatch, refused } from "./fixtures/ask"

afterEach(() => vi.unstubAllGlobals())
const signal = () => new AbortController().signal

describe("Ask HTTP client", () => {
  test("posts a trimmed question to core and validates its response", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(answered))
    )
    vi.stubGlobal("fetch", fetcher)
    expect(await loadAnswer("  Find the invoice  ", signal())).toEqual({
      status: "ready",
      value: answered,
    })
    expect(fetcher.mock.calls[0]).toMatchObject([
      "/api/core/ask",
      {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: '{"question":"Find the invoice"}',
      },
    ])
  })
  test.each(["", " ", "x".repeat(2001)])(
    "rejects an invalid question without a request",
    async (question) => {
      const fetcher = vi.fn<typeof fetch>()
      vi.stubGlobal("fetch", fetcher)
      expect(await loadAnswer(question, signal())).toEqual({ status: "error" })
      expect(fetcher).not.toHaveBeenCalled()
    }
  )
  test.each([
    () => Promise.resolve(new Response(null, { status: 503 })),
    () => Promise.resolve(Response.json({ answer: "invented" })),
    () => Promise.resolve(new Response("not json")),
    () => Promise.reject(new TypeError("network")),
  ])("fails closed on unavailable or invalid responses", async (fetcher) => {
    vi.stubGlobal("fetch", fetcher)
    expect(await loadAnswer("Find invoices", signal())).toEqual({
      status: "error",
    })
  })
})

describe("follow-up proposal handoff", () => {
  const intent = {
    kind: "email.archive",
    connector: "gmail",
    args: { messageIds: ["gm-invoice"] },
  }
  test.each([
    ["approval", "pending", "/queue"],
    ["auto", "executed", "/activity"],
  ])(
    "uses the returned %s tier for the proposed link",
    async (tier, state, href) => {
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({ id: "proposal-1", tier, state }, { status: 201 })
        )
      )
      vi.stubGlobal("fetch", fetcher)
      expect(await submitFollowUp(intent, signal())).toEqual({
        status: "proposed",
        href,
      })
      expect(fetcher.mock.calls).toMatchObject([
        [
          "/api/core/intents",
          {
            method: "POST",
            body: '{"intent":{"kind":"email.archive","connector":"gmail","args":{"messageIds":["gm-invoice"]}},"origin":"reactive"}',
          },
        ],
      ])
    }
  )
  test("invalid intents never reach HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    expect(
      await submitFollowUp(
        { kind: "email.archive", args: { messageIds: [] } },
        signal()
      )
    ).toEqual({ status: "error" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  test.each([
    () => Promise.resolve(new Response(null, { status: 403 })),
    () =>
      Promise.resolve(
        Response.json({ id: "p", tier: "forbidden", state: "rejected" })
      ),
    () => Promise.resolve(Response.json({ tier: "auto" })),
    () => Promise.resolve(new Response("not json")),
    () => Promise.reject(new TypeError("network")),
  ])(
    "does not claim a proposal on rejection or an unconfirmed response",
    async (fetcher) => {
      vi.stubGlobal("fetch", fetcher)
      expect(await submitFollowUp(intent, signal())).toEqual({
        status: "error",
      })
    }
  )
})

test("only metadata-backed citations become labels; unknown tags and HTML stay text", () => {
  expect(
    answerParts({
      ...answered,
      answer: "Paid [M1], unknown [M9]. <script>alert(1)</script>",
    })
  ).toEqual([
    { text: "Paid " },
    { text: "[M1]", tag: "M1" },
    { text: ", unknown " },
    { text: "[M9]" },
    { text: ". <script>alert(1)</script>" },
  ])
})
test("computed figures require a matching stable reference, never numbers in prose", () => {
  expect(
    computedFigures({
      ...answered,
      answer: "99 messages",
      figures: [
        { key: "matched", value: 99, location: "/coverage/matched" },
        { key: "searched", value: 1284, location: "/answer" },
        { key: "readInFull", value: 1, location: "/coverage/readInFull" },
      ],
    })
  ).toEqual([{ key: "readInFull", value: 1, location: "/coverage/readInFull" }])
})
test("non-answer states suppress even schema-valid stale suggestions", () => {
  expect(
    actionableFollowUps({ ...noMatch, followUps: answered.followUps })
  ).toEqual([])
  expect(
    actionableFollowUps({ ...refused, followUps: answered.followUps })
  ).toEqual([])
  expect(actionableFollowUps(answered)).toEqual(answered.followUps)
})

describe("searchConversations", () => {
  const sampleHits = [
    {
      conversationId: "c1",
      turnId: "t1",
      kind: "raw" as const,
      snippet: "review the [zebrafish] lease",
      score: -0.1,
    },
    {
      conversationId: "c2",
      kind: "digest" as const,
      snippet: "summary of [zebrafish] discussion",
      score: -0.5,
    },
  ]

  test("returns empty hits without fetch for empty query", async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetcher)
    expect(await searchConversations("   ")).toEqual({
      status: "ready",
      hits: [],
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("fetches search results and passes limit and kind parameters", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ hits: sampleHits }))
    )
    vi.stubGlobal("fetch", fetcher)
    const result = await searchConversations("zebrafish", {
      limit: 10,
      kind: "raw",
      signal: signal(),
    })
    expect(result).toEqual({ status: "ready", hits: sampleHits })
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/core/conversations/search?q=zebrafish&limit=10&kind=raw"
    )
  })

  test("omits kind when kind is any", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ hits: sampleHits }))
    )
    vi.stubGlobal("fetch", fetcher)
    await searchConversations("zebrafish", { kind: "any" })
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/core/conversations/search?q=zebrafish"
    )
  })

  test.each([
    () => Promise.resolve(new Response(null, { status: 500 })),
    () => Promise.resolve(Response.json({ hits: "not-an-array" })),
    () => Promise.reject(new TypeError("network")),
  ])("returns error on network or validation failures", async (fetcher) => {
    vi.stubGlobal("fetch", fetcher)
    expect(await searchConversations("zebrafish")).toEqual({ status: "error" })
  })
})

describe("snippetParts", () => {
  test("splits highlighted terms inside brackets from surrounding text", () => {
    expect(
      snippetParts("Please review the [zebrafish] lease renewal.")
    ).toEqual([
      { text: "Please review the ", highlighted: false },
      { text: "zebrafish", highlighted: true },
      { text: " lease renewal.", highlighted: false },
    ])
  })

  test("handles text without highlights", () => {
    expect(snippetParts("Plain text without highlights.")).toEqual([
      { text: "Plain text without highlights.", highlighted: false },
    ])
  })
})
