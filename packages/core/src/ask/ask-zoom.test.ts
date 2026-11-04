import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ingest, mail, sha } from "../context/context.test-support"
import type { Digest } from "../digest/types"
import { openIndex } from "../index/schema"
import { ask } from "./ask"
import { answerReply, planReply, scripted } from "./ask.test-support"
import type { Scripted } from "./ask.test-support"
import type { AskDeps } from "./types"

// Synthetic threads only; the model is a scripted stub server and the digest service a fake that
// returns the digest each test stores.

let db: DatabaseSync
let model: Scripted | undefined
beforeEach(() => {
  db = openIndex(":memory:")
})
afterEach(async () => {
  await model?.server.close()
  model = undefined
})

const flag = { injectionSuspected: false, reasons: [] }
const mid = (id: string): string => `<${id}@example.invalid>`

const FILLER = "Routine scheduling notes about the roof crew and the gutters. "
const DEPOSIT = "The deposit of 450 euro is due on Friday."

/** Three messages of one thread; the second holds the only sentence about the deposit. */
function thread(): string[] {
  const bodies = [
    `Kickoff.\n\n${FILLER.repeat(12)}`,
    `Follow up.\n\n${FILLER.repeat(12)}\n\n${DEPOSIT}\n\n${FILLER.repeat(12)}`,
    `Wrap up.\n\n${FILLER.repeat(12)}`,
  ]
  ingest(
    db,
    bodies.map((body, i) =>
      mail({
        id: `z-m${String(i)}`,
        date: new Date(Date.UTC(2030, 0, 1 + i)).toISOString(),
        body,
        messageId: mid(`z-m${String(i)}`),
        threadId: "z-thread",
      })
    )
  )
  return bodies
}

function storedDigest(text: string, ...ids: string[]): Digest {
  return {
    key: "k",
    lines: [{ text, cites: ids.map((i) => ({ messageId: mid(i), ...flag })) }],
    coverage: { sections: 1, linesKept: 1, linesDropped: 0, splitSegments: 0 },
  }
}

function deps(
  m: Scripted,
  digest: Digest | { status: "absent" },
  extra: Partial<AskDeps> = {}
): AskDeps {
  return {
    db,
    queue: m.queue,
    budgetTokens: 3000,
    now: () => new Date("2030-06-01T00:00:00Z"),
    digest: { getDigest: () => digest },
    ...extra,
  }
}

const PLAN = { terms: ["deposit"], wants: "summarize" }
const answerPrompt = (m: Scripted): string =>
  m.server
    .completions()[1]
    ?.turns.map((t) => t.content)
    .join("\n") ?? ""

describe("a broad question over a thread with a digest", () => {
  test("sends the digest line and the raw passage, and cites the passage's stored offsets", async () => {
    const bodies = thread()
    model = await scripted([
      planReply(PLAN),
      answerReply("The deposit is due on Friday [M1]."),
    ])
    const result = await ask(
      "Summarize the deposit discussion",
      deps(model, storedDigest("Crew scheduling was discussed", "z-m0", "z-m2"))
    )
    expect(result.status).toBe("answered")
    const prompt = answerPrompt(model)
    expect(prompt).toContain("Crew scheduling was discussed")
    expect(prompt).toContain(DEPOSIT)
    expect(prompt).toContain("digestLines: 1")
    expect(prompt).toContain("threadSectionsOmitted: 0")
    const start = (bodies[1] ?? "").indexOf(DEPOSIT)
    expect(result.citations).toHaveLength(1)
    expect(result.citations[0]).toMatchObject({
      tag: "M1",
      documentId: sha("z-m1"),
      excerpt: { passages: [{ start, end: start + DEPOSIT.length }] },
    })
    // A summary is context only: nothing but a raw passage carries a citable tag.
    expect(prompt).toContain("not quotable")
    expect(prompt).not.toContain("\n[M2] gmail")
  })

  test("an existence-style question puts raw passages ahead of a digest that says never", async () => {
    thread()
    model = await scripted([
      planReply(PLAN),
      answerReply("It was mentioned [M1]."),
    ])
    const never = "The deposit was never discussed in this thread"
    const result = await ask(
      "Was the deposit ever mentioned?",
      // Room for the passage but not for the passage and the line together.
      deps(model, storedDigest(never, "z-m0"), { budgetTokens: 1100 })
    )
    expect(result.status).toBe("answered")
    const prompt = answerPrompt(model)
    expect(prompt).toContain(DEPOSIT)
    expect(prompt).not.toContain(never)
    expect(result.citations[0]?.excerpt?.passages).toHaveLength(1)
  })

  test("without a stored digest the sections open with bounded raw text and the facts say no lines", async () => {
    thread()
    model = await scripted([
      planReply({ terms: ["roof"], wants: "summarize" }),
      answerReply("Notes on scheduling [M1]."),
    ])
    const result = await ask(
      "Summarize the roof thread",
      deps(model, { status: "absent" })
    )
    expect(result.status).toBe("answered")
    const prompt = answerPrompt(model)
    expect(prompt).toContain("digestLines: 0")
    expect(prompt).not.toContain("not quotable")
    expect(result.citations[0]?.excerpt).toBeDefined()
  })

  test("a request that cannot hold any section is refused before the answer call", async () => {
    thread()
    model = await scripted([planReply(PLAN)])
    const result = await ask(
      "Summarize the deposit discussion",
      deps(model, { status: "absent" }, { budgetTokens: 700 })
    )
    expect(result.status).toBe("refused")
    expect(model.completions()).toBe(1)
  })

  test("a lone message is read the usual way and the digest is not consulted", async () => {
    ingest(db, [
      mail({
        id: "solo",
        date: "2030-01-01T00:00:00Z",
        body: `Deposit note. ${DEPOSIT}`,
        threadId: "solo-thread",
      }),
    ])
    model = await scripted([planReply(PLAN), answerReply("Due Friday [M1].")])
    let consulted = false
    const result = await ask("Summarize the deposit discussion", {
      ...deps(model, { status: "absent" }),
      digest: {
        getDigest: () => {
          consulted = true
          return { status: "absent" }
        },
      },
    })
    expect(consulted).toBe(false)
    expect(result.citations[0]?.excerpt).toBeUndefined()
  })
})

