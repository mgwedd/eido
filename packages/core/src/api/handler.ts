import type {
  CoreApiAssignmentList,
  CoreApiEntity,
  CoreApiEntityList,
  CoreApiError,
  CoreApiProfile,
  CoreApiProfileResponse,
  ProfileAccountAssignment,
} from "@eido/schemas"
import { ProfileError } from "../profile/errors"
import type { ProfileErrorCode } from "../profile/errors"
import type { ProfileStore } from "../profile/store"

export interface ApiDeps {
  profile: ProfileStore
  /**
   * Host header values core answers to, such as `127.0.0.1:8787`. A request with any other
   * Host gets 421. Core has no auth, so this stops a page that rebinds its own domain to the
   * listen address (DNS rebinding) from driving core through the owner's browser.
   */
  allowedHosts: readonly string[]
}

export type ApiHandler = (request: Request) => Promise<Response>

type ErrorCode = CoreApiError["error"]["code"]

const STATUS: Record<ErrorCode, number> = {
  invalid: 422,
  duplicate_name: 409,
  duplicate_tag: 409,
  not_found: 404,
  entity_in_use: 409,
  bad_request: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  method_not_allowed: 405,
  misdirected_request: 421,
  internal: 500,
}

/** Largest request body core reads. Profile and entity writes are a few KB at most. */
export const MAX_BODY_BYTES = 64 * 1024

class HttpError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  })
}

function failure(
  code: ErrorCode,
  message: string,
  extra: Partial<CoreApiError["error"]> = {}
): Response {
  const body: CoreApiError = { error: { code, message, ...extra } }
  return json(body, STATUS[code])
}

/**
 * Store issues are "path: message". Schema issues start with "$.", which the field name
 * drops. An issue with no path gets the empty field.
 */
export function toFieldErrors(
  issues: readonly string[]
): { field: string; message: string }[] {
  return issues.map((issue) => {
    const split = issue.indexOf(": ")
    if (split === -1) return { field: "", message: issue }
    return {
      field: issue.slice(0, split).replace(/^\$\.?/, ""),
      message: issue.slice(split + 2),
    }
  })
}

function profileFailure(error: ProfileError): Response {
  const code: ProfileErrorCode = error.code
  if (code === "invalid") {
    return failure(code, "invalid input", {
      fields: toFieldErrors(error.details),
    })
  }
  if (code === "entity_in_use") {
    return failure(code, "entity is still referenced", {
      referencedBy: [...error.details],
    })
  }
  return failure(code, error.message)
}

/**
 * Writes require a JSON content type. Besides parsing, this keeps cross-site forms out: a
 * browser sends application/json cross-origin only after a CORS preflight, which core does not
 * answer.
 */
async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? ""
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(
      "unsupported_media_type",
      "content-type must be application/json"
    )
  }
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) {
    throw new HttpError("payload_too_large", "request body too large")
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    throw new HttpError("payload_too_large", "request body too large")
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new HttpError("bad_request", "body is not valid JSON")
  }
}

const ENTITY_PATH = /^\/entities\/([^/]+)$/

export function createApiHandler(deps: ApiDeps): ApiHandler {
  const { profile } = deps
  const allowedHosts = new Set(deps.allowedHosts.map((h) => h.toLowerCase()))

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const host = (request.headers.get("host") ?? url.host).toLowerCase()
    if (!allowedHosts.has(host)) {
      return failure("misdirected_request", "host not served")
    }
    const method = request.method
    const path = url.pathname.replace(/(.)\/$/, "$1")
    const notAllowed = (...methods: string[]): Response => {
      const response = failure("method_not_allowed", "method not allowed")
      response.headers.set("allow", methods.join(", "))
      return response
    }

    if (path === "/profile") {
      if (method === "GET") {
        const current = profile.getProfile()
        const body: CoreApiProfileResponse = current ? { profile: current } : {}
        return json(body)
      }
      if (method === "PATCH") {
        const body: CoreApiProfile = profile.updateProfile(
          await readJson(request)
        )
        return json(body)
      }
      return notAllowed("GET", "PATCH")
    }

    if (path === "/entities") {
      if (method === "GET") {
        const body: CoreApiEntityList = {
          entities: profile.listEntities(),
        }
        return json(body)
      }
      if (method === "POST") {
        const body: CoreApiEntity = profile.createEntity(
          await readJson(request)
        )
        return json(body, 201)
      }
      return notAllowed("GET", "POST")
    }

    const entityMatch = ENTITY_PATH.exec(path)
    if (entityMatch) {
      let id: string
      try {
        id = decodeURIComponent(entityMatch[1] ?? "")
      } catch {
        throw new HttpError("bad_request", "malformed entity id")
      }
      if (method === "PATCH") {
        const body: CoreApiEntity = profile.updateEntity(
          id,
          await readJson(request)
        )
        return json(body)
      }
      if (method === "DELETE") {
        profile.deleteEntity(id)
        return new Response(null, { status: 204 })
      }
      return notAllowed("PATCH", "DELETE")
    }

    if (path === "/entity-assignments") {
      if (method === "GET") {
        const body: CoreApiAssignmentList = {
          assignments: profile.listAssignments(),
        }
        return json(body)
      }
      if (method === "PUT") {
        const body: ProfileAccountAssignment = profile.assignAccount(
          await readJson(request)
        )
        return json(body)
      }
      if (method === "DELETE") {
        const connector = url.searchParams.get("connector")
        const accountRef = url.searchParams.get("accountRef")
        if (!connector || !accountRef) {
          return failure("invalid", "invalid input", {
            fields: [
              ...(connector
                ? []
                : [{ field: "connector", message: "required" }]),
              ...(accountRef
                ? []
                : [{ field: "accountRef", message: "required" }]),
            ],
          })
        }
        if (!profile.unassignAccount(connector, accountRef)) {
          return failure("not_found", "no such assignment")
        }
        return new Response(null, { status: 204 })
      }
      return notAllowed("GET", "PUT", "DELETE")
    }

    return failure("not_found", "no such route")
  }

  return async (request) => {
    try {
      return await route(request)
    } catch (error) {
      if (error instanceof ProfileError) return profileFailure(error)
      if (error instanceof HttpError) return failure(error.code, error.message)
      // Unexpected: say nothing about the cause, since it may quote stored values.
      return failure("internal", "internal error")
    }
  }
}
