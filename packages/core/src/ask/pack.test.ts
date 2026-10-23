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
    expect(text).toContain('\n\n[M4] gmail\n<material id="pack" source="mail">\n')
    expect(text).toContain('\n\n[M5] gmail\n<material id="pack" source="mail">\n')
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
