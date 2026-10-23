import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { estimateTokens } from "../inference/index"
import { readDigest } from "./cache"
import {
  digestKey,
  fingerprintDocument,
  fingerprintThread,
} from "./fingerprint"
import { fakeModel, harness, syntheticThread } from "./digest.test-support"
import type { RecordedCall } from "./digest.test-support"
import { DigestBuildError } from "./types"
import type { Digest, DigestSubject } from "./types"

const sha = (s: string): string => createHash("sha256").update(s).digest("hex")

function isDigest(value: Digest | { status: string }): value is Digest {
  return "lines" in value
}

describe("cache", () => {
  it("a second build for the same content makes zero model calls", async () => {
    const model = fakeModel()
    const { service } = harness(model)
    const thread = syntheticThread(3)

    service.scheduleDigest(thread)
    await service.whenIdle()
    const afterFirst = model.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    service.scheduleDigest(thread)
    await service.whenIdle()
    const hit = service.getDigest(thread)
    expect(model.calls.length).toBe(afterFirst)
    expect(isDigest(hit) && hit.lines[0]?.text).toBe("covers m1 to m3")
  })

  it("the key is the documented hash of prompt version, model id and raw thread fingerprint", () => {
    const { service } = harness(fakeModel(), { promptVersion: "pv" })
    const thread = syntheticThread(2)
    const expected = digestKey(
      "pv",
      "test-model",
      sha(
        `thread\0${JSON.stringify(
          [1, 2].map((n) => [
            `m${String(n)}`,
            sha(
              `Message ${String(n)} about the synthetic roof repair, quote ${String(n)}.`
            ),
          ])
        )}`
      )
    )
    expect(service.keyFor(thread)).toBe(expected)
  })

  it("a different prompt version or model id is a miss that schedules a rebuild", async () => {
    const model = fakeModel()
    const first = harness(model)
    const thread = syntheticThread(2)
    first.service.scheduleDigest(thread)
    await first.service.whenIdle()
    const calls = model.calls.length

    // Same database, same queue, different prompt version, then different model id.
    for (const other of [
      { promptVersion: "digest-v2" },
      { modelId: "other-model" },
    ]) {
      const { createDigestService } = await import("./service")
      const service = createDigestService({
        db: first.db,
        queue: first.queue,
        modelId: "test-model",
        ...other,
      })
      expect(service.getDigest(thread)).toEqual({ status: "absent" })
      service.scheduleDigest(thread)
      expect(service.getDigest(thread)).toEqual({ status: "pending" })
      await service.whenIdle()
      expect(isDigest(service.getDigest(thread))).toBe(true)
    }
    expect(model.calls.length).toBe(calls * 3)
  })

  it("one added message misses, rebuilds, and the old digest stays readable meanwhile", async () => {
    let release: () => void = () => undefined
    let hold = false
    const model = fakeModel({
      gate: async () => {
        if (hold) await new Promise<void>((r) => (release = r))
      },
    })
    const { service } = harness(model)
    const v1 = syntheticThread(2)
    service.scheduleDigest(v1)
    await service.whenIdle()
    const oldKey = service.keyFor(v1)

    const v2 = syntheticThread(3)
    expect(service.getDigest(v2)).toEqual({ status: "absent" })
    hold = true
    service.scheduleDigest(v2)
    await Promise.resolve()
    expect(service.getDigest(v2)).toEqual({ status: "pending" })
    const stale = service.getLatestDigest(v2)
    expect(stale?.key).toBe(oldKey)
    expect(stale?.current).toBe(false)

    hold = false
    release()
    await service.whenIdle()
    const fresh = service.getLatestDigest(v2)
    expect(fresh?.current).toBe(true)
    expect(fresh?.lines[0]?.text).toBe("covers m1 to m3")
    // The old digest is still stored under its own key.
    expect(isDigest(service.getDigest(v1))).toBe(true)
  })

  it("changing one raw body changes the key; the key follows raw text only", () => {
    const { service } = harness(fakeModel())
    const base = syntheticThread(3)
    if (base.kind !== "thread") throw new Error("thread expected")
    const edited: DigestSubject = {
      ...base,
      messages: base.messages.map((m, i) =>
        i === 1 ? { ...m, body: `${m.body} edited` } : m
      ),
    }
    // Reply links and the thread id are not content: only raw bodies and ids matter.
    const relinked: DigestSubject = {
      ...base,
      threadId: "renamed",
      messages: base.messages.map((m) => ({ ...m, inReplyTo: "m1" })),
    }
    expect(service.keyFor(edited)).not.toBe(service.keyFor(base))
    expect(service.keyFor(relinked)).toBe(service.keyFor(base))
  })

  it("a document key uses the content hash as its raw fingerprint", () => {
    const { service } = harness(fakeModel(), { promptVersion: "pv" })
    const doc: DigestSubject = {
      kind: "document",
      docSha256: sha("doc"),
      pages: [{ page: 1, text: "x" }],
    }
    expect(service.keyFor(doc)).toBe(
      digestKey("pv", "test-model", fingerprintDocument(sha("doc")))
    )
    expect(fingerprintThread([])).not.toBe(sha("doc"))
  })

  it("treats a stored row that no longer parses as a miss", async () => {
    const model = fakeModel()
    const { service, db } = harness(model)
    const thread = syntheticThread(2)
    service.scheduleDigest(thread)
    await service.whenIdle()
    const key = service.keyFor(thread)
    db.prepare("UPDATE digests SET lines_json = ? WHERE key = ?").run(
      '[{"text":"x","cites":[]}]',
      key
    )
    expect(readDigest(db, key)).toBeUndefined()
    expect(service.getDigest(thread)).toEqual({ status: "absent" })
    expect(service.getLatestDigest(thread)).toBeUndefined()
    db.prepare("UPDATE digests SET lines_json = ? WHERE key = ?").run(
      "not json",
      key
    )
    expect(readDigest(db, key)).toBeUndefined()
    db.prepare(
      "UPDATE digests SET lines_json = ?, coverage_json = ? WHERE key = ?"
    ).run("[]", "{}", key)
    expect(readDigest(db, key)).toBeUndefined()
    db.prepare(
      "UPDATE digests SET lines_json = ?, coverage_json = ? WHERE key = ?"
    ).run("{}", "x", key)
    expect(readDigest(db, key)).toBeUndefined()
    db.prepare("UPDATE digests SET lines_json = ? WHERE key = ?").run(
      '[{"text":"x","cites":[{"page":"1"}]}]',
      key
    )
    expect(readDigest(db, key)).toBeUndefined()
    db.prepare("UPDATE digests SET lines_json = ? WHERE key = ?").run(
      '["x"]',
      key
    )
    expect(readDigest(db, key)).toBeUndefined()
    db.prepare("UPDATE digests SET lines_json = ? WHERE key = ?").run("[]", key)
    db.prepare("UPDATE digests SET coverage_json = ? WHERE key = ?").run(
      "[1]",
      key
    )
    expect(readDigest(db, key)).toBeUndefined()
    db.prepare("UPDATE digests SET coverage_json = ? WHERE key = ?").run(
      "nope",
      key
    )
    expect(readDigest(db, key)).toBeUndefined()
  })
})

