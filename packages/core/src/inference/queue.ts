import type { ModelClient } from "./types"

// One local llama-server serves everything, so every caller of the model client goes through
// this queue: at most one job runs at a time, and foreground work (asks, approvals) is picked
// before background work (sync, extraction, digests). A running job is never aborted, so the
// longest a foreground job waits is the one job already running. The queue is in memory only;
// durable backlog state lives in the sync cursors.

export type Lane = "foreground" | "background"

export interface RunOptions {
  /** Aborting removes a still-queued job, which rejects with `AbortError`. A running job is not interrupted. */
  signal?: AbortSignal
}

/** How `runBatched` and `splitIntoBatches` bound each model input. */
export interface BatchPlan<I> {
  /** Estimated tokens for one item. Must be a finite number of at least 0. */
  tokensOf(item: I): number
  /** Upper bound for a batch's summed tokens; configuration supplies it, never above the client budget. */
  maxBatchTokens: number
  /** Optional cap on items per batch. */
  maxBatchItems?: number
}

export interface BatchedResult<I, O> {
  /** One entry per executed batch, in input order. */
  batches: { items: I[]; output: O }[]
  /** Items that alone exceed `maxBatchTokens`. Never truncated and never sent to the model. */
  oversize: I[]
}

export interface InferenceQueue {
  run<T>(
    lane: Lane,
    job: (client: ModelClient) => Promise<T>,
    opts?: RunOptions
  ): Promise<T>
  /** Background lane only: one job per batch, so foreground work runs between batches. */
  runBatched<I, O>(
    items: I[],
    plan: BatchPlan<I>,
    job: (batch: I[], client: ModelClient) => Promise<O>,
    opts?: RunOptions
  ): Promise<BatchedResult<I, O>>
  readonly pending: { foreground: number; background: number }
}

function abortError(): Error {
  const error = new Error("The inference job was aborted")
  error.name = "AbortError"
  return error
}

/**
 * Greedy, order-preserving split. A batch holds at most `maxBatchTokens` and `maxBatchItems`;
 * an item that alone exceeds `maxBatchTokens` goes to `oversize` instead of any batch.
 */
export function splitIntoBatches<I>(
  items: readonly I[],
  plan: BatchPlan<I>
): { batches: I[][]; oversize: I[] } {
  const { maxBatchTokens, maxBatchItems } = plan
  if (!Number.isFinite(maxBatchTokens) || maxBatchTokens <= 0) {
    throw new RangeError("maxBatchTokens must be a positive number")
  }
  if (
    maxBatchItems !== undefined &&
    (!Number.isInteger(maxBatchItems) || maxBatchItems < 1)
  ) {
    throw new RangeError("maxBatchItems must be an integer of at least 1")
  }

  const batches: I[][] = []
  const oversize: I[] = []
  let current: I[] = []
  let currentTokens = 0

  for (const item of items) {
    const tokens = plan.tokensOf(item)
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError("tokensOf must return a finite number of at least 0")
    }
    if (tokens > maxBatchTokens) {
      oversize.push(item)
      continue
    }
    const full =
      current.length > 0 &&
      (currentTokens + tokens > maxBatchTokens ||
        (maxBatchItems !== undefined && current.length >= maxBatchItems))
    if (full) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(item)
    currentTokens += tokens
  }
  if (current.length > 0) batches.push(current)
  return { batches, oversize }
}

interface Entry {
  start: () => Promise<void>
}

export function createInferenceQueue(client: ModelClient): InferenceQueue {
  const lanes: Record<Lane, Entry[]> = { foreground: [], background: [] }
  let running = false

  function next(): Entry | undefined {
    return lanes.foreground.shift() ?? lanes.background.shift()
  }

  function pump(): void {
    if (running) return
    const entry = next()
    if (entry === undefined) return
    running = true
    void entry.start().then(() => {
      running = false
      pump()
    })
  }

  function run<T>(
    lane: Lane,
    job: (client: ModelClient) => Promise<T>,
    opts?: RunOptions
  ): Promise<T> {
    const signal = opts?.signal
    if (signal?.aborted === true) return Promise.reject(abortError())

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        // The listener is removed when the job starts, so the entry is still queued here.
        lanes[lane].splice(lanes[lane].indexOf(entry), 1)
        reject(abortError())
      }
      const entry: Entry = {
        start: () => {
          signal?.removeEventListener("abort", onAbort)
          // Resolving with the job's promise passes its rejection through unchanged.
          const outcome = Promise.resolve().then(() => job(client))
          resolve(outcome)
          return outcome.then(
            () => undefined,
            () => undefined
          )
        },
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      lanes[lane].push(entry)
      pump()
    })
  }

  async function runBatched<I, O>(
    items: I[],
    plan: BatchPlan<I>,
    job: (batch: I[], client: ModelClient) => Promise<O>,
    opts?: RunOptions
  ): Promise<BatchedResult<I, O>> {
    const { batches, oversize } = splitIntoBatches(items, plan)

    // A failed or aborted run cancels its own batches that are still queued.
    const own = new AbortController()
    const outer = opts?.signal
    const relay = (): void => {
      own.abort()
    }
    if (outer?.aborted === true) own.abort()
    outer?.addEventListener("abort", relay, { once: true })

    let failure: { error: unknown } | undefined
    try {
      const done = await Promise.all(
        batches.map((batch) =>
          run(
            "background",
            async (c) => {
              try {
                return { items: batch, output: await job(batch, c) }
              } catch (error) {
                // Cancel the queued batches before the queue can start the next one. Their
                // AbortErrors reject first, so keep the real failure to report instead.
                failure ??= { error }
                own.abort()
                throw error
              }
            },
            { signal: own.signal }
          )
        )
      )
      return { batches: done, oversize }
    } catch (error) {
      throw failure === undefined ? error : failure.error
    } finally {
      outer?.removeEventListener("abort", relay)
    }
  }

  return {
    run,
    runBatched,
    get pending() {
      return {
        foreground: lanes.foreground.length,
        background: lanes.background.length,
      }
    },
  }
}
