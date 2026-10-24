import { describe, expect, it } from "vitest"

import { plainContent } from "./fence"
import { createInferenceQueue, splitIntoBatches } from "./queue"
import type { BatchPlan } from "./queue"
import type { InferenceRequest, InferenceResult, ModelClient } from "./types"

interface Call {
  label: string
  items: string[]
  resolve: () => void
  reject: (error: Error) => void
}

// A client whose calls resolve on demand, so ordering is deterministic with no timers.
function controllableClient() {
  const calls: Call[] = []
  const started: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const client: ModelClient = {
    complete(req: InferenceRequest): Promise<InferenceResult> {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const label = plainContent(req.messages[0]?.content ?? "")
      started.push(label)
      return new Promise<InferenceResult>((resolve, reject) => {
        calls.push({
          label,
          items: req.messages.map((m) => plainContent(m.content)),
          resolve: () => {
            inFlight -= 1
            resolve({
              text: label,
              estimatedPromptTokens: 0,
              reportedPromptTokens: 0,
              truncationSuspected: false,
              finishReason: "stop",
            })
          },
          reject: (error) => {
            inFlight -= 1
            reject(error)
          },
        })
      })
    },
  }
  return {
    client,
    started,
    calls,
    maxInFlight: () => maxInFlight,
    // Finish the oldest unfinished call, then let promise continuations run.
    async finish(): Promise<void> {
      calls.shift()?.resolve()
      await settle()
    },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function ask(client: ModelClient, label: string): Promise<string> {
  return client
    .complete({ system: "s", messages: [{ role: "user", content: label }] })
    .then((r) => r.text)
}

describe("scheduling", () => {
  it("runs a foreground job right after the running job, ahead of queued background jobs", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const done = [
      q.run("background", (c) => ask(c, "bg1")),
      q.run("background", (c) => ask(c, "bg2")),
      q.run("background", (c) => ask(c, "bg3")),
      q.run("background", (c) => ask(c, "bg4")),
    ]
    await settle()
    expect(stub.started).toEqual(["bg1"])
    done.push(q.run("foreground", (c) => ask(c, "fg")))
    await stub.finish()
    expect(stub.started).toEqual(["bg1", "fg"])
    await stub.finish()
    await stub.finish()
    await stub.finish()
    await stub.finish()
    expect(stub.started).toEqual(["bg1", "fg", "bg2", "bg3", "bg4"])
    await expect(Promise.all(done)).resolves.toEqual([
      "bg1",
      "bg2",
      "bg3",
      "bg4",
      "fg",
    ])
  })

  it("keeps submission order within each lane", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const all = [
      q.run("background", (c) => ask(c, "blocker")),
      q.run("background", (c) => ask(c, "bgA")),
      q.run("foreground", (c) => ask(c, "fgA")),
      q.run("background", (c) => ask(c, "bgB")),
      q.run("foreground", (c) => ask(c, "fgB")),
    ]
    await settle()
    for (let i = 0; i < 5; i++) await stub.finish()
    await Promise.all(all)
    expect(stub.started).toEqual(["blocker", "fgA", "fgB", "bgA", "bgB"])
  })

  it("never has more than one complete call in flight over a mixed workload", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const all: Promise<string>[] = []
    for (let i = 0; i < 6; i++) {
      all.push(
        q.run(i % 2 === 0 ? "background" : "foreground", (c) =>
          ask(c, `job${String(i)}`)
        )
      )
    }
    await settle()
    for (let i = 0; i < 6; i++) await stub.finish()
    await Promise.all(all)
    expect(stub.started).toHaveLength(6)
    expect(stub.maxInFlight()).toBe(1)
  })

  it("reports pending jobs per lane, not counting the running one", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    void q.run("background", (c) => ask(c, "running"))
    void q.run("background", (c) => ask(c, "b"))
    void q.run("foreground", (c) => ask(c, "f1"))
    void q.run("foreground", (c) => ask(c, "f2"))
    await settle()
    expect(q.pending).toEqual({ foreground: 2, background: 1 })
  })
})

