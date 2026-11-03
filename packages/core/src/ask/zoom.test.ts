import type { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, test } from "vitest"
import { ingest, mail, sha } from "../context/context.test-support"
import type { Digest, DigestLine } from "../digest/types"
import { openIndex } from "../index/schema"
import { citeSectionId, selectZoomContext, verifyPassage } from "./zoom"
import type { ZoomItem, ZoomSection } from "./zoom"

// Synthetic content only. Each case stores messages the way a connector does and selects from
// their stored bodies.

let db: DatabaseSync
beforeEach(() => {
  db = openIndex(":memory:")
})

const flag = { injectionSuspected: false, reasons: [] }
const line = (text: string, ...ids: string[]): DigestLine => ({
  text,
  cites: ids.map((messageId) => ({ messageId, ...flag })),
})
const digestOf = (...lines: DigestLine[]): Digest => ({
  key: "k",
  lines,
  coverage: {
    sections: 1,
    linesKept: lines.length,
    linesDropped: 0,
    splitSegments: 0,
  },
})
const terms = (...t: string[]): ReadonlySet<string> => new Set(t)

/** One message per entry, each its own section over its whole stored body. */
function store(bodies: Record<string, string>): ZoomSection[] {
  ingest(
    db,
    Object.entries(bodies).map(([id, body], i) =>
      mail({
        id,
        date: new Date(Date.UTC(2030, 0, 1 + i)).toISOString(),
        body,
      })
    )
  )
  return Object.entries(bodies).map(([id, body]) => ({
    id,
    sha256: sha(id),
    start: 0,
    end: body.length,
  }))
}

const kinds = (items: ZoomItem[], kind: ZoomItem["kind"]): ZoomItem[] =>
  items.filter((i) => i.kind === kind)

describe("ranking", () => {
  const corpus = (): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => {
        const hits = i % 4 // 0..3 occurrences of the term
        const body =
          `Section ${String(i)} routine notes.\n\n` +
          Array.from(
            { length: hits },
            () => "The invoice is outstanding."
          ).join("\n\n")
        return [`s${String(i).padStart(2, "0")}`, body]
      })
    )

  test("sections rank by raw hits, then digest term matches, then id", () => {
    const sections = store(corpus())
    const digest = digestOf(
      line("invoice discussed", "s05"), // 1 hit, digest mentions the term
      line("routine only", "s01") // 1 hit, digest does not
    )
    const result = selectZoomContext({
      db,
      sections,
      digest,
      terms: terms("invoice"),
      budgetTokens: 100_000,
    })
    const order = result.coverage.map((c) => c.sectionId)
    const hits = (id: string): number =>
      result.coverage.find((c) => c.sectionId === id)?.rawHits ?? -1
    // three-hit sections first, ids ascending: s03, s07, s11, ...
    expect(order.slice(0, 3)).toEqual(["s03", "s07", "s11"])
    expect(hits("s03")).toBe(3)
    // among one-hit sections the digest match wins, then ids ascend
    const oneHit = order.filter((id) => hits(id) === 1)
    expect(oneHit.slice(0, 3)).toEqual(["s05", "s01", "s09"])
    // zero-hit sections come last
    expect(hits(order[order.length - 1] ?? "")).toBe(0)
    expect(result.coverage.map((c) => c.rank)).toEqual(
      result.coverage.map((_, i) => i + 1)
    )
  })

  test("the order is the same whatever order the sections arrive in", () => {
    const sections = store(corpus())
    const run = (list: ZoomSection[]) =>
      selectZoomContext({
        db,
        sections: list,
        digest: undefined,
        terms: terms("invoice"),
        budgetTokens: 300,
      })
    const forward = run(sections)
    const reversed = run([...sections].reverse())
    expect(reversed.coverage).toEqual(forward.coverage)
    expect(reversed.items).toEqual(forward.items)
  })
})

