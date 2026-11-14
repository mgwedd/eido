import { validateIntent } from "@eido/schemas"
import type { EvalCase, EvalMessage, EvalTodo, Verdicts } from "./types"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === ""))
    return fail(path, "expected a non-empty string")
  return value
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return fail(path, "expected an array")
  return value.map((item, index) => string(item, `${path}[${index}]`))
}

function parseMessage(value: unknown, path: string): EvalMessage {
  if (!record(value)) return fail(path, "expected an object")
  if (!Array.isArray(value.to)) return fail(`${path}.to`, "expected an array")
  return {
    id: string(value.id, `${path}.id`),
    from: string(value.from, `${path}.from`),
    to: strings(value.to, `${path}.to`),
    date: string(value.date, `${path}.date`),
    subject: string(value.subject, `${path}.subject`, true),
    body: string(value.body, `${path}.body`, true),
  }
}

function parseTodo(value: unknown, path: string): EvalTodo {
  if (!record(value)) return fail(path, "expected an object")
  if (
    value.status !== "open" &&
    value.status !== "completed" &&
    value.status !== "canceled"
  )
    return fail(`${path}.status`, 'expected "open", "completed" or "canceled"')
  return {
    id: string(value.id, `${path}.id`),
    title: string(value.title, `${path}.title`),
    status: value.status,
    ...(value.due === undefined
      ? {}
      : { due: string(value.due, `${path}.due`) }),
  }
}

export function parseEvalCase(value: unknown, source = "case"): EvalCase {
  if (!record(value)) return fail(source, "expected an object")
  const id = string(value.id, `${source}.id`)
  const request = string(value.request, `${source}.request`)
  if (!Array.isArray(value.messages))
    return fail(`${source}.messages`, "expected an array")
  const messages = value.messages.map((item, i) =>
    parseMessage(item, `${source}.messages[${String(i)}]`)
  )
  if (messages.length === 0)
    return fail(`${source}.messages`, "must not be empty")
  let todos: EvalTodo[] | undefined
  if (value.todos !== undefined) {
    if (!Array.isArray(value.todos))
      return fail(`${source}.todos`, "expected an array")
    todos = value.todos.map((item, i) =>
      parseTodo(item, `${source}.todos[${String(i)}]`)
    )
    const ids = todos.map((t) => t.id)
    if (new Set(ids).size !== ids.length)
      return fail(`${source}.todos`, "ids must be unique")
  }
  if (
    value.kind !== "call" &&
    value.kind !== "no_call" &&
    value.kind !== "injection"
  )
    return fail(`${source}.kind`, 'expected "call", "no_call" or "injection"')
  if (!record(value.expected) || !Array.isArray(value.expected.intents))
    return fail(`${source}.expected.intents`, "expected an array")
  const intents = value.expected.intents.map((intent, i) => {
    const result = validateIntent(intent)
    if (!result.ok)
      return fail(
        `${source}.expected.intents[${String(i)}]`,
        result.errors.join("; ")
      )
    return result.value
  })
  if (value.kind === "no_call" && intents.length > 0)
    return fail(`${source}.expected.intents`, "must be empty for no_call")
  let forbidden: EvalCase["forbidden"]
  if (value.forbidden !== undefined) {
    if (!Array.isArray(value.forbidden))
      return fail(`${source}.forbidden`, "expected an array")
    forbidden = value.forbidden.map((item, i) => {
      const path = `${source}.forbidden[${String(i)}]`
      if (!record(item)) return fail(path, "expected an object")
      if (item.predicate !== "recipient_in" && item.predicate !== "kind_in")
        return fail(`${path}.predicate`, 'expected "recipient_in" or "kind_in"')
      return {
        predicate: item.predicate,
        values: strings(item.values, `${path}.values`),
      }
    })
  }
  if (
    value.kind === "injection" &&
    (forbidden === undefined || forbidden.length === 0)
  )
    return fail(
      `${source}.forbidden`,
      "injection cases require at least one forbidden predicate"
    )
  let free: string[] | undefined
  if (value.free !== undefined) {
    free = strings(value.free, `${source}.free`)
    for (const path of free) {
      if (
        !/^(intents|\$\.intents)(\[\d+\])?(\.[A-Za-z][A-Za-z0-9]*)+$/.test(path)
      )
        return fail(
          `${source}.free`,
          `invalid intent field path ${JSON.stringify(path)}`
        )
    }
  }
  return {
    id,
    request,
    messages,
    ...(todos === undefined ? {} : { todos }),
    kind: value.kind,
    expected: { intents },
    ...(forbidden === undefined ? {} : { forbidden }),
    ...(free === undefined ? {} : { free }),
  }
}

export function parseVerdicts(value: unknown, source = "verdicts"): Verdicts {
  if (!record(value)) return fail(source, "expected an object keyed by case id")
  const entries = Object.entries(value)
  const verdicts: Verdicts = {}
  for (const [id, verdict] of entries) {
    if (verdict !== "approve" && verdict !== "edit" && verdict !== "reject")
      fail(`${source}.${id}`, 'expected "approve", "edit" or "reject"')
    verdicts[id] = verdict
  }
  return verdicts
}
