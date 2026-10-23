import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { estimateTokens } from "../inference/budget"
import { ESTIMATE_BOUNDARY, plainContent } from "../inference/fence"
import { openIndex } from "../index/schema"
import type { IndexedDocument } from "../index/ingest"
import { assembleContext } from "./assemble"
import type { ContextRefusal } from "./assemble"
import { COMPACTION_LEGEND, compactMessage } from "./compact"
import {
  attachment,
  generateThread,
  ingest,
  mail,
  sha,
} from "./context.test-support"
import type { ContextPack } from "./pack-store"
import { packParts, packText, readContextPack } from "./pack-store"
import type { ContextBudgets } from "./tools"

const BUDGETS: ContextBudgets = { ask: 3800, propose: 2000 }

let db: DatabaseSync
beforeEach(() => {
  db = openIndex(":memory:")
})

function isPack(result: ContextPack | ContextRefusal): result is ContextPack {
  return !("refused" in result)
}

async function pack(
  seed: string,
  budgetTokens = BUDGETS.ask
): Promise<ContextPack> {
  const result = await assembleContext(db, { seed, task: "ask", budgetTokens })
  if (!isPack(result)) throw new Error("expected a pack")
  return result
}

/** Rows in context_packs; 0 when the table has never been created. */
function packRows(): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'context_packs'")
    .get()
  if (table === undefined) return 0
  return Number(
    db.prepare("SELECT count(*) AS n FROM context_packs").get()?.["n"] ?? 0
  )
}

/** The text of each member block, keyed by tag, split on the tag lines. */
function memberBlocks(p: ContextPack): Map<string, string> {
  const text = packText(p)
  const blocks = new Map<string, string>()
  const starts = p.members.map((m) => text.indexOf(`\n\n${m.tag} `))
  p.members.forEach((m, i) => {
    const start = (starts[i] ?? -1) + 2
    const end = starts[i + 1] ?? text.length
    blocks.set(m.tag, text.slice(start, end))
  })
  return blocks
}

const docFor = (docs: IndexedDocument[], sha256: string): IndexedDocument => {
  const doc = docs.find((d) => d.sha256 === sha256)
  if (doc === undefined) throw new Error("member not in the thread")
  return doc
}

const addr = (d: IndexedDocument, role: string) =>
  (d.addresses ?? []).filter((a) => a.role === role).map((a) => a.address)

