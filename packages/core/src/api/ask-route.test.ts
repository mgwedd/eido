import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ask } from "../ask/ask"
import type { Scripted } from "../ask/ask.test-support"
import {
  answerReply,
  ingestMatching,
  planReply,
  scripted,
} from "../ask/ask.test-support"
import type { AskResult } from "../ask/types"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import { createApiHandler } from "./handler"
import type { ApiHandler } from "./handler"

const RESULT: AskResult = {
  status: "no_match",
  answer: 'No match found for "x" in 0 indexed messages.',
  citations: [],
  coverage: {
    searched: 0,
    matched: 0,
    readInFull: 0,
    label: "read 0 of 0 matching messages in full",
  },
  facts: { matchCount: 0 },
  droppedTags: [],
  possiblyTruncated: false,
}

let db: DatabaseSync
let asked: string[]
let handle: ApiHandler

beforeEach(() => {
  db = openIndex(":memory:")
  asked = []
  handle = createApiHandler({
    profile: createProfileStore(db, { audit: () => Promise.resolve() }),
    allowedHosts: ["core.test"],
    ask: (question) => {
      asked.push(question)
      return Promise.resolve(RESULT)
    },
  })
})

function post(body: unknown, h: ApiHandler = handle): Promise<Response> {
  return h(
    new Request("http://core.test/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("POST /ask", () => {
  test.each([
    ["a missing question", {}],
    ["an empty question", { question: "" }],
    ["a blank question", { question: "   " }],
    ["a non-string question", { question: 42 }],
    ["a non-object body", ["question"]],
    ["an over-long question", { question: "é".repeat(2001) }],
  ])("returns 400 for %s, without calling ask", async (_, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    const json: unknown = await response.json()
    expect(json).toMatchObject({ error: { code: "bad_request" } })
    expect(asked).toEqual([])
  })

  test("accepts a question of exactly 2,000 characters", async () => {
    const response = await post({ question: "é".repeat(2000) })
    expect(response.status).toBe(200)
    expect(asked).toEqual(["é".repeat(2000)])
  })

  test("returns the result JSON for a valid question, trimmed", async () => {
    const response = await post({ question: "  When was the invoice paid? " })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.json()).toEqual(RESULT)
    expect(asked).toEqual(["When was the invoice paid?"])
  })

  test("answers only POST", async () => {
    const response = await handle(
      new Request("http://core.test/ask", { method: "GET" })
    )
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
  })

  test("is not served when no ask pipeline is configured", async () => {
    const bare = createApiHandler({
      profile: createProfileStore(db, { audit: () => Promise.resolve() }),
      allowedHosts: ["core.test"],
    })
    const response = await post({ question: "anything?" }, bare)
    expect(response.status).toBe(404)
  })

  test("a pipeline failure is a 500 that does not repeat the cause", async () => {
    const failing = createApiHandler({
      profile: createProfileStore(db, { audit: () => Promise.resolve() }),
      allowedHosts: ["core.test"],
      ask: () => Promise.reject(new Error("model at /var/eido/models failed")),
    })
    const response = await post({ question: "anything?" }, failing)
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain("/var/eido")
  })
})

describe("POST /ask over the real pipeline", () => {
  let dir: string
  let model: Scripted | undefined

  afterEach(async () => {
    await model?.server.close()
    model = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test("the body carries the answer and no file paths or server addresses", async () => {
    dir = mkdtempSync(join(tmpdir(), "eido-ask-"))
    const dbPath = join(dir, "eido-data.db")
    const fileDb = openIndex(dbPath)
    ingestMatching(fileDb, 2, "invoice")
    model = await scripted([
      planReply({ terms: ["invoice"], wants: "find" }),
      answerReply("Paid [M1]."),
    ])
    const queue = model.queue
    const h = createApiHandler({
      profile: createProfileStore(fileDb, { audit: () => Promise.resolve() }),
      allowedHosts: ["core.test"],
      ask: (question) =>
        ask(question, { db: fileDb, queue, budgetTokens: 3000 }),
    })
    const response = await post({ question: "When was the invoice paid?" }, h)
    expect(response.status).toBe(200)
    const text = await response.text()
    const result = JSON.parse(text) as AskResult
    expect(result.status).toBe("answered")
    expect(result.answer).toBe("Paid [M1].")
    expect(result.coverage.label).toBe("read 2 of 2 matching messages in full")
    expect(text).not.toContain(dir)
    expect(text).not.toContain(model.server.url)
    expect(text).not.toContain("127.0.0.1")
    fileDb.close()
  })
})
