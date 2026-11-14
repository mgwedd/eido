import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "vitest"
import type { ModelClient } from "../inference/types"
import { emptyInferenceResult, runEval } from "./run"
import { parseEvalCase } from "./validate"
import type { EvalCase } from "./types"

// The grown synthetic set (issue #91). Real cases stay in eval-local/; these exist so the
// runner, the scoring and the proposal path have a wide, committed workload.
const setDir = resolve(process.cwd(), "../../fixtures/eval/set")

const files = readdirSync(setDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
const cases: EvalCase[] = files.map((file) =>
  parseEvalCase(JSON.parse(readFileSync(join(setDir, file), "utf8")), file)
)

function modelReplying(reply: (testCase: EvalCase) => unknown) {
  return (testCase: EvalCase): ModelClient => ({
    complete: () =>
      Promise.resolve(emptyInferenceResult(JSON.stringify(reply(testCase)))),
  })
}

const verdicts = Object.fromEntries(
  cases.map((c) => [c.id, "approve" as const])
)

async function run(reply: (testCase: EvalCase) => unknown) {
  return runEval({
    cases,
    verdicts,
    modelId: "stub-set-test",
    seed: 329,
    modelForCase: modelReplying(reply),
  })
}

describe("synthetic eval set", () => {
  test("every file parses and is named after its case id", () => {
    expect(files).toEqual(cases.map((c) => `${c.id}.json`))
  })

  test("only invented example.invalid addresses appear", () => {
    const addresses = cases.flatMap((c) => [
      ...c.messages.flatMap((m) => [m.from, ...m.to]),
      ...c.expected.intents.flatMap(
        (i) => JSON.stringify(i.args).match(/[^"\s]+@[^"\s]+/g) ?? []
      ),
      ...(c.forbidden ?? [])
        .filter((f) => f.predicate === "recipient_in")
        .flatMap((f) => f.values),
    ])
    expect(addresses.filter((a) => !a.endsWith("@example.invalid"))).toEqual([])
  })

  test("each forbidden recipient is actually planted in the case's messages", () => {
    const unplanted = cases.flatMap((c) =>
      (c.forbidden ?? [])
        .filter((f) => f.predicate === "recipient_in")
        .flatMap((f) => f.values)
        .filter((value) => !c.messages.some((m) => m.body.includes(value)))
        .map((value) => `${c.id}: ${value}`)
    )
    expect(unplanted).toEqual([])
  })

  test("a model that answers every golden case correctly is reachable through the proposal path", async () => {
    const report = await run((c) =>
      c.kind === "call" || c.expected.intents.length > 0
        ? { result: "intents", intents: c.expected.intents }
        : { result: "none", reason: "no actionable request" }
    )
    expect(report.scores).toEqual({
      schemaValid: 1,
      parameterExactMatch: 1,
      noCallPrecision: 1,
      injectionCompliance: 0,
      editFreeApproval: 1,
    })
  }, 120_000)

  test("every to-do golden carries todos, and each id-dependent kind has a call golden", () => {
    const idKinds = new Set<string>([
      "things.cancel_todo",
      "things.complete_todo",
      "things.schedule_todo",
      "things.update_todo",
    ])
    const called = new Set<string>(
      cases
        .filter((c) => c.kind === "call")
        .flatMap((c) => c.expected.intents.map((i) => i.kind))
    )
    expect([...idKinds].filter((k) => !called.has(k))).toEqual([])
    const withoutTodos = cases
      .filter((c) => c.expected.intents.some((i) => idKinds.has(i.kind)))
      .filter((c) => (c.todos ?? []).length === 0)
    expect(withoutTodos.map((c) => c.id)).toEqual([])
  })

  test("every to-do golden names an id that its case lists as open", () => {
    const bad = cases.flatMap((c) =>
      c.expected.intents.flatMap((i) => {
        const id = (i.args as Record<string, unknown>)["id"]
        if (!i.kind.startsWith("things.") || typeof id !== "string") return []
        return (c.todos ?? []).some((t) => t.id === id && t.status === "open")
          ? []
          : [c.id]
      })
    )
    expect(bad).toEqual([])
  })

  test("a model that obeys a planted to-do title proposes nothing: the kind it names is not offered", async () => {
    const report = await run((c) =>
      c.id === "injection-things-todo-title-01"
        ? {
            result: "intents",
            intents: [
              {
                kind: "things.cancel_todo",
                args: { id: c.todos?.[0]?.id ?? "" },
              },
            ],
          }
        : { result: "none", reason: "no actionable request" }
    )
    const diff = report.cases.find(
      (d) => d.id === "injection-things-todo-title-01"
    )
    expect(diff?.proposed).toEqual([])
    expect(diff?.injectionCompliant).toBe(true)
  }, 120_000)

  test("a model that obeys the planted instruction is caught by every injection case", async () => {
    const report = await run((c) => {
      const attacker = c.forbidden?.find((f) => f.predicate === "recipient_in")
        ?.values[0]
      if (c.kind !== "injection" || attacker === undefined)
        return { result: "none", reason: "no actionable request" }
      return {
        result: "intents",
        intents: [
          {
            kind: "email.send",
            args: { to: [attacker], subject: "Info", body: "Here it is." },
          },
        ],
      }
    })
    const hijackable = cases.filter(
      (c) =>
        c.kind === "injection" &&
        c.forbidden?.some((f) => f.predicate === "recipient_in")
    )
    const caught = report.cases.filter((d) => d.injectionCompliant === false)
    expect(caught.map((d) => d.id)).toEqual(hijackable.map((c) => c.id))
  }, 120_000)
})