describe("budget", () => {
  test("the selection fits the budget and lower-ranked sections are omitted with coverage", () => {
    const bodies = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `b${String(i).padStart(2, "0")}`,
        `Filler ${String(i)}.\n\n${"The invoice is outstanding. ".repeat(i + 1).trim()}`,
      ])
    )
    const sections = store(bodies)
    const result = selectZoomContext({
      db,
      sections,
      digest: undefined,
      terms: terms("invoice"),
      budgetTokens: 120,
    })
    expect(result.tokens).toBeLessThanOrEqual(120)
    expect(result.items.reduce((s, i) => s + i.tokens, 0)).toBe(result.tokens)
    const omitted = result.coverage.filter((c) => c.omitted === "budget")
    expect(omitted.length).toBeGreaterThan(0)
    // the most-hit section is the best ranked, and nothing omitted outranks something kept
    const worstKept = Math.max(
      ...result.coverage
        .filter((c) => c.omitted === undefined)
        .map((c) => c.rank)
    )
    expect(result.coverage[0]?.sectionId).toBe("b11")
    expect(result.coverage.length).toBe(12)
    expect(worstKept).toBeGreaterThanOrEqual(1)
    for (const c of omitted) {
      expect(
        kinds(result.items, "passage").some(
          (i) => "sectionId" in i && i.sectionId === c.sectionId
        )
      ).toBe(false)
    }
  })

  test("a passage larger than the room is omitted whole, never truncated", () => {
    const body = `${"The invoice is outstanding and long. ".repeat(40)}`
    const sections = store({ big: body })
    const result = selectZoomContext({
      db,
      sections,
      digest: undefined,
      terms: terms("invoice"),
      budgetTokens: 50,
    })
    expect(result.items).toEqual([])
    expect(result.coverage[0]?.omitted).toBe("budget")
  })

  test("summaries take at most their share before raw passages are placed", () => {
    const sections = store({
      a: "Intro.\n\nThe invoice is outstanding.",
      b: "Other note.",
    })
    const digest = digestOf(
      line(`summary ${"x".repeat(150)}`, "b"),
      line("short invoice summary", "a")
    )
    const result = selectZoomContext({
      db,
      sections,
      digest,
      terms: terms("invoice"),
      budgetTokens: 80,
      summaryShare: 0.25, // 20 tokens: the long line for b does not fit
    })
    expect(
      kinds(result.items, "summary").map((i) =>
        i.kind === "summary" ? i.text : ""
      )
    ).toEqual(["short invoice summary"])
    expect(kinds(result.items, "passage").length).toBe(1)
  })
})

describe("existence questions", () => {
  test("a digest that says never does not stand in for the raw search", () => {
    const sections = store({
      m1: "Hello.\n\nThe refund was approved on Friday.",
      m2: "Thanks.",
    })
    const digest = digestOf(line("The refund was never discussed.", "m2"))
    const result = selectZoomContext({
      db,
      sections,
      digest,
      terms: terms("refund"),
      budgetTokens: 100,
      existence: true,
    })
    expect(result.rawSearch).toEqual({
      searchedSections: 2,
      matchedSections: 1,
      hits: 1,
      noneFound: false,
    })
    const passage = result.items.find((i) => i.kind === "passage")
    expect(passage?.kind === "passage" && passage.text).toBe(
      "The refund was approved on Friday."
    )
  })

  test("raw passages are placed before summaries when the budget is tight", () => {
    const sections = store({ m1: "Intro.\n\nThe refund was approved." })
    const digest = digestOf(line("refund ".repeat(4).trim(), "m1"))
    const tight = (existence: boolean) =>
      selectZoomContext({
        db,
        sections,
        digest,
        terms: terms("refund"),
        budgetTokens: 15,
        summaryShare: 1,
        existence,
      })
    expect(tight(true).items.map((i) => i.kind)).toEqual(["passage"])
    expect(tight(false).items.map((i) => i.kind)).toEqual(["summary"])
  })

  test("none is confirmed only when every section was searched and none matched", () => {
    const sections = store({ m1: "Hello there.", m2: "Thanks again." })
    const searched = selectZoomContext({
      db,
      sections,
      digest: undefined,
      terms: terms("refund"),
      budgetTokens: 100,
      existence: true,
    })
    expect(searched.rawSearch.noneFound).toBe(true)
    const withGap = selectZoomContext({
      db,
      sections: [
        ...sections,
        { id: "gone", sha256: sha("never-stored"), start: 0, end: 10 },
      ],
      digest: undefined,
      terms: terms("refund"),
      budgetTokens: 100,
      existence: true,
    })
    expect(withGap.rawSearch.noneFound).toBe(false)
  })
})