describe("getDigest", () => {
  it("never calls the model and reports pending while a build is queued", async () => {
    let release: () => void = () => undefined
    const model = fakeModel({
      gate: () => new Promise<void>((r) => (release = r)),
    })
    const { service } = harness(model)
    const thread = syntheticThread(2)

    expect(service.getDigest(thread)).toEqual({ status: "absent" })
    expect(model.calls.length).toBe(0)

    service.scheduleDigest(thread)
    await Promise.resolve()
    await Promise.resolve()
    expect(model.calls.length).toBe(1)
    expect(service.getDigest(thread)).toEqual({ status: "pending" })
    expect(service.getDigest(thread)).toEqual({ status: "pending" })
    // Reads made no call; the one in flight is the build's.
    expect(model.calls.length).toBe(1)

    release()
    await service.whenIdle()
    expect(isDigest(service.getDigest(thread))).toBe(true)
  })

  it("does not duplicate a pending build for the same key", async () => {
    const model = fakeModel()
    const { service } = harness(model)
    const thread = syntheticThread(2)
    service.scheduleDigest(thread)
    service.scheduleDigest(thread)
    await service.whenIdle()
    expect(model.calls.length).toBe(1)
  })
})

describe("citations", () => {
  it("drops lines that cite no real message, drops invented cites from kept lines, and counts them", async () => {
    const model = fakeModel({ inventRef: "ghost-id" })
    const { service } = harness(model)
    const thread = syntheticThread(3)
    service.scheduleDigest(thread)
    await service.whenIdle()
    const digest = service.getDigest(thread)
    if (!isDigest(digest)) throw new Error("digest expected")

    expect(digest.lines.map((l) => l.text)).toEqual([
      "covers m1 to m3",
      "half invented",
    ])
    expect(digest.lines[1]?.cites).toEqual([{ messageId: "m1" }])
    expect(digest.coverage.linesDropped).toBe(1)
    expect(digest.coverage.linesKept).toBe(2)
    const real = new Set(["m1", "m2", "m3"])
    for (const line of digest.lines) {
      expect(line.cites.length).toBeGreaterThanOrEqual(1)
      for (const cite of line.cites) {
        expect("messageId" in cite && real.has(cite.messageId)).toBe(true)
      }
    }
  })

  it("document lines cite docSha256 and a real page number", async () => {
    const model = fakeModel({ inventRef: "9" })
    const { service } = harness(model)
    const docSha256 = sha("synthetic pdf")
    const doc: DigestSubject = {
      kind: "document",
      docSha256,
      pages: [
        { page: 1, text: "Page one of a synthetic lease." },
        { page: 2, text: "Page two lists synthetic fees." },
        { page: 3, text: "Page three has synthetic signatures." },
      ],
    }
    service.scheduleDigest(doc)
    await service.whenIdle()
    const digest = service.getDigest(doc)
    if (!isDigest(digest)) throw new Error("digest expected")
    expect(digest.lines[0]?.cites).toEqual([
      { docSha256, page: 1 },
      { docSha256, page: 3 },
    ])
    // Page 9 does not exist in the document.
    expect(digest.lines.flatMap((l) => l.cites)).not.toContainEqual({
      docSha256,
      page: 9,
    })
    expect(digest.coverage.linesDropped).toBe(1)
    expect(model.calls[0]?.content).toContain(
      "[2]\nPage two lists synthetic fees."
    )
  })

  it("accepts a page given as a number", async () => {
    const model = fakeModel({
      rawText: JSON.stringify({
        lines: [{ text: "fees", cites: [2, "x", null] }],
      }),
    })
    const { service } = harness(model)
    const doc: DigestSubject = {
      kind: "document",
      docSha256: sha("d"),
      pages: [{ page: 2, text: "fees" }],
    }
    service.scheduleDigest(doc)
    await service.whenIdle()
    const digest = service.getDigest(doc)
    expect(isDigest(digest) && digest.lines[0]?.cites).toEqual([
      { docSha256: sha("d"), page: 2 },
    ])
  })
})

