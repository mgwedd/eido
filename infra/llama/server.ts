// llama-server arguments and the HTTP checks run against it: readiness (`/health`), the loaded
// chat template (`/props`), the rendered prompt for a fixed conversation (`/apply-template`) and
// one JSON-schema-constrained completion. HTTP goes through an injected fetch.
import type { ModelProfile } from "./lock.ts"

/** llama-server binds this address only; nothing else on the LAN or tailnet can reach it. */
export const LOOPBACK = "127.0.0.1"

/**
 * The flags measured on the host in #69, with the bind address fixed, then the profile's chat
 * template kwargs and its own flags. `--jinja` applies the model's own chat template from the GGUF;
 * `--chat-template-kwargs` makes the profile's kwargs the default for every templated request, so
 * core and the template check render with them. The lock refuses profile flags that would change
 * the model, the bind or the template.
 */
export function serverArgs(
  modelPath: string,
  port: number,
  profile: Pick<ModelProfile, "chatTemplateKwargs" | "flags">
): string[] {
  return [
    "-m",
    modelPath,
    "--jinja",
    "--host",
    LOOPBACK,
    "--port",
    String(port),
    "-c",
    "8192",
    "-fa",
    "on",
    "--cache-type-k",
    "q8_0",
    "--cache-type-v",
    "q8_0",
    "-ngl",
    "99",
    "-b",
    "2048",
    "-ub",
    "2048",
    "-t",
    "8",
    ...(profile.chatTemplateKwargs === undefined
      ? []
      : ["--chat-template-kwargs", JSON.stringify(profile.chatTemplateKwargs)]),
    ...profile.flags,
  ]
}

export const baseUrl = (port: number): string => `http://${LOOPBACK}:${port}`

export type HttpResponse = { status: number; json: () => Promise<unknown> }
export type Fetch = (
  url: string,
  init?: { method: "POST"; body: string }
) => Promise<HttpResponse>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export type WaitDeps = {
  fetch: Fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Resolves with the exit code if the server exits first. */
  exited: Promise<number>
}

export type Ready = { ok: true; ms: number } | { ok: false; message: string }

/** Polls `/health` until it answers 200, the server exits, or the timeout passes. */
export async function waitHealthy(
  port: number,
  timeoutMs: number,
  deps: WaitDeps
): Promise<Ready> {
  const started = deps.now()
  let exitCode: number | undefined
  void deps.exited.then((code) => (exitCode = code))
  for (;;) {
    if (exitCode !== undefined)
      return {
        ok: false,
        message: `llama-server exited with code ${exitCode} before /health answered`,
      }
    try {
      const response = await deps.fetch(`${baseUrl(port)}/health`)
      if (response.status === 200) return { ok: true, ms: deps.now() - started }
    } catch {
      // Not listening yet.
    }
    if (deps.now() - started >= timeoutMs)
      return {
        ok: false,
        message: `/health did not answer 200 within ${timeoutMs / 1000} s`,
      }
    await deps.sleep(250)
  }
}

export type Check = { ok: true } | { ok: false; message: string }

/** `/props` must report a chat template, one that contains the profile's marker when it has one. */
export async function checkProps(
  port: number,
  marker: string | undefined,
  fetch: Fetch
): Promise<Check> {
  let body: unknown
  try {
    body = await (await fetch(`${baseUrl(port)}/props`)).json()
  } catch (error) {
    return { ok: false, message: `/props failed: ${errorText(error)}` }
  }
  const template = isRecord(body) ? body["chat_template"] : undefined
  if (typeof template !== "string" || template === "")
    return { ok: false, message: "/props has no chat_template" }
  if (marker !== undefined && !template.includes(marker))
    return {
      ok: false,
      message: `/props chat_template does not contain ${JSON.stringify(marker)}`,
    }
  return { ok: true }
}

export type Message =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant"
      content: string
      tool_calls?: {
        type: "function"
        id: string
        function: { name: string; arguments: string }
      }[]
    }
  | { role: "tool"; tool_call_id: string; content: string }