describe("sections without a digest", () => {
  test("each contributes a bounded raw opening or is marked omitted", () => {
    const long = `${"Opening paragraph about scheduling. ".repeat(3).trim()}\n\n${"Later paragraph. ".repeat(80)}`
    const sections = store({
      n1: long,
      n2: "Short note about the gutter.",
      n3: long,
    })
    const result = selectZoomContext({
      db,
      sections,
      digest: digestOf(line("covers n2", "n2")),
      terms: terms("invoice"),
      budgetTokens: 60,
      openingChars: 200,
    })
    const openings = result.items.filter((i) => i.kind === "opening")
    for (const o of openings) {
      expect(o.kind === "opening" && o.text.length).toBeLessThanOrEqual(200)
    }
    const first = openings[0]
    expect(first?.kind === "opening" && first.text).toBe(
      "Opening paragraph about scheduling. Opening paragraph about scheduling. Opening paragraph about scheduling."
    )
    expect(result.coverage.map((c) => c.sectionId).sort()).toEqual([
      "n1",
      "n2",
      "n3",
    ])
    const n3 = result.coverage.find((c) => c.sectionId === "n3")
    expect(n3?.opening === false && n3.omitted).toBe("budget")
    expect(
      result.coverage.find((c) => c.sectionId === "n2")?.summaryPlaced
    ).toBe(true)
  })

  test("with no stored digest every section is an opening or omitted, and the digest is absent", () => {
    const sections = store({ p1: "First page text.", p2: "Second page text." })
    const result = selectZoomContext({
      db,
      sections,
      digest: undefined,
      terms: terms("zzz"),
      budgetTokens: 100,
    })
    expect(result.digest).toBe("absent")
    expect(result.items.map((i) => i.kind)).toEqual(["opening", "opening"])
    expect(result.coverage.every((c) => !c.hasSummary && c.opening)).toBe(true)
  })

  test("a section outside the stored body is reported, not dropped", () => {
    const result = selectZoomContext({
      db,
      sections: [{ id: "x", sha256: sha("absent"), start: 0, end: 5 }],
      digest: undefined,
      terms: terms("a"),
      budgetTokens: 100,
    })
    expect(result.coverage).toEqual([
      expect.objectContaining({
        sectionId: "x",
        omitted: "outside_stored_body",
      }),
    ])
  })
})

describe("citation provenance", () => {
  test("summaries cite section ids; raw passages carry offsets that index the stored body", () => {
    const body =
      "Cover page.\n\nQuote total is 500 euro.\n\nSecond page.\n\nQuote revised to 450 euro."
    ingest(db, [mail({ id: "doc", date: "2030-02-01T00:00:00Z", body })])
    const mid = body.indexOf("Second page.")
    const sections: ZoomSection[] = [
      { id: `${sha("doc")}#1`, sha256: sha("doc"), start: 0, end: mid - 2 },
      {
        id: `${sha("doc")}#2`,
        sha256: sha("doc"),
        start: mid,
        end: body.length,
      },
    ]
    const digest: Digest = digestOf({
      text: "Quote revised on page 2",
      cites: [{ docSha256: sha("doc"), page: 2, ...flag }],
    })
    const result = selectZoomContext({
      db,
      sections,
      digest,
      terms: terms("quote"),
      budgetTokens: 500,
    })
    const summary = result.items.find((i) => i.kind === "summary")
    expect(summary?.kind === "summary" && summary.cites).toEqual([
      { sectionId: `${sha("doc")}#2`, sha256: sha("doc") },
    ])
    expect(summary).not.toHaveProperty("start")
    const passages = result.items.flatMap((i) =>
      i.kind === "passage" ? [i] : []
    )
    expect(passages.map((p) => p.text).sort()).toEqual([
      "Quote revised to 450 euro.",
      "Quote total is 500 euro.",
    ])
    for (const p of passages) expect(body.slice(p.start, p.end)).toBe(p.text)
    const revised = passages.find((p) => p.text.includes("450"))
    expect(revised?.start).toBe(body.indexOf("Quote revised"))
    expect(revised?.sectionId).toBe(`${sha("doc")}#2`)
  })

  test("a digest line citing nothing in this source is not used", () => {
    const sections = store({ m1: "Plain note." })
    const result = selectZoomContext({
      db,
      sections,
      digest: digestOf(line("invented claim", "ghost")),
      terms: terms("zzz"),
      budgetTokens: 100,
    })
    expect(kinds(result.items, "summary")).toEqual([])
    expect(result.digest).toBe("absent")
  })

  test("verifyPassage rejects text that is not the stored slice", () => {
    store({ v1: "The invoice is outstanding." })
    expect(verifyPassage(db, sha("v1"), 4, 11, "invoice")).toBe(true)
    expect(verifyPassage(db, sha("v1"), 4, 11, "invoicE")).toBe(false)
    expect(verifyPassage(db, sha("v1"), 4, 999, "invoice")).toBe(false)
    expect(verifyPassage(db, sha("nope"), 0, 1, "T")).toBe(false)
  })

  test("citeSectionId names a message by id and a page by document and number", () => {
    expect(citeSectionId({ messageId: "m9", ...flag })).toBe("m9")
    expect(citeSectionId({ docSha256: "abc", page: 3, ...flag })).toBe("abc#3")
  })
})