describe("assembleContext on a 200-message thread", () => {
  const thread = generateThread(200)
  const seedDoc = thread[150]
  if (seedDoc === undefined) throw new Error("thread too short")

  test("fits the ask budget, drops members and always includes the seed", async () => {
    ingest(db, thread)
    const p = await pack(seedDoc.sha256)
    expect(p.tokenCount).toBeLessThanOrEqual(BUDGETS.ask)
    expect(p.tokenCount).toBe(
      estimateTokens(plainContent(packParts(p), ESTIMATE_BOUNDARY))
    )
    expect(p.droppedMembers).toBe(200 - p.members.length)
    expect(p.droppedMembers).toBeGreaterThan(0)
    expect(p.members.map((m) => m.sha256)).toContain(seedDoc.sha256)
    expect(p.members.find((m) => m.sha256 === seedDoc.sha256)?.edge).toBe(
      "seed"
    )
  })

  test("prefers the direct reply chain, then the newest thread members", async () => {
    ingest(db, thread)
    const p = await pack(seedDoc.sha256)
    const included = new Set(p.members.map((m) => m.sha256))
    // The seed references its 10 predecessors and is replied to by m151: all reply edges.
    for (let i = 140; i <= 151; i++)
      expect(included.has(sha(`t-200-m${i}`))).toBe(true)
    const replies = p.members.filter((m) => m.edge === "reply").length
    expect(replies).toBeGreaterThanOrEqual(11)
    // The rest goes to the newest thread member that fits: m199 (three paragraphs) does not fit
    // the space left, so it is dropped whole and the smaller m198 is taken instead.
    const threadMembers = p.members.filter((m) => m.edge === "thread")
    expect(threadMembers.map((m) => m.sha256)).toEqual([sha("t-200-m198")])
    expect(included.has(sha("t-200-m199"))).toBe(false)
  })

  test("members are whole compacted messages, never truncated", async () => {
    ingest(db, thread)
    const p = await pack(seedDoc.sha256)
    expect(packText(p).startsWith(`${COMPACTION_LEGEND}\n\n[M1] `)).toBe(true)
    for (const [tag, block] of memberBlocks(p)) {
      const member = p.members.find((m) => m.tag === tag)
      const d = docFor(thread, member?.sha256 ?? "")
      const expected = compactMessage({
        from: addr(d, "from").join(", "),
        to: addr(d, "to"),
        date: d.occurredAt ?? "",
        subject: d.title ?? "",
        body: d.body,
      }).text
      expect(block).toBe(
        `${tag} gmail\n<material id="pack" source="mail">\n${expected}\n</material id="pack">`
      )
    }
  })

  test("members are in date order, tagged [M1]..[Mn] with their source, each in a fenced block", async () => {
    ingest(db, thread)
    const p = await pack(seedDoc.sha256)
    expect(p.members.map((m) => m.tag)).toEqual(
      p.members.map((_, i) => `[M${i + 1}]`)
    )
    const dates = p.members.map(
      (m) => docFor(thread, m.sha256).occurredAt ?? ""
    )
    expect(dates).toEqual([...dates].sort())
    for (const m of p.members)
      expect(packText(p)).toContain(
        `\n\n${m.tag} gmail\n<material id="pack" source="mail">\n`
      )
  })

  test("the same inputs give the same hash; the pack is stored once and round-trips", async () => {
    ingest(db, thread)
    const first = await pack(seedDoc.sha256)
    const second = await pack(seedDoc.sha256)
    expect(second.packHash).toBe(first.packHash)
    expect(first.packHash).toBe(
      createHash("sha256").update(packText(first)).digest("hex")
    )
    expect(packRows()).toBe(1)
    expect(readContextPack(db, first.id)).toEqual({
      id: first.id,
      members: first.members,
      tokenCount: first.tokenCount,
      packHash: first.packHash,
    })
  })
})

