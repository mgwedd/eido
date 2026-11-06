import {
  validateStackJobRequest,
  validateStackModelRequest,
} from "@eido/schemas"
import type { GateAdminStack } from "@eido/schemas"
import { apiError } from "./http"
import type { GateRequest, Reply } from "./http"
import {
  SupervisorRequestError,
  SupervisorUnavailableError,
} from "./supervisor-client"
import type { SupervisorClient } from "./supervisor-client"

// The admin routes (#659, ADR 0009 Decisions 4 to 6): the phone listener relays the stack
// supervisor's doctor, jobs and models over its owner-only socket. Reads need the session;
// start, stop, restart, and choosing or fetching a model need a step-up (the route table in
// phone-routes.ts gives each its tier). The gate adds nothing to what the supervisor answers
// and passes on no supervisor text it has not schema-checked.

export type AdminPath =
  | "/admin/stack"
  | "/admin/doctor"
  | "/admin/stack/start"
  | "/admin/stack/stop"
  | "/admin/stack/restart"
  | "/admin/models"
  | "/admin/models/:id/use"
  | "/admin/models/:id/fetch"

type Body = { ok: true; value: unknown } | { ok: false; reply: Reply }

const UNAVAILABLE = apiError(
  503,
  "supervisor_unavailable",
  "the stack supervisor is not answering"
)

/** The gate's reply for a supervisor failure. Its message never carries supervisor text. */
export function supervisorFailure(error: unknown): Reply {
  if (error instanceof SupervisorUnavailableError) return UNAVAILABLE
  if (!(error instanceof SupervisorRequestError)) throw error
  switch (error.code) {
    case "not_found":
      return apiError(404, "not_found", "no such model profile")
    case "invalid_body":
      return apiError(400, "invalid_request", "the supervisor refused the body")
    case "busy":
      return apiError(503, "busy", "another stack job is running")
    case "stack_not_running":
      return apiError(
        409,
        "stack_not_running",
        "core and llama are not running"
      )
    default:
      return apiError(502, "supervisor_failed", "the stack supervisor failed")
  }
}

async function relay(
  work: () => Promise<unknown>,
  status: number
): Promise<Reply> {
  try {
    return { status, body: await work() }
  } catch (error) {
    return supervisorFailure(error)
  }
}

async function stackStatus(supervisor: SupervisorClient): Promise<Reply> {
  try {
    const body: GateAdminStack = {
      supervisor: "available",
      jobs: await supervisor.jobs(),
    }
    return { status: 200, body }
  } catch (error) {
    if (!(error instanceof SupervisorUnavailableError)) {
      return supervisorFailure(error)
    }
    const body: GateAdminStack = { supervisor: "unavailable" }
    return { status: 200, body }
  }
}

/** One admin route. `body` reads the request's JSON body (the phone listener's reader). */
export async function adminRoute(
  supervisor: SupervisorClient | undefined,
  path: AdminPath,
  id: string,
  request: GateRequest,
  body: (request: GateRequest) => Promise<Body>
): Promise<Reply> {
  if (supervisor === undefined) {
    // No socket configured: the gate runs outside the stack, so there is nothing to relay.
    return path === "/admin/stack"
      ? { status: 200, body: { supervisor: "unavailable" } }
      : UNAVAILABLE
  }
  switch (path) {
    case "/admin/stack":
      return stackStatus(supervisor)
    case "/admin/doctor":
      return relay(() => supervisor.doctor(), 200)
    case "/admin/models":
      return relay(() => supervisor.models(), 200)
    case "/admin/models/:id/use":
    case "/admin/models/:id/fetch": {
      const checked = validateStackModelRequest({ id })
      if (!checked.ok) {
        return apiError(400, "invalid_request", "not a model profile id")
      }
      return path === "/admin/models/:id/use"
        ? relay(() => supervisor.useModel(id), 200)
        : relay(() => supervisor.fetchModel(id), 202)
    }
    case "/admin/stack/start":
    case "/admin/stack/stop":
    case "/admin/stack/restart": {
      const read = await body(request)
      if (!read.ok) return read.reply
      const checked = validateStackJobRequest(read.value)
      if (!checked.ok) {
        return apiError(
          400,
          "invalid_request",
          "names must be core, llama or both"
        )
      }
      const names = checked.value.names
      const verb = path.slice("/admin/stack/".length)
      return relay(
        () =>
          verb === "start"
            ? supervisor.start(names)
            : verb === "stop"
              ? supervisor.stop(names)
              : supervisor.restart(names),
        202
      )
    }
  }
}
