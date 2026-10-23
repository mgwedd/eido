import { DatabaseSync } from "node:sqlite"
import type {
  InferenceRequest,
  InferenceResult,
  ModelClient,
} from "../inference/index"
import { createInferenceQueue } from "../inference/index"
import { createDigestService } from "./service"
import type { DigestServiceOptions } from "./service"
import type { DigestSubject, ThreadMessage } from "./types"

export interface RecordedCall {
  kind: "section" | "merge"
  system: string
  content: string
}

export interface FakeModelOptions {
  /** Added to every section reply: a line citing a reference that is not in the source. */
  inventRef?: string
  /** Replaces the reply text of every call. */
  rawText?: string
  finishReason?: "stop" | "length"
  /** Awaited before each reply; lets a test hold a call in flight. */
  gate?: (call: RecordedCall) => Promise<void>
  /** Merge calls return their input lines unchanged, so merging never shrinks. */
  echoMerge?: boolean
}

function refsOf(content: string): string[] {
  return [...content.matchAll(/^\[([^\]\n]+)\]/gm)].map((m) => m[1] ?? "")
}

function mergeLines(content: string): { text: string; refs: string[] }[] {
  return content.split("\n").map((line) => {
    const match = /^- (.*) \[([^\]]*)\]$/.exec(line)
    return { text: match?.[1] ?? "", refs: (match?.[2] ?? "").split(", ") }
  })
}

/** A scripted ModelClient: deterministic summaries built from the references in its input. */
export function fakeModel(options: FakeModelOptions = {}): {
  client: ModelClient
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const client: ModelClient = {
    async complete(req: InferenceRequest): Promise<InferenceResult> {
      const content = req.messages.map((m) => m.content).join("\n")
      const kind = req.system.startsWith("You merge") ? "merge" : "section"
      const call: RecordedCall = { kind, system: req.system, content }
      calls.push(call)
      await options.gate?.(call)
      let lines: { text: string; cites: string[] }[]
      if (kind === "section") {
        const refs = [...new Set(refsOf(content))]
        lines = [
          {
            text: `covers ${refs[0] ?? ""} to ${refs[refs.length - 1] ?? ""}`,
            cites: [refs[0] ?? "", refs[refs.length - 1] ?? ""],
          },
        ]
        if (options.inventRef !== undefined) {
          lines.push({ text: "invented", cites: [options.inventRef] })
          lines.push({
            text: "half invented",
            cites: [options.inventRef, refs[0] ?? ""],
          })
        }
      } else if (options.echoMerge === true) {
        lines = mergeLines(content).map((l) => ({
          text: l.text,
          cites: l.refs,
        }))
      } else {
        const all = mergeLines(content).flatMap((l) => l.refs)
        lines = [{ text: "merged", cites: [...new Set(all)] }]
      }
      return {
        text: options.rawText ?? JSON.stringify({ lines }),
        estimatedPromptTokens: 0,
        reportedPromptTokens: 0,
        truncationSuspected: false,
        finishReason: options.finishReason ?? "stop",
      }
    },
  }
  return { client, calls }
}

export function harness(
  model: ReturnType<typeof fakeModel>,
  overrides: Partial<DigestServiceOptions> = {}
) {
  const db = new DatabaseSync(":memory:")
  const queue = createInferenceQueue(model.client)
  const errors: unknown[] = []
  const service = createDigestService({
    db,
    queue,
    modelId: "test-model",
    onError: (error) => errors.push(error),
    ...overrides,
  })
  return { db, queue, service, errors }
}

export function syntheticThread(
  count: number,
  bodyOf: (i: number) => string = (i) =>
    `Message ${String(i)} about the synthetic roof repair, quote ${String(i)}.`
): DigestSubject {
  const messages: ThreadMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `m${String(i + 1)}`,
    body: bodyOf(i + 1),
  }))
  return { kind: "thread", threadId: "thread-1", messages }
}
