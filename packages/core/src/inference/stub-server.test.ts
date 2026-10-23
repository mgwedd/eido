import { afterEach, describe, expect, test } from "vitest"
import { splitBytes, startStubModelServer, streamBody } from "./stub-server"
import type { StubModelServer } from "./stub-server"

let stub: StubModelServer | undefined

afterEach(async () => {
  await stub?.close()
  stub = undefined
})

async function rawChunks(response: Response): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("no body")
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

describe("streamBody", () => {
  test("streams deltas, the finish chunk, usage and [DONE]", () => {
    expect(streamBody({ deltas: ["a"], promptTokens: 5 })).toBe(
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n' +
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n' +
        "data: [DONE]\n\n"
    )
  })

  test("a null promptTokens leaves out the usage chunk", () => {
    expect(streamBody({ promptTokens: null })).not.toContain("usage")
  })
})

describe("splitBytes", () => {
  test("cuts after the first byte of each character's first occurrence", () => {
    const bytes = new TextEncoder().encode("a§b")
    // "§" is C2 A7: the cut falls between them.
    expect(splitBytes(bytes, ["§"]).map((piece) => [...piece])).toEqual([
      [0x61, 0xc2],
      [0xa7, 0x62],
    ])
  })

  test("a character that does not occur makes no cut", () => {
    expect(splitBytes(new TextEncoder().encode("ab"), ["—"])).toHaveLength(1)
  })
})

describe("startStubModelServer", () => {
  test("delivers a split multi-byte sequence as two separate chunks", async () => {
    stub = await startStubModelServer({
      replies: [{ deltas: ["x—y"], splitInside: ["—"] }],
    })
    const response = await fetch(`${stub.url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    const chunks = await rawChunks(response)
    // The em dash is E2 80 94; the first chunk ends on its lead byte, so decoding chunk by
    // chunk would corrupt it. This is what makes the client's round-trip test meaningful.
    expect(chunks[0]?.at(-1)).toBe(0xe2)
    expect(chunks[1]?.[0]).toBe(0x80)
  })

  test("serves /props and records every request", async () => {
    stub = await startStubModelServer({ contextTokens: 2048, replies: [] })
    const response = await fetch(`${stub.url}/props`)
    expect(await response.json()).toMatchObject({
      default_generation_settings: { n_ctx: 2048 },
    })
    expect(stub.requests).toEqual([{ method: "GET", path: "/props", body: "" }])
  })

  test("reports 4096 context tokens when the script gives none", async () => {
    stub = await startStubModelServer({ replies: [] })
    const response = await fetch(`${stub.url}/props`)
    expect(await response.json()).toMatchObject({
      default_generation_settings: { n_ctx: 4096 },
    })
  })

  test("answers 404 for other routes and for completions with no scripted reply", async () => {
    stub = await startStubModelServer({ replies: [] })
    const other = await fetch(`${stub.url}/health`)
    const completion = await fetch(`${stub.url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    })
    expect([other.status, completion.status]).toEqual([404, 404])
  })

  test("repeats the last reply once the script runs out", async () => {
    stub = await startStubModelServer({
      replies: [{ status: 500 }, { status: 502 }],
    })
    const statuses: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${stub.url}/v1/chat/completions`, {
        method: "POST",
        body: "{}",
      })
      statuses.push(response.status)
    }
    expect(statuses).toEqual([500, 502, 502])
  })
})