describe("errors and abort", () => {
  it("rejects only the failing job and runs the next", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const boom = new Error("boom")
    const failing = q.run("foreground", async (c) => {
      await ask(c, "bad")
    })
    const after = q.run("foreground", (c) => ask(c, "good"))
    const failed = expect(failing).rejects.toBe(boom)
    await settle()
    stub.calls.shift()?.reject(boom)
    await failed
    await settle()
    await stub.finish()
    await expect(after).resolves.toBe("good")
  })

  it("rejects a job that throws synchronously and continues", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const failing = q.run("background", () => {
      throw new Error("sync")
    })
    const after = q.run("background", (c) => ask(c, "next"))
    await expect(failing).rejects.toThrow("sync")
    await settle()
    await stub.finish()
    await expect(after).resolves.toBe("next")
  })

  it("rejects a queued job with AbortError and it never reaches the model", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const controller = new AbortController()
    const first = q.run("background", (c) => ask(c, "first"))
    const doomed = q.run("background", (c) => ask(c, "doomed"), {
      signal: controller.signal,
    })
    const other = q.run("background", (c) => ask(c, "other"))
    await settle()
    controller.abort()
    await expect(doomed).rejects.toMatchObject({ name: "AbortError" })
    expect(q.pending.background).toBe(1)
    await stub.finish()
    await stub.finish()
    await Promise.all([first, other])
    expect(stub.started).toEqual(["first", "other"])
  })

  it("rejects at once when the signal is already aborted", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const controller = new AbortController()
    controller.abort()
    await expect(
      q.run("foreground", (c) => ask(c, "x"), { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(stub.started).toEqual([])
  })

  it("does not interrupt a running job when its signal aborts later", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const controller = new AbortController()
    const running = q.run("foreground", (c) => ask(c, "run"), {
      signal: controller.signal,
    })
    await settle()
    controller.abort()
    await stub.finish()
    await expect(running).resolves.toBe("run")
  })

  it("passes a client error such as PromptTooLargeError through unchanged", async () => {
    const { PromptTooLargeError } = await import("./errors")
    const tooLarge = new PromptTooLargeError(10, 20, 15)
    const q = createInferenceQueue({
      complete: () => Promise.reject(tooLarge),
    })
    await expect(
      q.run("foreground", (c) => c.complete({ system: "s", messages: [] }))
    ).rejects.toBe(tooLarge)
  })
})

const wordPlan = (
  extra: Partial<BatchPlan<string>> = {}
): BatchPlan<string> => ({
  tokensOf: (s) => s.length,
  maxBatchTokens: 10,
  ...extra,
})

describe("splitIntoBatches", () => {
  it("packs in order and starts a new batch when the next item would overflow", () => {
    const { batches, oversize } = splitIntoBatches(
      ["aaaa", "bbbb", "cc", "dddddd", "e"],
      wordPlan()
    )
    expect(batches).toEqual([
      ["aaaa", "bbbb", "cc"],
      ["dddddd", "e"],
    ])
    expect(oversize).toEqual([])
  })

  it("allows a batch to reach exactly maxBatchTokens", () => {
    expect(splitIntoBatches(["aaaaa", "bbbbb"], wordPlan()).batches).toEqual([
      ["aaaaa", "bbbbb"],
    ])
  })

  it("splits oversize items out without disturbing the neighbours' order", () => {
    const { batches, oversize } = splitIntoBatches(
      ["aaa", "x".repeat(11), "bbb"],
      wordPlan()
    )
    expect(oversize).toEqual(["x".repeat(11)])
    expect(batches).toEqual([["aaa", "bbb"]])
  })

  it("honours maxBatchItems", () => {
    const { batches } = splitIntoBatches(
      ["a", "b", "c", "d", "e"],
      wordPlan({ maxBatchItems: 2 })
    )
    expect(batches).toEqual([["a", "b"], ["c", "d"], ["e"]])
  })

  it("returns nothing for no items", () => {
    expect(splitIntoBatches([], wordPlan())).toEqual({
      batches: [],
      oversize: [],
    })
  })

  it("rejects invalid plans and token counts", () => {
    expect(() =>
      splitIntoBatches(["a"], wordPlan({ maxBatchTokens: 0 }))
    ).toThrow(RangeError)
    expect(() =>
      splitIntoBatches(["a"], wordPlan({ maxBatchTokens: Infinity }))
    ).toThrow(RangeError)
    expect(() =>
      splitIntoBatches(["a"], wordPlan({ maxBatchItems: 0 }))
    ).toThrow(RangeError)
    expect(() =>
      splitIntoBatches(["a"], wordPlan({ maxBatchItems: 1.5 }))
    ).toThrow(RangeError)
    expect(() =>
      splitIntoBatches(["a"], wordPlan({ tokensOf: () => -1 }))
    ).toThrow(RangeError)
    expect(() =>
      splitIntoBatches(["a"], wordPlan({ tokensOf: () => NaN }))
    ).toThrow(RangeError)
  })
})

