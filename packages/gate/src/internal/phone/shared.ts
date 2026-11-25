import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"

type Json = { ok: true; value: unknown } | { ok: false; reply: Reply }

export async function jsonBody(request: GateRequest): Promise<Json> {
  const body = await request.body()
  if (!body.ok) {
    return {
      ok: false,
      reply: apiError(413, "invalid_request", "the body is over 1 MiB"),
    }
  }
  try {
    return { ok: true, value: JSON.parse(body.text) }
  } catch {
    return {
      ok: false,
      reply: apiError(400, "invalid_request", "the body is not valid JSON"),
    }
  }
}

export function invalid(what: string, errors: readonly string[]): Reply {
  return apiError(
    400,
    "invalid_request",
    `the body is not ${what}: ${(errors[0] ?? "").slice(0, 200)}`
  )
}

export const NO_STORE = { "cache-control": "no-store" } as const
