import { afterEach, describe, expect, test, vi } from "vitest"
import {
  conversationDate,
  isSearchable,
  loadConversation,
  loadSearch,
  matchCountLabel,
  parseRoute,
  routeUrl,
  snippetParts,
  turnCountLabel,
} from "../lib/ask-search"
import {
  conversation,
  digestHit,
  END,
  hostileHit,
  START,
  turnHit,
} from "./fixtures/ask-search"

afterEach(() => vi.unstubAllGlobals())

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(() =>
    response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}
const signal = new AbortController().signal

describe("snippetParts", () => {
  test("splits on the match markers and never emits a marker", () => {
    expect(snippetParts(`a ${START}b${END} c ${START}d${END}`)).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
      { text: " c ", match: false },
      { text: "d", match: true },
    ])
  })
  test("leaves markup characters as plain text", () => {
    expect(snippetParts(hostileHit.snippet)).toEqual([
      { text: "<img src=x onerror=alert(1)> ", match: false },
      { text: "roof", match: true },
    ])
  })
  test("an unclosed match runs to the end and a stray end marker is dropped", () => {
    expect(snippetParts(`x ${START}tail`)).toEqual([
      { text: "x ", match: false },
      { text: "tail", match: true },
    ])
    expect(snippetParts(`x${END}y`)).toEqual([
      { text: "x", match: false },
      { text: "y", match: false },
    ])
  })
  test("a snippet with no marker is one unmarked part", () => {
    expect(snippetParts("plain")).toEqual([{ text: "plain", match: false }])
  })
})

test("a query needs two characters after trimming", () => {
  expect(isSearchable("r")).toBe(false)
  expect(isSearchable(" r ")).toBe(false)
  expect(isSearchable("ro")).toBe(true)
})

test("match counts are singular for one", () => {
  expect(matchCountLabel(1)).toBe("1 match")
  expect(matchCountLabel(3)).toBe("3 matches")
})

test("turn counts are singular for one", () => {
  expect(turnCountLabel(1)).toBe("1 turn · read only")
  expect(turnCountLabel(6)).toBe("6 turns · read only")
})

describe("routes", () => {
  test("a search and an open conversation round-trip through the URL", () => {
    const route = { search: "roof tiles", conversation: "c 1", turn: "t&2" }
    expect(routeUrl(route)).toBe(
      "/ask?search=roof+tiles&conversation=c+1&turn=t%262"
    )
    expect(parseRoute(routeUrl(route).split("?")[1] ?? "")).toEqual(route)
  })
  test("no params is the question box", () => {
    expect(routeUrl({ search: null, conversation: null, turn: null })).toBe(
      "/ask"
    )
    expect(parseRoute("")).toEqual({
      search: null,
      conversation: null,
      turn: null,
    })
  })
  test("an empty search is still search mode and a turn needs a conversation", () => {
    expect(parseRoute("search=")).toEqual({
      search: "",
      conversation: null,
      turn: null,
    })
    expect(parseRoute("turn=t1").turn).toBeNull()
  })
})

describe("loadSearch", () => {
  test("asks core for the trimmed query, the kind and a limit of 20", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ hits: [turnHit, digestHit] }))
    )
    const loaded = await loadSearch("  roof ", "raw", signal)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/core/conversations/search?q=roof&limit=20&kind=raw"
    )
    expect(loaded).toEqual({ status: "ready", hits: [turnHit, digestHit] })
  })
  test("a non-ok response, a bad body and a network failure are errors", async () => {
    stubFetch(new Response("{}", { status: 500 }))
    expect(await loadSearch("roof", "any", signal)).toEqual({ status: "error" })
    stubFetch(new Response(JSON.stringify({ hits: [{ nope: 1 }] })))
    expect(await loadSearch("roof", "any", signal)).toEqual({ status: "error" })
    stubFetch(new TypeError("network"))
    expect(await loadSearch("roof", "any", signal)).toEqual({ status: "error" })
  })
})

describe("loadConversation", () => {
  test("fetches the encoded id and validates the body", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(conversation)))
    const loaded = await loadConversation("a/b", signal)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/core/conversations/a%2Fb")
    expect(loaded).toEqual({ status: "ready", value: conversation })
  })
  test("404 is gone; other failures are errors", async () => {
    stubFetch(new Response("{}", { status: 404 }))
    expect(await loadConversation("x", signal)).toEqual({ status: "gone" })
    stubFetch(new Response("{}", { status: 500 }))
    expect(await loadConversation("x", signal)).toEqual({ status: "error" })
    stubFetch(new Response(JSON.stringify({ id: 1 })))
    expect(await loadConversation("x", signal)).toEqual({ status: "error" })
    stubFetch(new TypeError("network"))
    expect(await loadConversation("x", signal)).toEqual({ status: "error" })
  })
})

describe("conversationDate", () => {
  test("is the first turn's date", () => {
    expect(conversationDate(conversation)).toBe("Oct 28, 2030")
  })
  test("is undefined with no turns or an unreadable date", () => {
    expect(conversationDate({ ...conversation, turns: [] })).toBeUndefined()
    const [first] = conversation.turns
    if (!first) throw new Error("fixture")
    expect(
      conversationDate({ ...conversation, turns: [{ ...first, at: "soon" }] })
    ).toBeUndefined()
  })
})