describe("runBatched", () => {
  const batchJob = (c: ModelClient, batch: string[]) =>
    c
      .complete({
        system: "s",
        messages: batch.map((content) => ({ role: "user", content })),
      })
      .then(() => batch.length)

  it("splits 500 items into in-order batches under the cap and never sends them all at once", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const items = Array.from({ length: 500 }, (_, i) => `item-${String(i)}`)
    const plan: BatchPlan<string> = {
      tokensOf: (s) => s.length,
      maxBatchTokens: 100,
    }
    let finished = false
    const result = q
      .runBatched(items, plan, (batch, c) => batchJob(c, batch))
      .finally(() => {
        finished = true
      })
    while (!finished) {
      await settle()
      await stub.finish()
    }
    const { batches, oversize } = await result
    expect(oversize).toEqual([])
    for (const b of batches) {
      expect(b.items.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(100)
    }
    expect(batches.flatMap((b) => b.items)).toEqual(items)
    expect(batches.map((b) => b.output)).toEqual(
      batches.map((b) => b.items.length)
    )
    expect(batches.length).toBeGreaterThan(1)
    expect(stub.maxInFlight()).toBe(1)
  })

  it("serves a foreground job between two batches and processes every item exactly once", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const items = ["aaaaaa", "bbbbbb", "cccccc", "dddddd"]
    const batched = q.runBatched(
      items,
      wordPlan({ maxBatchTokens: 12 }),
      (batch, c) => batchJob(c, batch)
    )
    await settle()
    expect(stub.started).toEqual(["aaaaaa"])
    const fg = q.run("foreground", (c) => ask(c, "fg"))
    await stub.finish()
    expect(stub.started).toEqual(["aaaaaa", "fg"])
    await stub.finish()
    await stub.finish()
    await Promise.all([fg, batched])
    expect(stub.started).toEqual(["aaaaaa", "fg", "cccccc"])
    const result = await batched
    expect(result.batches.flatMap((b) => b.items)).toEqual(items)
  })

  it("returns oversize items and does not send them", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const big = "x".repeat(11)
    const result = q.runBatched(["aaa", big, "bbb"], wordPlan(), (batch, c) =>
      batchJob(c, batch)
    )
    await settle()
    await stub.finish()
    const { batches, oversize } = await result
    expect(oversize).toEqual([big])
    expect(batches.flatMap((b) => b.items)).toEqual(["aaa", "bbb"])
    expect(stub.calls.flatMap((c) => c.items)).not.toContain(big)
    expect(stub.started).toEqual(["aaa"])
  })

  it("rejects with the first failure and cancels its still-queued batches", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const boom = new Error("batch failed")
    const result = q.runBatched(
      ["aaaaaa", "bbbbbb", "cccccc"],
      wordPlan({ maxBatchTokens: 6 }),
      (batch, c) => batchJob(c, batch)
    )
    const rejected = expect(result).rejects.toBe(boom)
    await settle()
    stub.calls.shift()?.reject(boom)
    await rejected
    await settle()
    expect(stub.started).toEqual(["aaaaaa"])
    expect(q.pending.background).toBe(0)
  })

  it("rejects with AbortError and drops queued batches when the signal aborts", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const controller = new AbortController()
    const result = q.runBatched(
      ["aaaaaa", "bbbbbb", "cccccc"],
      wordPlan({ maxBatchTokens: 6 }),
      (batch, c) => batchJob(c, batch),
      { signal: controller.signal }
    )
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    })
    await settle()
    controller.abort()
    await rejected
    await stub.finish()
    expect(stub.started).toEqual(["aaaaaa"])
  })

  it("rejects at once when the signal is already aborted", async () => {
    const stub = controllableClient()
    const q = createInferenceQueue(stub.client)
    const controller = new AbortController()
    controller.abort()
    await expect(
      q.runBatched(["a"], wordPlan(), (batch, c) => batchJob(c, batch), {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(stub.started).toEqual([])
  })

  it("resolves empty for no items", async () => {
    const q = createInferenceQueue(controllableClient().client)
    await expect(
      q.runBatched([], wordPlan(), () => Promise.resolve(0))
    ).resolves.toEqual({ batches: [], oversize: [] })
  })
})
