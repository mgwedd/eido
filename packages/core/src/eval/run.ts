import { createHash } from "node:crypto"
import { validateIntentResult } from "@eido/schemas"
import { validateIntent } from "@eido/schemas"
import type { Intent } from "@eido/schemas"
import { openDataDb } from "../ledger/db"
import { ingestBatch } from "../index/ingest"
import { createInferenceQueue } from "../inference/queue"
import type { ModelClient } from "../inference/types"
import { proposeIntents } from "../propose/propose"
import { createProposalLimiter } from "../propose/limiter"
import { caseDiff, scores } from "./score"
import type { EvalCase, EvalOptions, EvalReport, EvalVerdict } from "./types"

const SEED = 329
const EMPTY_RESULT = {
  estimatedPromptTokens: 1,
  reportedPromptTokens: 1,
  truncationSuspected: false,
  finishReason: "stop" as const,
}

function seedCase(testCase: EvalCase): {
  db: ReturnType<typeof openDataDb>
  seed: string
} {
  const db = openDataDb(":memory:")
  db.prepare(
    "INSERT INTO entities (id, kind, name, tag, created_at) VALUES (?, 'personal', ?, 'EVAL', ?)"
  ).run("eval-entity", "Synthetic evaluation", "2025-01-01T00:00:00.000Z")
  db.prepare("INSERT INTO default_entity (id, entity_id) VALUES (1, ?)").run(
    "eval-entity"
  )
  const documents = testCase.messages.map((message) => {
    const sha256 = createHash("sha256")
      .update(`${testCase.id}\n${message.id}\n${message.date}\n${message.body}`)
      .digest("hex")
    return {
      sha256,
      source: "eval-fixture",
      sourceRef: message.id,
      mime: "message/rfc822",
      entityId: "eval-entity",
      title: message.subject,
      body: message.body,
      occurredAt: message.date,
      headers: { messageId: message.id },
      addresses: [
        { role: "from" as const, address: message.from },
        ...message.to.map((address) => ({ role: "to" as const, address })),
      ],
    }
  })
  ingestBatch(db, {
    connector: "eval-fixture",
    stream: testCase.id,
    documents,
    nextCursor: "done",
  })
  return { db, seed: documents[0]?.sha256 ?? "" }
}

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const diffs = []
  for (const testCase of options.cases) {
    const { db, seed } = seedCase(testCase)
    const inner = options.modelForCase(testCase)
    let firstAttemptSchemaValid = false
    let first = true
    const client: ModelClient = {
      async complete(request, completeOptions) {
        const result = await inner.complete(
          { ...request, temperature: 0, seed: options.seed },
          completeOptions
        )
        if (first) {
          first = false
          try {
            firstAttemptSchemaValid = validateIntentResult(
              JSON.parse(result.text)
            ).ok
          } catch {
            firstAttemptSchemaValid = false
          }
        }
        return result
      },
    }
    const proposals: Intent[] = []
    const proposalResult = await proposeIntents(
      { id: testCase.id, text: testCase.request, seed },
      {
        db,
        queue: createInferenceQueue(client),
        gate: {
          propose(input) {
            const checked = validateIntent(input.intent)
            if (!checked.ok)
              throw new Error("proposal path submitted an invalid intent")
            proposals.push(checked.value)
            options.onProposal?.(checked.value)
            return Promise.resolve({
              id: `eval-${String(proposals.length)}`,
              tier: "approval",
              state: "pending",
            })
          },
        },
        limiter: createProposalLimiter({
          maxProposalsPerHour: 1,
          now: () => 0,
        }),
        config: {
          budgetTokens: 4000,
          maxIntentsPerRequest: 10,
          charsPerToken: 3,
        },
        now: () => new Date("2025-01-01T00:00:00.000Z"),
      }
    )
    if (proposalResult.status === "rate_limited")
      throw new Error("eval proposal limiter unexpectedly rejected a case")
    const verdict = options.verdicts[testCase.id] ?? "reject"
    diffs.push(caseDiff(testCase, proposals, verdict, firstAttemptSchemaValid))
    db.close()
  }
  return {
    seed: options.seed,
    temperature: 0,
    modelId: options.modelId,
    scores: scores(diffs),
    cases: diffs,
  }
}

export { SEED }
export type { EvalVerdict }
export const emptyInferenceResult = (text: string) => ({
  ...EMPTY_RESULT,
  text,
})
