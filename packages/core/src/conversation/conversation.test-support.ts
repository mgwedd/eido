import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { plainContent } from "../inference/fence"
import { createInferenceQueue } from "../inference/queue"
import type { InferenceQueue } from "../inference/queue"
import type {
  InferenceRequest,
  InferenceResult,
  ModelClient,
} from "../inference/types"
import { openConversationIndex } from "./search-index"
import { CONVERSATION_SCHEMA_SQL } from "./schema"
import { createConversationStore } from "./store"
import type { ConversationStore } from "./store"
import type { RawTurn, Turn } from "./types"

export interface StubModel {
  client: ModelClient
  queue: InferenceQueue
  /** Every request the model received, in order. */
  requests: InferenceRequest[]
}

/** A stub ModelClient: `answer` turns a request into the model's reply text. Never a real server. */
export function stubModel(
  answer: (req: InferenceRequest, call: number) => string,
  finishReason: InferenceResult["finishReason"] = "stop"
): StubModel {
  const requests: InferenceRequest[] = []
  const client: ModelClient = {
    complete(req) {
      requests.push(req)
      return Promise.resolve({
        text: answer(req, requests.length),
        estimatedPromptTokens: 0,
        reportedPromptTokens: 0,
        truncationSuspected: false,
        finishReason,
      })
    },
  }
  return { client, queue: createInferenceQueue(client), requests }
}

/** The first message's content as the model reads it, with every block's boundary "B". */
export function contentOf(req: InferenceRequest | undefined): string {
  const content = req?.messages[0]?.content
  return content === undefined ? "" : plainContent(content, "B")
}

/** A model that always summarizes as `summary`, leaving out every date and tag on purpose. */
export function summarizingModel(summary = "They talked it over."): StubModel {
  return stubModel(() => JSON.stringify({ summary }))
}

export function turn(n: number, text: string, over: Partial<Turn> = {}): Turn {
  return {
    id: `t${String(n)}`,
    role: n % 2 === 1 ? "user" : "assistant",
    text,
    at: `2025-10-${String(10 + n).padStart(2, "0")}T09:00:00Z`,
    sources: [],
    ...over,
  }
}

export function rawTurn(
  n: number,
  text: string,
  over: Partial<RawTurn> = {}
): RawTurn {
  return {
    id: `t${String(n)}`,
    role: n % 2 === 1 ? "user" : "assistant",
    text,
    at: `2025-10-${String(10 + n).padStart(2, "0")}T09:00:00Z`,
    sources: [],
    ...over,
  }
}

/** 3 characters per estimated token. */
export const words = (tokens: number): string => "x".repeat(tokens * 3)

export interface StoreFixture {
  db: DatabaseSync
  index: DatabaseSync
  store: ConversationStore
  clock: { now: Date }
  dir: string
  dbPath: string
  indexPath: string
  /** Reopen both files, as a restart does. */
  reopen(): StoreFixture
  cleanup(): void
}

/** A store over fresh files in a temp directory, with a clock the test moves. */
export function storeFixture(
  dir: string = mkdtempSync(join(tmpdir(), "eido-conversation-")),
  clock: { now: Date } = { now: new Date("2025-10-20T10:00:00Z") }
): StoreFixture {
  const dbPath = join(dir, "eido-data.db")
  const indexPath = join(dir, "conversation-index.db")
  const db = new DatabaseSync(dbPath)
  db.exec(CONVERSATION_SCHEMA_SQL)
  const index = openConversationIndex(indexPath)
  const store = createConversationStore({ db, index, now: () => clock.now })
  let closed = false
  const closeBoth = (): void => {
    if (closed) return
    closed = true
    db.close()
    index.close()
  }
  return {
    db,
    index,
    store,
    clock,
    dir,
    dbPath,
    indexPath,
    reopen() {
      closeBoth()
      return storeFixture(dir, clock)
    },
    cleanup() {
      closeBoth()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