/** A fixed synthetic conversation: system, user, an assistant tool call, its result, a reply. */
export const FIXED_CONVERSATION: Message[] = [
  { role: "system", content: "You are a test assistant. Answer briefly." },
  { role: "user", content: "What is the weather in Testville?" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        type: "function",
        id: "call_1",
        function: {
          name: "get_weather",
          arguments: '{"city":"Testville"}',
        },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: '{"forecast":"sunny"}' },
  { role: "assistant", content: "It is sunny in Testville." },
  { role: "user", content: "Thanks." },
]

/** The first index where two strings differ, or -1 when they are equal. */
export function firstDifference(a: string, b: string): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i
  return -1
}

/**
 * A reference prompt writes this where its template prints today's date (gpt-oss: `Current date:`,
 * from `strftime_now`). The check swaps in the host's local date, which is what llama.cpp prints.
 */
export const CURRENT_DATE = "{{current_date}}"

const localDate = (at: Date): string =>
  [
    String(at.getFullYear()).padStart(4, "0"),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ].join("-")

/**
 * `/apply-template` on the fixed conversation must return exactly the reference prompt, with
 * `CURRENT_DATE` replaced by the local date. The date is read before and after the request, so a
 * check that straddles midnight passes on either.
 */
export async function checkRenderedPrompt(
  port: number,
  reference: string,
  fetch: Fetch,
  now: () => Date = () => new Date()
): Promise<Check> {
  const before = localDate(now())
  let body: unknown
  try {
    const response = await fetch(`${baseUrl(port)}/apply-template`, {
      method: "POST",
      body: JSON.stringify({ messages: FIXED_CONVERSATION }),
    })
    body = await response.json()
  } catch (error) {
    return { ok: false, message: `/apply-template failed: ${errorText(error)}` }
  }
  const prompt = isRecord(body) ? body["prompt"] : undefined
  if (typeof prompt !== "string")
    return { ok: false, message: "/apply-template returned no prompt" }
  const expected = [before, localDate(now())].map((date) =>
    reference.replaceAll(CURRENT_DATE, date)
  )
  if (expected.includes(prompt)) return { ok: true }
  const against = expected[expected.length - 1] ?? reference
  const at = firstDifference(prompt, against)
  const around = (text: string) =>
    JSON.stringify(text.slice(Math.max(0, at - 20), at + 40))
  return {
    ok: false,
    message: `rendered prompt differs from the reference at character ${at}: expected ${around(against)}, actual ${around(prompt)}`,
  }
}

const SCHEMA_FIELDS = ["city", "country", "summary", "unit"] as const

/** Strict JSON schema with four required string fields. */
export const JSON_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    SCHEMA_FIELDS.map((f) => [f, { type: "string" }])
  ),
  required: [...SCHEMA_FIELDS],
  additionalProperties: false,
} as const

/** True when the text is a JSON object with exactly the four schema fields, all strings. */
export function matchesSchema(text: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  return (
    keys.join() === [...SCHEMA_FIELDS].sort().join() &&
    SCHEMA_FIELDS.every((field) => typeof value[field] === "string")
  )
}

/** One `/v1/chat/completions` request constrained by JSON_SCHEMA must return matching JSON. */
export async function checkJsonSchema(
  port: number,
  fetch: Fetch
): Promise<Check> {
  let body: unknown
  try {
    const response = await fetch(`${baseUrl(port)}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              "Describe the weather in Testville, Exampleland, in one short sentence, temperature in celsius.",
          },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: {
          type: "json_schema",
          json_schema: { name: "weather", strict: true, schema: JSON_SCHEMA },
        },
      }),
    })
    body = await response.json()
  } catch (error) {
    return {
      ok: false,
      message: `/v1/chat/completions failed: ${errorText(error)}`,
    }
  }
  const choices = isRecord(body) ? body["choices"] : undefined
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined
  const message = isRecord(first) ? first["message"] : undefined
  const content = isRecord(message) ? message["content"] : undefined
  if (typeof content !== "string")
    return { ok: false, message: "the completion has no message content" }
  if (!matchesSchema(content))
    return {
      ok: false,
      message: `the completion does not match the schema: ${JSON.stringify(content.slice(0, 200))}`,
    }
  return { ok: true }
}
