import { request as httpRequest } from "node:http"
import {
  validateGateApiError,
  validateGateIntentHistory,
  validateGateIntentStatus,
  validateGatePendingIntentList,
  validateGateProposeRefusal,
  validateGateProposeResult,
} from "@eido/schemas"
import type {
  GateIntentHistory,
  GateIntentProposal,
  GateIntentStatus,
  GatePendingIntentList,
  GateProposeResult,
  ValidationResult,
} from "@eido/schemas"

// The data plane's only way into the gate: HTTP over the gate's data-plane socket. Every
// response is parsed with its schema; nothing is cast. When the gate cannot be reached the
// call rejects with GateUnavailableError: nothing is queued and nothing silently succeeds.

/** The gate could not be reached (socket missing, refused, or no answer in time). */
export class GateUnavailableError extends Error {
  override readonly name = "GateUnavailableError"
}

/** The gate answered and refused the request, or answered with a body outside the contract. */
export class GateRequestError extends Error {
  override readonly name = "GateRequestError"
  readonly status: number
  readonly code: string
  /** Field paths and reasons for a 422 invalid_payload; never payload values. */
  readonly errors: readonly string[]
  // Plain fields, not parameter properties: Node runs this file with type stripping only.
  constructor(
    status: number,
    code: string,
    message: string,
    errors: readonly string[] = []
  ) {
    super(message)
    this.status = status
    this.code = code
    this.errors = errors
  }
}

export type IntentClientOptions = {
  socketPath: string
  /** Per-call limit; default 2 s. */
  timeoutMs?: number
}

/**
 * A GateIntentProposal whose intent may be a typed Intent or unchecked model output; the gate
 * validates it either way.
 */
export type IntentProposal = Omit<GateIntentProposal, "intent"> & {
  intent: object
}

export type IntentClient = {
  /** Resolves for a stored intent, including one policy refused (state rejected). */
  propose: (proposal: IntentProposal) => Promise<GateProposeResult>
  status: (id: string) => Promise<GateIntentStatus>
  history: (id: string) => Promise<GateIntentHistory["entries"]>
  listPending: () => Promise<GatePendingIntentList["intents"]>
}

type Answer = { status: number; body: unknown }

const DEFAULT_TIMEOUT_MS = 2000

function call(
  options: Required<IntentClientOptions>,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Answer> {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const unavailable = () =>
      reject(new GateUnavailableError("the gate is not reachable"))
    const request = httpRequest(
      {
        socketPath: options.socketPath,
        path,
        method,
        signal: AbortSignal.timeout(options.timeoutMs),
        headers:
          text === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text),
              },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", unavailable)
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8")
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = undefined
          }
          resolve({ status: response.statusCode ?? 0, body: parsed })
        })
      }
    )
    request.on("error", unavailable)
    request.end(text)
  })
}

function badResponse(status: number, what: string): GateRequestError {
  return new GateRequestError(
    status,
    "bad_response",
    `the gate's response is not a ${what}`
  )
}

function refusal(answer: Answer): GateRequestError {
  const error = validateGateApiError(answer.body)
  return error.ok
    ? new GateRequestError(answer.status, error.value.code, error.value.message)
    : badResponse(answer.status, "GateApiError")
}

function expect<T>(
  answer: Answer,
  statuses: readonly number[],
  validate: (value: unknown) => ValidationResult<T>,
  what: string
): T {
  if (!statuses.includes(answer.status)) throw refusal(answer)
  const result = validate(answer.body)
  if (!result.ok) throw badResponse(answer.status, what)
  return result.value
}

const intentPath = (id: string) => `/intents/${encodeURIComponent(id)}`

/** A client for the gate's data-plane listener at `socketPath`. */
export function createIntentClient(options: IntentClientOptions): IntentClient {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    propose: async (proposal) => {
      const answer = await call(resolved, "POST", "/intents", proposal)
      if (answer.status === 422) {
        const refused = validateGateProposeRefusal(answer.body)
        if (!refused.ok) throw badResponse(422, "GateProposeRefusal")
        throw new GateRequestError(
          422,
          refused.value.code,
          "the intent does not match its schema",
          refused.value.errors
        )
      }
      return expect(
        answer,
        [201, 403],
        validateGateProposeResult,
        "GateProposeResult"
      )
    },
    status: async (id) =>
      expect(
        await call(resolved, "GET", intentPath(id)),
        [200],
        validateGateIntentStatus,
        "GateIntentStatus"
      ),
    history: async (id) =>
      expect(
        await call(resolved, "GET", `${intentPath(id)}/history`),
        [200],
        validateGateIntentHistory,
        "GateIntentHistory"
      ).entries,
    listPending: async () =>
      expect(
        await call(resolved, "GET", "/intents?state=pending"),
        [200],
        validateGatePendingIntentList,
        "GatePendingIntentList"
      ).intents,
  }
}