describe("a broad question over a paged document", () => {
  const PAGE_FILLER = "Routine clauses about the maintenance schedule. "
  const CLAUSE = "The termination fee is 1200 euro after month six."
  const pages = [
    `Page one.\n\n${PAGE_FILLER.repeat(12)}`,
    `Page two.\n\n${PAGE_FILLER.repeat(12)}\n\n${CLAUSE}`,
    `Page three.\n\n${PAGE_FILLER.repeat(12)}`,
  ]
  const body = pages.join("\n")
  const docSha = sha("lease-pdf")

  function lease(pageTexts: string[] = pages): void {
    ingest(db, [
      {
        sha256: docSha,
        source: "gmail",
        sourceRef: "lease#0",
        mime: "application/pdf",
        title: "lease.pdf",
        body,
        pages: pageTexts.map((text, i) => ({ page: i + 1, text })),
      },
    ])
  }

  const pageDigest = (text: string, page: number): Digest => ({
    key: "k",
    lines: [{ text, cites: [{ docSha256: docSha, page, ...flag }] }],
    coverage: { sections: 1, linesKept: 1, linesDropped: 0, splitSegments: 0 },
  })

  test("sends the page digest line and the raw clause, citing offsets inside the stored body", async () => {
    lease()
    model = await scripted([
      planReply({ terms: ["termination"], wants: "summarize" }),
      answerReply("The fee is 1200 euro [M1]."),
    ])
    const result = await ask(
      "Summarize the termination terms",
      deps(model, pageDigest("Maintenance duties are listed", 1))
    )
    expect(result.status).toBe("answered")
    const prompt = answerPrompt(model)
    expect(prompt).toContain("Maintenance duties are listed")
    expect(prompt).toContain(CLAUSE)
    const start = body.indexOf(CLAUSE)
    expect(result.citations[0]).toMatchObject({ tag: "M1", documentId: docSha })
    // The first passage is the clause, as its exact range in the stored body.
    expect(result.citations[0]?.excerpt?.passages[0]).toEqual({
      start,
      end: start + CLAUSE.length,
    })
  })

  test("pages the body does not hold have no range, so the document is read the usual way", async () => {
    // Page text that is not in the body (a body edited after parsing) gets no stored range.
    lease(pages.map((_, i) => `unrelated page ${String(i + 1)}`))
    model = await scripted([
      planReply({ terms: ["termination"], wants: "summarize" }),
      answerReply("The fee is 1200 euro [M1]."),
    ])
    let consulted = false
    await ask("Summarize the termination terms", {
      ...deps(model, { status: "absent" }),
      digest: {
        getDigest: () => {
          consulted = true
          return { status: "absent" }
        },
      },
    })
    expect(consulted).toBe(false)
  })
})