describe("assembleContext edges and refusal", () => {
  test("a seed larger than the budget is refused and nothing is stored", async () => {
    const big = mail({
      id: "big",
      date: "2030-01-01T00:00:00Z",
      body: "x".repeat(9000),
    })
    ingest(db, [big])
    const result = await assembleContext(db, {
      seed: big.sha256,
      task: "ask",
      budgetTokens: 1000,
    })
    expect(result).toEqual({
      refused: true,
      reason: "seed_too_large",
      seedTokens: expect.any(Number) as number,
      budgetTokens: 1000,
    })
    if (isPack(result)) throw new Error("expected a refusal")
    expect(result.seedTokens).toBeGreaterThan(3000)
    expect(packRows()).toBe(0)
  })

  test("the in_reply_to parent and an attachment of the seed are included", async () => {
    const parent = mail({
      id: "p",
      date: "2030-01-01T08:00:00Z",
      body: "Can you send the invoice?",
      from: "Bram Oster",
      to: ["Ada Quill"],
    })
    const seed = mail({
      id: "s",
      date: "2030-01-01T09:00:00Z",
      body: "Attached.",
      inReplyTo: "<p@example.invalid>",
    })
    const file = attachment("invoice", "s", "Invoice 7, total due on receipt.")
    const unrelated = mail({
      id: "u",
      date: "2030-01-01T10:00:00Z",
      body: "Other.",
    })
    ingest(db, [parent, seed, file, unrelated])
    const p = await pack(seed.sha256)
    expect(p.members.map((m) => [m.sha256, m.edge])).toEqual([
      [file.sha256, "attachment"],
      [parent.sha256, "reply"],
      [seed.sha256, "seed"],
    ])
    expect(packText(p)).toContain(
      '[M1] gmail\n<material id="pack" source="attachment">\ninvoice.txt | \nInvoice 7, total due on receipt.\n</material id="pack">'
    )
    expect(p.droppedMembers).toBe(0)
  })

  test("depth 2: a grandparent is reached through the parent; depth 3 is not", async () => {
    const chain = ["a", "b", "c", "d"].map((id, i) =>
      mail({
        id,
        date: `2030-01-0${i + 1}T00:00:00Z`,
        body: `Message ${id}.`,
        ...(i === 0
          ? {}
          : { inReplyTo: `<${["a", "b", "c"][i - 1]}@example.invalid>` }),
      })
    )
    ingest(db, chain)
    const p = await pack(sha("d"))
    expect(p.members.map((m) => m.sha256)).toEqual([
      sha("b"),
      sha("c"),
      sha("d"),
    ])
  })

  test("a member that does not fit is dropped whole while a later smaller one still fits", async () => {
    const seed = mail({
      id: "s",
      date: "2030-01-03T00:00:00Z",
      body: "Seed.",
      threadId: "t",
    })
    const large = mail({
      id: "large",
      date: "2030-01-02T00:00:00Z",
      body: "y".repeat(600),
      threadId: "t",
    })
    const small = mail({
      id: "small",
      date: "2030-01-01T00:00:00Z",
      body: "Small.",
      threadId: "t",
    })
    ingest(db, [seed, large, small])
    const p = await pack(seed.sha256, 260)
    expect(p.members.map((m) => [m.sha256, m.edge])).toEqual([
      [small.sha256, "thread"],
      [seed.sha256, "seed"],
    ])
    expect(p.droppedMembers).toBe(1)
    expect(packText(p)).not.toContain("yyy")
  })

  test("an attachment seed reaches its parent message", async () => {
    const parent = mail({
      id: "m",
      date: "2030-01-01T00:00:00Z",
      body: "See file.",
    })
    const file = attachment("notes", "m", "Notes.")
    ingest(db, [parent, file])
    const p = await pack(file.sha256)
    expect(p.members.map((m) => [m.sha256, m.edge])).toEqual([
      [file.sha256, "seed"],
      [parent.sha256, "attachment"],
    ])
  })

  test("members with the same date are ordered by sha256", async () => {
    const parent = mail({
      id: "m",
      date: "2030-01-01T00:00:00Z",
      body: "Two files.",
    })
    const files = [
      attachment("one", "m", "One."),
      attachment("two", "m", "Two."),
    ]
    ingest(db, [parent, ...files])
    const p = await pack(parent.sha256)
    expect(p.members.map((m) => m.sha256)).toEqual([
      ...files.map((f) => f.sha256).sort(),
      parent.sha256,
    ])
  })

  test("a references header that is not a list adds no edges", async () => {
    const seed = mail({ id: "s", date: "2030-01-02T00:00:00Z", body: "Seed." })
    const other = mail({
      id: "o",
      date: "2030-01-01T00:00:00Z",
      body: "Other.",
    })
    ingest(db, [seed, other])
    db.prepare(
      `INSERT INTO documents (sha256, source, source_ref, mime, ingested_at) VALUES (?, 'gmail', 'r', 'message/rfc822', 'x')`
    ).run(sha("r"))
    db.prepare(
      `INSERT INTO document_text (sha256, title, body, occurred_at, references_json, thread_id) VALUES (?, 'T', 'Odd.', '2030-01-03', '"<o@example.invalid>"', 'odd')`
    ).run(sha("r"))
    const p = await pack(sha("r"))
    expect(p.members.map((m) => m.sha256)).toEqual([sha("r")])
  })

  test("an unknown seed is rejected", async () => {
    await expect(
      assembleContext(db, {
        seed: sha("missing"),
        task: "ask",
        budgetTokens: 100,
      })
    ).rejects.toThrow("context seed is not in the index")
  })
})
