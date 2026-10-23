// Test support for the ask pipeline: a scripted stub model server behind a real client and queue,
// and synthetic mail (invented names, example.invalid addresses).
import type { DatabaseSync } from "node:sqlite"
import { ingest, mail } from "../context/context.test-support"
import { createModelClient } from "../inference/client"
import { createInferenceQueue } from "../inference/queue"
import type { InferenceQueue } from "../inference/queue"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer, StubReply } from "../inference/stub-server"
import type { ModelServerConfig } from "../inference/types"

/** A reported prompt size well above any estimate, so the tripwire stays quiet. */
export const FULL_PROMPT = 1_000_000

export function planReply(plan: unknown): StubReply {
  return { deltas: [JSON.stringify(plan)], promptTokens: FULL_PROMPT }
}

export function answerReply(
  text: string,
  promptTokens = FULL_PROMPT
): StubReply {
  return { deltas: [text], promptTokens }
}

export interface Scripted {
  server: StubModelServer
  queue: InferenceQueue
  /** Chat completion requests the server received. */
  completions(): number
}

export async function scripted(
  replies: StubReply[],
  config: Partial<ModelServerConfig> = {}
): Promise<Scripted> {
  const server = await startStubModelServer({ replies })
  const client = createModelClient({
    baseUrl: server.url,
    contextTokens: 100_000,
    maxReplyTokens: 256,
    tripwireMinPromptTokens: 10,
    ...config,
  })
  return {
    server,
    queue: createInferenceQueue(client),
    completions: () =>
      server.requests.filter((r) => r.path === "/v1/chat/completions").length,
  }
}

/**
 * `count` unthreaded messages whose body mentions `term`, one day apart from 2030-01-01, with ids
 * `${prefix}-0` (oldest) up to `${prefix}-${count - 1}` (newest). Equal bodies rank equally, so
 * search returns them newest first.
 */
export function ingestMatching(
  db: DatabaseSync,
  count: number,
  term: string,
  prefix = "m"
): void {
  ingest(
    db,
    Array.from({ length: count }, (_, i) =>
      mail({
        id: `${prefix}-${String(i)}`,
        date: new Date(Date.UTC(2030, 0, 1 + i)).toISOString(),
        subject: `Note ${String(i)}`,
        body: `The ${term} is attached.`,
      })
    )
  )
}