describe("sections", () => {
  const budget = 300
  const wide = 150

  it("builds a 200-message thread in sections within budget, with nothing truncated", async () => {
    const model = fakeModel()
    const { service } = harness(model, { config: { sectionTokens: wide } })
    const thread = syntheticThread(200)
    service.scheduleDigest(thread)
    await service.whenIdle()
    const digest = service.getDigest(thread)
    if (!isDigest(digest)) throw new Error("digest expected")

    const sections = model.calls.filter((c) => c.kind === "section")
    expect(sections.length).toBe(digest.coverage.sections)
    expect(sections.length).toBeGreaterThan(1)
    for (const call of model.calls) {
      expect(estimateTokens(call.content)).toBeLessThanOrEqual(wide)
    }
    if (thread.kind !== "thread") throw new Error("thread expected")
    const sent = sections.map((c) => c.content).join("\n\n")
    for (const message of thread.messages) {
      expect(sent).toContain(`[${message.id}]\n${message.body}`)
    }
    expect(digest.coverage.splitSegments).toBe(0)
    // The summaries do not fit one merge input at this budget, so merging ran in rounds.
    expect(
      model.calls.filter((c) => c.kind === "merge").length
    ).toBeGreaterThan(1)
    expect(digest.lines[0]?.cites.length).toBeGreaterThan(1)
  })

  it("splits an oversized message at paragraph boundaries, covers all of it, and marks coverage", async () => {
    const model = fakeModel()
    const { service } = harness(model, { config: { sectionTokens: budget } })
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) =>
        `Paragraph ${String(i)} of the long synthetic message. ${"filler ".repeat(25)}`
    )
    const thread = syntheticThread(3, (i) =>
      i === 2 ? paragraphs.join("\n\n") : `short ${String(i)}`
    )
    service.scheduleDigest(thread)
    await service.whenIdle()
    const digest = service.getDigest(thread)
    if (!isDigest(digest)) throw new Error("digest expected")
    expect(digest.coverage.splitSegments).toBe(1)
    const sent = model.calls
      .filter((c) => c.kind === "section")
      .map((c) => c.content)
      .join("\n\n")
    for (const p of paragraphs) expect(sent).toContain(p)
    expect(sent).toMatch(/\[m2\] \(part 1 of \d+\)/)
    for (const call of model.calls) {
      expect(estimateTokens(call.content)).toBeLessThanOrEqual(budget)
    }
  })

  it("splits one paragraph larger than the budget without losing a character", async () => {
    const model = fakeModel()
    const { service } = harness(model, { config: { sectionTokens: 100 } })
    const body = Array.from({ length: 400 }, (_, i) =>
      String.fromCharCode(97 + (i % 26))
    ).join("")
    const doc: DigestSubject = {
      kind: "document",
      docSha256: sha("big"),
      pages: [{ page: 1, text: body }],
    }
    service.scheduleDigest(doc)
    await service.whenIdle()
    const parts = model.calls
      .filter((c) => c.kind === "section")
      .map((c) => c.content.split("\n").slice(1).join("\n"))
    expect(parts.join("")).toBe(body)
    for (const call of model.calls) {
      expect(estimateTokens(call.content)).toBeLessThanOrEqual(100)
    }
  })

  it("keeps a reply with the message it answers when the pair fits", async () => {
    const model = fakeModel()
    const { service } = harness(model, { config: { sectionTokens: 60 } })
    const body = (n: number): string => `body ${String(n)} ${"w".repeat(30)}`
    const thread: DigestSubject = {
      kind: "thread",
      threadId: "t",
      messages: [
        { id: "a", body: body(1) },
        { id: "b", body: body(2), inReplyTo: "a" },
        { id: "c", body: body(3) },
        { id: "d", body: body(4), inReplyTo: "c" },
      ],
    }
    service.scheduleDigest(thread)
    await service.whenIdle()
    const sections = model.calls
      .filter((c) => c.kind === "section")
      .map((c) => c.content)
    const withB = sections.find((s) => s.includes("[b]")) ?? ""
    expect(withB).toContain("[a]")
    const withD = sections.find((s) => s.includes("[d]")) ?? ""
    expect(withD).toContain("[c]")
  })

  it("separates a pair that cannot share a section instead of exceeding the budget", async () => {
    const model = fakeModel()
    const { service } = harness(model, { config: { sectionTokens: 40 } })
    const thread: DigestSubject = {
      kind: "thread",
      threadId: "t",
      messages: [
        { id: "a", body: "x".repeat(60) },
        { id: "b", body: "y".repeat(60), inReplyTo: "a" },
      ],
    }
    service.scheduleDigest(thread)
    await service.whenIdle()
    const sections = model.calls.filter((c) => c.kind === "section")
    expect(sections.length).toBe(2)
    for (const call of model.calls) {
      expect(estimateTokens(call.content)).toBeLessThanOrEqual(40)
    }
  })

  it("a source with no content stores an empty digest without calling the model", async () => {
    const model = fakeModel()
    const { service } = harness(model)
    const empty: DigestSubject = { kind: "thread", threadId: "t", messages: [] }
    service.scheduleDigest(empty)
    await service.whenIdle()
    const digest = service.getDigest(empty)
    expect(model.calls.length).toBe(0)
    expect(isDigest(digest) && digest.coverage).toEqual({
      sections: 0,
      linesKept: 0,
      linesDropped: 0,
      splitSegments: 0,
    })
  })

  it("a single section needs no merge pass", async () => {
    const model = fakeModel()
    const { service } = harness(model)
    service.scheduleDigest(syntheticThread(2))
    await service.whenIdle()
    expect(model.calls.map((c) => c.kind)).toEqual(["section"])
  })

  it("rejects a budget too small for the source's references", async () => {
    const model = fakeModel()
    const { service, errors } = harness(model, { config: { sectionTokens: 5 } })
    service.scheduleDigest(syntheticThread(1, () => "long ".repeat(100)))
    await service.whenIdle()
    expect(errors[0]).toBeInstanceOf(DigestBuildError)
    expect(model.calls.length).toBe(0)
  })
})

