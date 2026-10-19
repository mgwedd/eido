import type { DatabaseSync } from "node:sqlite"
import {
  validateGateDecisionRequest,
  validateGateEditRequest,
  validateGateLoginRequest,
} from "@eido/schemas"
import type {
  GateCredentialStatus,
  GateDecisionResult,
  GateIntentHistory,
  GateLoginOptions,
  GatePendingIntentList,
  GatePrepareApproval,
  GateSession,
} from "@eido/schemas"
import { issueNonce, reject, verifyApproval } from "./approvals"
import type { PreparedApproval } from "./approvals"
import { apiError, NOT_FOUND } from "./http"
import type { GateRequest, Handler, Reply } from "./http"
import {
  approvalCard,
  editIntent,
  intentHistory,
  intentSummary,
  pendingIntents,
} from "./intents"
import type { EditResult } from "./intents"
import type { Policy } from "./policy"
import {
  beginLogin,
  hasCredential,
  login,
  sessionCookie,
  sessionExpiry,
  sessionToken,
} from "./sessions"
import type { Clock } from "./sessions"
import type { WebAuthnConfig } from "./webauthn"

// The phone listener (#85): what the PWA calls, through `tailscale serve`, to sign in with its
// passkey and to list, prepare, edit and decide approvals. It answers only the Host headers it
// is given (421 otherwise) and only below its base path. Every route outside the table below is
// 404 before any session check, so the admin routes (enrolment codes, revocation, policy, the
// audit chain; #78) and the data plane's routes do not exist here, signed in or not. Credential
// status and login need no session; every other route needs the session cookie (401 without
// it). Every POST must be application/json (415 otherwise): a browser sends that cross-origin
// only after a CORS preflight, which the gate never answers. No response is cacheable.

export type PhoneState = {
  db: DatabaseSync
  policy: Policy
  webAuthn: WebAuthnConfig
}

export type PhoneRoute = {
  method: "GET" | "POST"
  /** Below the base path; `:id` is one path segment, an intent id. */
  path: string
  session: boolean
}

/** Every route the phone listener serves. */
export const PHONE_ROUTES = [
  { method: "GET", path: "/passkey/status", session: false },
  { method: "POST", path: "/auth/login/options", session: false },
  { method: "POST", path: "/auth/login", session: false },
  { method: "GET", path: "/approvals", session: true },
  { method: "GET", path: "/approvals/:id/history", session: true },
  { method: "POST", path: "/approvals/:id/nonce", session: true },
  { method: "POST", path: "/approvals/:id/decision", session: true },
  { method: "POST", path: "/approvals/:id/edit", session: true },
] as const satisfies readonly PhoneRoute[]

type RoutePath = (typeof PHONE_ROUTES)[number]["path"]

type Matched = { route: (typeof PHONE_ROUTES)[number]; id: string }

/** The route a method and path (below the base path) name, with the `:id` segment decoded. */
export function matchRoute(method: string, path: string): Matched | undefined {
  const segments = path.split("/")
  for (const route of PHONE_ROUTES) {
    if (route.method !== method) continue
    const pattern = route.path.split("/")
    if (pattern.length !== segments.length) continue
    let id = ""
    const matches = pattern.every((part, index) => {
      const segment = segments[index] ?? ""
      if (part !== ":id") return part === segment
      if (segment === "") return false
      try {
        id = decodeURIComponent(segment)
      } catch {
        return false
      }
      return true
    })
    if (matches) return { route, id }
  }
  return undefined
}

/** The path below `basePath`, or undefined when the request is outside it. */
export function routePath(
  pathname: string,
  basePath: string
): string | undefined {
  if (basePath === "") return pathname
  if (pathname === basePath) return "/"
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : undefined
}

type Json = { ok: true; value: unknown } | { ok: false; reply: Reply }

