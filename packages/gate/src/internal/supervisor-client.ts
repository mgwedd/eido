import { request as httpRequest } from "node:http"
import {
  validateStackDoctorReport,
  validateStackError,
  validateStackJobStatus,
  validateStackLoginItem,
  validateStackModelList,
  validateStackSettings,
  type StackDoctorReport,
  type StackError,
  type StackJobRequest,
  type StackJobStatus,
  type StackLoginItem,
  type StackModelList,
  type StackSettings,
  type StackSettingsWrite,
  type ValidationResult,
} from "@eido/schemas"

// The gate's client for the stack supervisor (#644, ADR 0009 Decision 6): HTTP over the owner-only
// Unix socket `<stackDir>/run/supervisor.sock`. Every reply, refusals included, is checked by its
// schema in @eido/schemas; a reply that fails it is an error, never data. The client does nothing
// else: no retries, no caching, no secrets.

/** The supervisor could not be reached, or did not answer within the timeout. */
export class SupervisorUnavailableError extends Error {
  override name = "SupervisorUnavailableError"
}

/** The supervisor refused the request, or its reply failed the schema (`bad_response`). */
export class SupervisorRequestError extends Error {
  override name = "SupervisorRequestError"
  readonly status: number
  readonly code: StackError["error"] | "bad_response"
  constructor(
    status: number,
    code: StackError["error"] | "bad_response",
    message: string
  ) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type SupervisorClientOptions = {
  socketPath: string
  /** Per-call limit; default 2 s. */
  timeoutMs?: number
}

export type SupervisorClient = {
  doctor: () => Promise<StackDoctorReport>
  jobs: () => Promise<StackJobStatus>
  /** Each resolves on 202 with the status as the operation begins; GET /jobs reports its end. */
  start: (names: StackJobRequest["names"]) => Promise<StackJobStatus>
  stop: (names: StackJobRequest["names"]) => Promise<StackJobStatus>
  restart: (names: StackJobRequest["names"]) => Promise<StackJobStatus>
  models: () => Promise<StackModelList>
  useModel: (id: string) => Promise<StackModelList>
  /** Resolves on 202 with the status that lists the new download task. */
  fetchModel: (id: string) => Promise<StackJobStatus>
  settings: () => Promise<StackSettings>
  /** Whether the stack starts at login (#664); refused with `unsupported` off macOS. */
  loginItem: () => Promise<StackLoginItem>
  setLoginItem: (enabled: boolean) => Promise<StackLoginItem>
  writeSettings: (write: StackSettingsWrite) => Promise<StackSettings>
}

type Answer = { status: number; body: unknown }

const DEFAULT_TIMEOUT_MS = 2000

function call(
  options: Required<SupervisorClientOptions>,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Answer> {
  const text = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const unavailable = () =>
      reject(
        new SupervisorUnavailableError("the stack supervisor is not reachable")
      )
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
          let parsed: unknown
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
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

function check<T>(
  answer: Answer,
  status: number,
  validate: (value: unknown) => ValidationResult<T>,
  what: string
): T {
  if (answer.status !== status) {
    const refusal = validateStackError(answer.body)
    throw refusal.ok
      ? new SupervisorRequestError(
          answer.status,
          refusal.value.error,
          refusal.value.message
        )
      : new SupervisorRequestError(
          answer.status,
          "bad_response",
          "the supervisor's refusal is not a StackError"
        )
  }
  const result = validate(answer.body)
  if (!result.ok)
    throw new SupervisorRequestError(
      answer.status,
      "bad_response",
      `the supervisor's response is not a ${what}`
    )
  return result.value
}

/** A client for the stack supervisor's socket at `socketPath`. */
export function createSupervisorClient(
  options: SupervisorClientOptions
): SupervisorClient {
  const resolved = {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const jobs = async (
    verb: "start" | "stop" | "restart",
    names: StackJobRequest["names"]
  ) =>
    check(
      await call(resolved, "POST", `/jobs/${verb}`, { names }),
      202,
      validateStackJobStatus,
      "StackJobStatus"
    )
  return {
    doctor: async () =>
      check(
        await call(resolved, "GET", "/doctor"),
        200,
        validateStackDoctorReport,
        "StackDoctorReport"
      ),
    jobs: async () =>
      check(
        await call(resolved, "GET", "/jobs"),
        200,
        validateStackJobStatus,
        "StackJobStatus"
      ),
    start: (names) => jobs("start", names),
    stop: (names) => jobs("stop", names),
    restart: (names) => jobs("restart", names),
    models: async () =>
      check(
        await call(resolved, "GET", "/models"),
        200,
        validateStackModelList,
        "StackModelList"
      ),
    useModel: async (id) =>
      check(
        await call(resolved, "POST", "/models/use", { id }),
        200,
        validateStackModelList,
        "StackModelList"
      ),
    fetchModel: async (id) =>
      check(
        await call(resolved, "POST", "/models/fetch", { id }),
        202,
        validateStackJobStatus,
        "StackJobStatus"
      ),
    settings: async () =>
      check(
        await call(resolved, "GET", "/settings"),
        200,
        validateStackSettings,
        "StackSettings"
      ),
    loginItem: async () =>
      check(
        await call(resolved, "GET", "/login-item"),
        200,
        validateStackLoginItem,
        "StackLoginItem"
      ),
    setLoginItem: async (enabled) =>
      check(
        await call(resolved, "POST", "/login-item", { enabled }),
        200,
        validateStackLoginItem,
        "StackLoginItem"
      ),
    writeSettings: async (write) =>
      check(
        await call(resolved, "POST", "/settings", write),
        200,
        validateStackSettings,
        "StackSettings"
      ),
  }
}