describe("queue", () => {
  it("serves a foreground request enqueued during a build before the remaining section jobs", async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    let firstSeen = false
    const model = fakeModel({
      gate: async (call: RecordedCall) => {
        order.push(`section:${call.content.slice(0, 5)}`)
        if (!firstSeen) {
          firstSeen = true
          await new Promise<void>((r) => (releaseFirst = r))
        }
      },
    })
    const { service, queue } = harness(model, {
      config: { sectionTokens: 150 },
    })
    const thread = syntheticThread(30)
    service.scheduleDigest(thread)
    await Promise.resolve()
    await Promise.resolve()
    expect(order.length).toBe(1)

    const foreground = queue.run("foreground", () => {
      order.push("foreground")
      return Promise.resolve("asked")
    })
    releaseFirst()
    expect(await foreground).toBe("asked")
    await service.whenIdle()

    expect(order[1]).toBe("foreground")
    expect(order.length).toBeGreaterThan(3)
  })
})

describe("failures", () => {
  const cases: [string, Parameters<typeof fakeModel>[0], string][] = [
    ["a reply that is not JSON", { rawText: "no" }, "not JSON"],
    ["a reply without lines", { rawText: "{}" }, "no lines array"],
    [
      "a line without text",
      { rawText: '{"lines":[{"cites":["m1"]}]}' },
      "no text or cites",
    ],
    ["a reply cut by the token limit", { finishReason: "length" }, "cut short"],
  ]
  it.each(cases)(
    "%s stores nothing and reports the error",
    async (_name, options, message) => {
      const model = fakeModel(options)
      const { service, errors, db } = harness(model)
      const thread = syntheticThread(2)
      service.scheduleDigest(thread)
      await service.whenIdle()
      expect(String((errors[0] as Error).message)).toContain(message)
      expect(service.getDigest(thread)).toEqual({ status: "absent" })
      expect(db.prepare("SELECT count(*) AS n FROM digests").get()?.["n"]).toBe(
        0
      )
    }
  )

  it("gives up when merging never shrinks the summaries", async () => {
    const model = fakeModel({ echoMerge: true })
    const { service, errors } = harness(model, {
      config: { sectionTokens: 80 },
    })
    service.scheduleDigest(syntheticThread(60))
    await service.whenIdle()
    expect(String((errors[0] as Error).message)).toContain("did not converge")
  })

  it("rejects an invalid configuration", () => {
    expect(() =>
      harness(fakeModel(), { config: { sectionTokens: 0 } })
    ).toThrow(RangeError)
    expect(() =>
      harness(fakeModel(), { config: { replyTokens: 1.5 } })
    ).toThrow(RangeError)
  })

  it("applies its table once and keeps stored digests across service instances", async () => {
    const model = fakeModel()
    const first = harness(model)
    const thread = syntheticThread(2)
    first.service.scheduleDigest(thread)
    await first.service.whenIdle()
    const { createDigestService } = await import("./service")
    const second = createDigestService({
      db: first.db,
      queue: first.queue,
      modelId: "test-model",
    })
    expect(isDigest(second.getDigest(thread))).toBe(true)
  })
})