async function jsonBody(request: GateRequest): Promise<Json> {
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

function invalid(what: string, errors: readonly string[]): Reply {
  return apiError(
    400,
    "invalid_request",
    `the body is not ${what}: ${(errors[0] ?? "").slice(0, 200)}`
  )
}

function credentialStatus(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Reply {
  const expiry = sessionExpiry(
    state.db,
    sessionToken(request.headers.cookie),
    now
  )
  const status: GateCredentialStatus = {
    enrolled: hasCredential(state.db),
    sessionExpiresAt: expiry === undefined ? null : expiry.toISOString(),
  }
  return { status: 200, body: status }
}

function loginOptions(state: PhoneState, now: Clock): Reply {
  const { challenge, expiresAt } = beginLogin(state.db, now)
  const options: GateLoginOptions = {
    challenge,
    rpId: state.webAuthn.rpId,
    expiresAt: expiresAt.toISOString(),
  }
  return { status: 200, body: options }
}

async function loginRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateLoginRequest(body.value)
  if (!checked.ok) return invalid("a login request", checked.errors)
  const result = login(state.db, state.webAuthn, checked.value.assertion, now)
  if (!result.ok) {
    return apiError(403, "verification_failed", "the login was refused")
  }
  const session: GateSession = { expiresAt: result.expiresAt.toISOString() }
  return {
    status: 200,
    body: session,
    headers: { "set-cookie": sessionCookie(result.token) },
  }
}

/** The prepare response for an intent issueNonce just prepared. */
function prepared(state: PhoneState, approval: PreparedApproval): Reply {
  if (!approval.ok) {
    return approval.code === "not_found"
      ? apiError(404, "not_found", "no such intent")
      : apiError(409, "already_decided", "the intent is no longer pending")
  }
  const card = approvalCard(state.db, approval.intentId)
  if (card === undefined) return apiError(404, "not_found", "no such intent")
  const body: GatePrepareApproval = {
    intentId: approval.intentId,
    kind: card.kind,
    origin: card.origin,
    state: "pending",
    payload: approval.payload,
    payloadHash: approval.payloadHash,
    nonce: approval.nonce,
    documentIds: card.documentIds,
    ...(card.contextPackId === null
      ? {}
      : { contextPackId: card.contextPackId }),
    ...(card.editedFrom === null ? {} : { editedFrom: card.editedFrom }),
    ...(card.rationale === null ? {} : { rationale: card.rationale }),
  }
  return { status: 200, body }
}

function history(state: PhoneState, id: string): Reply {
  if (intentSummary(state.db, id) === undefined) {
    return apiError(404, "not_found", "no such intent")
  }
  const body: GateIntentHistory = {
    intentId: id,
    entries: intentHistory(state.db, id),
  }
  return { status: 200, body }
}

async function decision(
  state: PhoneState,
  request: GateRequest,
  id: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateDecisionRequest(body.value)
  if (!checked.ok) return invalid("a decision", checked.errors)
  const decided = checked.value
  if (decided.intentId !== id) {
    return apiError(400, "invalid_request", "intentId does not match the path")
  }
  if (decided.decision === "approved") {
    const result = verifyApproval(state.db, state.webAuthn, {
      intentId: id,
      nonce: decided.nonce,
      assertion: decided.assertion,
    })
    if (!result.ok) {
      return apiError(403, "verification_failed", "the approval was refused")
    }
    const approved: GateDecisionResult = { intentId: id, state: "approved" }
    return { status: 200, body: approved }
  }
  const result = reject(state.db, id, decided.reasonCode)
  if (!result.ok) {
    return result.code === "not_found"
      ? apiError(404, "not_found", "no such intent")
      : apiError(409, "already_decided", "the intent is no longer pending")
  }
  const rejected: GateDecisionResult = { intentId: id, state: "rejected" }
  return { status: 200, body: rejected }
}

const EDIT_REFUSALS = {
  not_found: [404, "not_found", "no such intent"],
  not_pending: [409, "already_decided", "the intent is no longer pending"],
  invalid_payload: [422, "invalid_request", "the edited intent is not valid"],
  kind_changed: [422, "invalid_request", "an edit cannot change the kind"],
  forbidden: [403, "forbidden", "policy forbids the edited intent"],
  tier_changed: [409, "tier_changed", "the edit would change the tier"],
} as const satisfies Record<
  Extract<EditResult, { ok: false }>["code"],
  readonly [number, Parameters<typeof apiError>[1], string]
>

async function edit(
  state: PhoneState,
  request: GateRequest,
  id: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateEditRequest(body.value)
  if (!checked.ok) return invalid("an edit", checked.errors)
  const result = editIntent(
    state.db,
    state.policy,
    id,
    checked.value.intent,
    "approver"
  )
  if (!result.ok) {
    const [status, code, message] = EDIT_REFUSALS[result.code]
    const detail =
      result.code === "invalid_payload" && result.errors !== undefined
        ? `${message}: ${(result.errors[0] ?? "").slice(0, 200)}`
        : message
    return apiError(status, code, detail)
  }
  return prepared(state, issueNonce(state.db, result.intentId))
}

function route(
  state: PhoneState,
  request: GateRequest,
  matched: Matched,
  now: Clock
): Reply | Promise<Reply> {
  const path: RoutePath = matched.route.path
  switch (path) {
    case "/passkey/status":
      return credentialStatus(state, request, now)
    case "/auth/login/options":
      return loginOptions(state, now)
    case "/auth/login":
      return loginRoute(state, request, now)
    case "/approvals": {
      const list: GatePendingIntentList = { intents: pendingIntents(state.db) }
      return { status: 200, body: list }
    }
    case "/approvals/:id/history":
      return history(state, matched.id)
    case "/approvals/:id/nonce":
      return prepared(state, issueNonce(state.db, matched.id))
    case "/approvals/:id/decision":
      return decision(state, request, matched.id)
    case "/approvals/:id/edit":
      return edit(state, request, matched.id)
  }
}

export type PhoneOptions = {
  gate: () => PhoneState
  /** Every Host header answered; anything else gets 421. */
  allowedHosts: readonly string[]
  basePath: string
  now: Clock
}

const NO_STORE = { "cache-control": "no-store" } as const

/** The phone listener's handler. */
export function phoneHandler(options: PhoneOptions): Handler {
  const allowedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()))
  const answer = async (request: GateRequest): Promise<Reply> => {
    const host = request.headers.host?.toLowerCase()
    if (host === undefined || !allowedHosts.has(host)) {
      return apiError(421, "misdirected_request", "host not served")
    }
    const local = routePath(request.path, options.basePath)
    const matched =
      local === undefined ? undefined : matchRoute(request.method, local)
    if (matched === undefined) return NOT_FOUND
    if (
      request.method === "POST" &&
      !/^application\/json\s*(;|$)/i.test(request.headers.contentType ?? "")
    ) {
      return apiError(
        415,
        "unsupported_media_type",
        "content-type must be application/json"
      )
    }
    const state = options.gate()
    if (
      matched.route.session &&
      sessionExpiry(
        state.db,
        sessionToken(request.headers.cookie),
        options.now
      ) === undefined
    ) {
      return apiError(401, "unauthenticated", "sign in with your passkey")
    }
    return route(state, request, matched, options.now)
  }
  return async (request) => {
    const reply = await answer(request)
    return { ...reply, headers: { ...reply.headers, ...NO_STORE } }
  }
}
