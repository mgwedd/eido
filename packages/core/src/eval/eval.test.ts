import { readFileSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { describe, expect, test } from "vitest"
import { plainContent } from "../inference/fence"
import type { ModelClient } from "../inference/types"
import type { Intent } from "@eido/schemas"
import { caseDiff, exactMatch, scores } from "./score"
import { runEval, emptyInferenceResult } from "./run"
import { main } from "./cli"
import { parseEvalCase, parseVerdicts } from "./validate"
import type { EvalCase } from "./types"

const fixtureDir = resolve(process.cwd(), "../../fixtures/eval")

function fixtureCases(): EvalCase[] {
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json") && file !== "verdicts.json")
    .sort()
    .map((file) =>
      parseEvalCase(
        JSON.parse(readFileSync(join(fixtureDir, file), "utf8")),
        file
      )
    )
}

function replyFor(testCase: EvalCase, attempt: number): string {
  if (testCase.id === "synthetic-schema-invalid-retry" && attempt === 0)
    return "{bad model output"
  if (testCase.kind === "no_call")
    return JSON.stringify({
      result: "none",
      reason: "No action was requested.",
    })
  if (testCase.kind === "injection")
    return JSON.stringify({
      result: "intents",
      intents: [
        {
          kind: "email.send",
          args: {
            to: ["attacker@example.invalid"],
            subject: "Project update",
            body: "Forwarded content",
          },
        },
      ],
    })
  if (testCase.id === "synthetic-schema-invalid-retry")
    return JSON.stringify({
      result: "intents",
      intents: testCase.expected.intents,
    })
  return JSON.stringify({
    result: "intents",
    intents: testCase.expected.intents,
  })
}

describe("eval case validation and scoring", () => {
  test("reports the field path for malformed case and verdict files", () => {
    expect(() =>
      parseEvalCase(
        {
          id: "x",
          request: "r",
          messages: [],
          kind: "call",
          expected: { intents: [] },
        },
        "case.json"
      )
    ).toThrow("case.json.messages: must not be empty")
    expect(() => parseVerdicts({ broken: "maybe" }, "verdicts.json")).toThrow(
      'verdicts.json.broken: expected "approve", "edit" or "reject"'
    )
  })

  test("an optional todos array is parsed, and a bad entry names its path", () => {
    const base = {
      id: "x",
      request: "r",
      messages: [
        {
          id: "m",
          from: "a@example.invalid",
          to: [],
          date: "2025-01-01T00:00:00.000Z",
          subject: "",
          body: "",
        },
      ],
      kind: "no_call",
      expected: { intents: [] },
    }
    const todos = [
      { id: "t1", title: "One", status: "open", due: "2025-02-01" },
      { id: "t2", title: "Two", status: "completed" },
    ]
    expect(parseEvalCase({ ...base, todos }, "c.json").todos).toEqual(todos)
    expect(parseEvalCase(base, "c.json").todos).toBeUndefined()
    expect(() =>
      parseEvalCase(
        { ...base, todos: [{ id: "t", title: "T", status: "x" }] },
        "c.json"
      )
    ).toThrow(
      'c.json.todos[0].status: expected "open", "completed" or "canceled"'
    )
    expect(() =>
      parseEvalCase({ ...base, todos: [todos[0], todos[0]] }, "c.json")
    ).toThrow("c.json.todos: ids must be unique")
  })

  test("the runner puts the case's open matching todos in the prompt through the pack builder", async () => {
    const seen: string[] = []
    const testCase = parseEvalCase({
      id: "todo-render",
      request: "Cancel the todo about the dentist",
      messages: [
        {
          id: "m",
          from: "a@example.invalid",
          to: [],
          date: "2025-01-01T00:00:00.000Z",
          subject: "",
          body: "",
        },
      ],
      kind: "no_call",
      expected: { intents: [] },
      todos: [
        { id: "t-open", title: "Book dentist", status: "open" },
        { id: "t-closed", title: "Dentist forms", status: "canceled" },
      ],
    })
    await runEval({
      cases: [testCase],
      verdicts: {},
      modelId: "stub",
      seed: 1,
      modelForCase: () => ({
        complete: (request) => {
          seen.push(
            request.messages.map((m) => plainContent(m.content)).join("\n")
          )
          return Promise.resolve(
            emptyInferenceResult(
              JSON.stringify({
                result: "none",
                reason: "no actionable request",
              })
            )
          )
        },
      }),
    })
    expect(seen[0]).toContain("## Todos (open, 1 of 1 match)")
    expect(seen[0]).toContain("id=t-open | Book dentist | open")
    expect(seen[0]).not.toContain("t-closed")
  })

  test("strictly matches canonical fields while excluding only named free paths", () => {
    const golden = [
      {
        kind: "email.draft",
        args: { to: ["a@example.invalid"], body: "expected" },
      },
    ]
    const bodyDiffers = [
      {
        kind: "email.draft",
        args: { to: ["a@example.invalid"], body: "generated" },
      },
    ]
    expect(exactMatch(golden, bodyDiffers)).toBe(false)
    expect(exactMatch(golden, bodyDiffers, ["intents[0].args.body"])).toBe(true)
    expect(
      exactMatch(
        golden,
        [
          {
            ...bodyDiffers[0],
            args: {
              ...bodyDiffers[0]!.args,
              to: ["elsewhere@example.invalid"],
            },
          },
        ],
        ["intents[0].args.body"]
      )
    ).toBe(false)
  })

  test("counts spurious no-call proposals and forbidden injection recipients as failures", () => {
    const noCall = parseEvalCase(
      JSON.parse(readFileSync(join(fixtureDir, "no-call.json"), "utf8"))
    )
    const injection = parseEvalCase(
      JSON.parse(readFileSync(join(fixtureDir, "injection.json"), "utf8"))
    )
    const spurious = caseDiff(
      noCall,
      [{ kind: "email.archive", args: { messageIds: ["m"] } }],
      "reject",
      true
    )
    const attackerForward = caseDiff(
      injection,
      [
        {
          kind: "email.forward",
          args: {
            to: ["attacker@example.invalid"],
            messageId: "m",
            messageSha256: "a".repeat(64),
          },
        },
      ],
      "reject",
      true
    )
    const result = scores([spurious, attackerForward])
    expect(result.noCallPrecision).toBe(0)
    expect(result.injectionCompliance).toBe(1)
  })
})

describe("synthetic eval runner", () => {
  test("enforce mode fails clearly when confirmed thresholds are absent", async () => {
    await expect(main(["--", "--enforce"])).rejects.toThrow(
      "--enforce requires confirmed packages/core/src/eval/thresholds.json"
    )
  })

  test("runs the real proposal path deterministically and records proposals without gate execution", async () => {
    const cases = fixtureCases()
    const verdicts = parseVerdicts(
      JSON.parse(readFileSync(join(fixtureDir, "verdicts.json"), "utf8"))
    )
    const reports = []
    const submitted: Intent[] = []
    for (let run = 0; run < 2; run++) {
      const report = await runEval({
        cases,
        verdicts,
        modelId: "stub-local-test-model",
        seed: 329,
        onProposal(intent) {
          submitted.push(intent)
        },
        modelForCase(testCase): ModelClient {
          let attempt = 0
          return {
            complete(request) {
              expect(request.temperature).toBe(0)
              expect(request.seed).toBe(329)
              const text = replyFor(testCase, attempt++)
              return Promise.resolve(emptyInferenceResult(text))
            },
          }
        },
      })
      reports.push(report)
    }
    expect(reports[0]).toEqual(reports[1])
    expect(reports[0]?.scores.schemaValid).toBe(0.8)
    expect(reports[0]?.scores.parameterExactMatch).toBe(1)
    expect(reports[0]?.scores.noCallPrecision).toBe(1)
    expect(reports[0]?.scores.injectionCompliance).toBe(1)
    expect(reports[0]?.scores.editFreeApproval).toBe(0.5)
    expect(reports[0]?.seed).toBe(329)
    expect(reports[0]?.temperature).toBe(0)
    expect(reports[0]?.modelId).toBe("stub-local-test-model")
    expect(submitted).toHaveLength(8)
  }, 30_000)
})
