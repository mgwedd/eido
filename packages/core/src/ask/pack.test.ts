import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { assembleContext } from "../context/assemble"
import {
  generateThread,
  ingest,
  mail,
  sha,
} from "../context/context.test-support"
import { packText, readContextPack } from "../context/pack-store"
import type { ContextPack } from "../context/pack-store"
import type { ContextRefusal } from "../context/assemble"
import { openIndex } from "../index/schema"
import { buildAskPack } from "./pack"

let db: DatabaseSync
beforeEach(() => {
  db = openIndex(":memory:")
  ingest(db, [
    ...generateThread(3, "t-1"),
    mail({ id: "solo-a", date: "2031-01-01T00:00:00Z", body: "Alpha note." }),
    mail({ id: "solo-b", date: "2031-01-02T00:00:00Z", body: "Beta note." }),
  ])
})

function expectPack(result: ContextPack | ContextRefusal): ContextPack {
  if ("refused" in result) throw new Error("expected a pack")
  return result
}

const THREAD = ["t-1-m2", "t-1-m1", "t-1-m0"].map(sha)

describe("buildAskPack", () => {
  const focusOn = (...terms: string[]) => ({
    terms: new Set(terms),
    searchScores: new Map<string, number>(),
  })

  test("focused packs send only the matching passages of a long document, with their offsets", async () => {
    const passage = "Invoice paid Friday. Invoice confirmed by finance."
    const body = [
      "Background material. ".repeat(90),
      passage,
      "Archive material. ".repeat(90),
    ].join("\n\n")
    ingest(db, [
      mail({ id: "long-invoice", date: "2031-02-01T00:00:00Z", body }),
    ])
    const build = async () =>
      expectPack(
        await buildAskPack(db, {
          hits: [sha("long-invoice")],
          budgetTokens: 500,
          focus: focusOn("invoice"),
        })
      )
    const first = await build()
    const start = body.indexOf(passage)
    expect(packText(first)).toContain(passage)
    expect(packText(first)).not.toContain("Background material.")
    expect(packText(first)).not.toContain("Archive material.")
    expect(first.members).toMatchObject([
      {
        tag: "[M1]",
        sha256: sha("long-invoice"),
        edge: "seed",
        excerpt: {
          passages: [{ start, end: start + passage.length }],
          omittedChars: body.length - passage.length,
        },
      },
    ])
    const second = await build()
    expect(second.packHash).toBe(first.packHash)
    expect(readContextPack(db, first.id)?.members).toEqual(first.members)
  })

  test("a short document is sent whole, without an excerpt", async () => {
    const pack = expectPack(
      await buildAskPack(db, {
        hits: [sha("solo-a")],
        budgetTokens: 500,
        focus: focusOn("alpha"),
      })
    )
    expect(pack.members).toMatchObject([
      { tag: "[M1]", sha256: sha("solo-a"), edge: "seed" },
    ])
    expect(pack.members[0]?.excerpt).toBeUndefined()
    expect(packText(pack)).toContain("Alpha note.")
  })

  test("a higher-ranked passage wins regardless of hit order, and ties break on stable keys", async () => {
    const filler = (word: string) => `${word} `.repeat(120)
    ingest(db, [
      mail({
        id: "low-passage",
        date: "2031-02-02T00:00:00Z",
        body: `${filler("Archive.")}\n\nInvoice paid.\n\n${filler("Old.")}`,
      }),
      mail({
        id: "high-passage",
        date: "2031-02-01T00:00:00Z",
        body: `${filler("Archive.")}\n\nInvoice invoice invoice paid.\n\n${filler("Old.")}`,
      }),
    ])
    const build = async (hits: string[], budgetTokens: number) =>
      expectPack(
        await buildAskPack(db, {
          hits,
          budgetTokens,
          focus: focusOn("invoice"),
        })
      )
    const forward = [sha("low-passage"), sha("high-passage")]
    const roomy = await build(forward, 500)
    expect(roomy.members.map((m) => m.sha256)).toEqual([
      sha("high-passage"),
      sha("low-passage"),
    ])
    expect((await build([...forward].reverse(), 500)).members).toEqual(
      roomy.members
    )
    // Room for one passage only: the higher-ranked one, even when the lower-ranked hit is first
    // and newer.
    const tight = roomy.tokenCount - 5
    const one = await build(forward, tight)
    expect(one.members.map((m) => m.sha256)).toEqual([sha("high-passage")])
    expect(one.droppedMembers).toBe(1)
    expect(one.tokenCount).toBeLessThanOrEqual(tight)
  })

  test("a focused pack whose best unit does not fit refuses", async () => {
    const result = await buildAskPack(db, {
      hits: [sha("solo-a")],
      budgetTokens: 5,
      focus: focusOn("alpha"),
    })
    expect(result).toMatchObject({
      refused: true,
      reason: "seed_too_large",
      budgetTokens: 5,
    })
  })

  test("seeds on the top hit with its thread, then appends hits not yet included", async () => {
    const pack = expectPack(
      await buildAskPack(db, {
        hits: [sha("t-1-m2"), sha("t-1-m0"), sha("solo-a"), sha("solo-b")],
        budgetTokens: 5000,
      })
    )
    expect(pack.members.map((m) => [m.tag, m.sha256])).toEqual([
      ["[M1]", sha("t-1-m0")],
      ["[M2]", sha("t-1-m1")],
      ["[M3]", sha("t-1-m2")],
      ["[M4]", sha("solo-a")],
      ["[M5]", sha("solo-b")],
    ])
    const text = packText(pack)
    expect(text).toContain(
      '\n\n[M4] gmail\n<material id="pack" source="mail">\n'
    )
    expect(text).toContain(
      '\n\n[M5] gmail\n<material id="pack" source="mail">\n'
    )
    expect(text.indexOf("Alpha note.")).toBeGreaterThan(
      text.indexOf("[M4] gmail")
    )
    expect(text.indexOf("Beta note.")).toBeGreaterThan(
      text.indexOf("[M5] gmail")
    )
    expect(text.split("[M1] gmail").length).toBe(2)
    expect(readContextPack(db, pack.id)?.members).toEqual(pack.members)
  })

  test("a hit whose block does not fit is skipped and a later one that fits is kept", async () => {
    ingest(db, [
      mail({
        id: "solo-big",
        date: "2031-01-03T00:00:00Z",
        body: "Gamma note. ".repeat(300),
      }),
    ])
    const base = expectPack(
      await assembleContext(db, {
        seed: sha("t-1-m2"),
        task: "ask",
        budgetTokens: 5000,
      })
    )
    const pack = expectPack(
      await buildAskPack(db, {
        hits: [sha("t-1-m2"), sha("solo-big"), sha("solo-a")],
        budgetTokens: base.tokenCount + 100,
      })
    )
    expect(pack.members.map((m) => m.sha256)).toEqual([
      ...[...THREAD].reverse(),
      sha("solo-a"),
    ])
    expect(packText(pack)).not.toContain("Gamma note.")
    expect(pack.tokenCount).toBeLessThanOrEqual(base.tokenCount + 100)
  })

  test("with nothing to add, the pack is the seed's own pack", async () => {
    const base = expectPack(
      await assembleContext(db, {
        seed: sha("t-1-m2"),
        task: "ask",
        budgetTokens: 5000,
      })
    )
    const pack = expectPack(
      await buildAskPack(db, {
        hits: [sha("t-1-m2"), sha("t-1-m1")],
        budgetTokens: 5000,
      })
    )
    expect(pack).toEqual(base)
  })

  test("an oversize seed returns the context refusal", async () => {
    const result = await buildAskPack(db, {
      hits: [sha("solo-a")],
      budgetTokens: 5,
    })
    expect(result).toMatchObject({
      refused: true,
      reason: "seed_too_large",
      budgetTokens: 5,
    })
  })

  test("needs at least one hit", async () => {
    await expect(
      buildAskPack(db, { hits: [], budgetTokens: 100 })
    ).rejects.toThrow("an ask pack needs at least one hit")
  })
})
