import type { DatabaseSync } from "node:sqlite"
import type { GateFileRoots, GatePendingIntentList } from "@eido/schemas"
import { issueNonce } from "./approvals"
import { adminRoute } from "./admin-routes"
import { apiError, NOT_FOUND } from "./http"
import type { GateRequest, Handler, Reply } from "./http"
import type { ExecutionResult } from "./executor"
import { pendingIntents } from "./intents"
import { verifyChain } from "./audit"
import { prepareEnrolmentCodeIssue } from "./enrolment"
import { allowAttempt } from "./rate-limit"
import type { RateState } from "./rate-limit"
import { prepareSimpleFin, removeConnectorSecrets } from "./connector-secrets"
import { googleCallback } from "./google-connect"
import {
  completeFileRootsRoute,
  prepareFileRootsRoute,
} from "./file-root-routes"
import { approvedFileRoots } from "./files/file-roots"
import { pushSubscriptions, removePushSubscription } from "./push-subscriptions"
import {
  getWebSessionPublicKey,
  sessionExpiry,
  sessionToken,
  useElevation,
} from "./sessions"
import type { Clock, Elevations } from "./sessions"
import { NO_STORE, jsonBody } from "./phone/shared"
import {
  loginRoute,
  stepUpStatus,
  logoutRoute,
  credentialStatus,
  stepUpRoute,
  loginOptions,
} from "./phone/session"
import {
  recoverCancelRoute,
  recoverCancelPrepareRoute,
  enrolRoute,
  enrolOptions,
  recoverStartRoute,
  recoverCompleteRoute,
  issueEnrolmentCodeRoute,
  recoverOptionsRoute,
} from "./phone/enrolment-recovery"
import {
  history,
  undo,
  prepared,
  decision,
  edit,
  discardDraft,
} from "./phone/approvals"
import {
  backupStatusRoute,
  auditPage,
  permissionList,
  passkeyList,
} from "./phone/pages"
import {
  repinPrepare,
  firstPinDecision,
  repinDecision,
  connectorSettings,
  firstPinPrepare,
} from "./phone/connector-pinning"
import { preparePush, registerPush } from "./phone/push"
import {
  bridgePinRoute,
  googlePrepareRoute,
  googleStartRoute,
  bridgeSecretRoute,
  NO_GOOGLE,
  simpleFinRoute,
  bridgeSecretPrepare,
  bridgePinPrepare,
} from "./phone/connector-secret-routes"
import type { PhoneState } from "./phone/types"

// The phone listener (#85): what the PWA calls, through `tailscale serve`, to sign in with its
// passkey and to list, prepare, edit and decide approvals. It answers only the Host headers it
// is given (421 otherwise) and only below its base path. Every route outside the table below is
// 404 before any session check, so the control socket's routes (revocation, policy; #78) and the
// data plane's routes do not exist here, signed in or not. The stack admin routes (`/admin/*`,
// #659) relay the stack supervisor; see admin-routes.ts. Issuing an enrolment code from the web
// Admin page (`/admin/enrolment-codes`, #660) is a signed control change. The one
// exception is the allowed-folder list (`GET /file-roots`, #574), served beside the signed
// ceremony that changes it; file reads (`POST /files`) stay on the data plane. Credential
// status, login and enrolment need no session: enrolment needs a single-use code the owner
// issued on the Mac instead (#202). Every other route needs the session cookie (401 without
// it); each route's tier (RouteTier below) says what more it needs: an `elevated` route answers
// 403 step_up_required without a step-up in the last five minutes (#643). Every POST must be application/json (415 otherwise): a browser sends that cross-origin
// only after a CORS preflight, which the gate never answers. No response is cacheable.

export type { PhoneState } from "./phone/types"

export type PhoneRoute = {
  method: "GET" | "POST"
  /** Below the base path; `:id` is one path segment, an intent id. */
  path: string
  tier: RouteTier
}

/**
 * What a route needs (ADR 0009). `public`: nothing. `session`: the passkey session. `elevated`:
 * a step-up within the last ELEVATION_TTL_MS. `signed`: the session, plus a per-action passkey
 * assertion over the payload hash that the route itself verifies (ADR 0005); elevation never
 * replaces it. A new route picks one of these; there is no other check.
 */
export type RouteTier = "public" | "session" | "elevated" | "signed"

/** Every route the phone listener serves. */
export const PHONE_ROUTES = [
  { method: "GET", path: "/passkey/status", tier: "public" },
  { method: "POST", path: "/auth/login/options", tier: "public" },
  { method: "POST", path: "/auth/login", tier: "public" },
  { method: "GET", path: "/auth/jwt-key", tier: "public" },
  { method: "POST", path: "/auth/logout", tier: "public" },
  { method: "POST", path: "/auth/step-up/options", tier: "session" },
  { method: "POST", path: "/auth/step-up", tier: "session" },
  { method: "GET", path: "/auth/step-up", tier: "session" },
  { method: "POST", path: "/passkey/enroll/options", tier: "public" },
  { method: "POST", path: "/passkey/enroll", tier: "public" },
  { method: "POST", path: "/passkey/recover/start", tier: "public" },
  { method: "POST", path: "/passkey/recover/options", tier: "public" },
  { method: "POST", path: "/passkey/recover/complete", tier: "public" },
  { method: "POST", path: "/passkey/recover/cancel/prepare", tier: "session" },
  { method: "POST", path: "/passkey/recover/cancel", tier: "signed" },
  { method: "GET", path: "/approvals", tier: "session" },
  { method: "GET", path: "/audit", tier: "session" },
  { method: "GET", path: "/audit/chain", tier: "session" },
  { method: "GET", path: "/connector-settings", tier: "session" },
  { method: "GET", path: "/backup/status", tier: "session" },
  { method: "POST", path: "/connector-settings/:id/repin", tier: "session" },
  {
    method: "POST",
    path: "/connector-settings/:id/repin/decision",
    tier: "signed",
  },
  { method: "POST", path: "/connector-settings/:id/pin", tier: "session" },
  {
    method: "POST",
    path: "/connector-settings/:id/pin/decision",
    tier: "signed",
  },
  { method: "GET", path: "/passkeys", tier: "session" },
  { method: "GET", path: "/permissions", tier: "session" },
  { method: "GET", path: "/approvals/:id/history", tier: "session" },
  { method: "POST", path: "/approvals/:id/nonce", tier: "session" },
  { method: "POST", path: "/approvals/:id/decision", tier: "signed" },
  { method: "POST", path: "/approvals/:id/edit", tier: "session" },
  { method: "POST", path: "/executions/:id/undo", tier: "session" },
  { method: "POST", path: "/executions/:id/discard-draft", tier: "session" },
  { method: "GET", path: "/push/key", tier: "session" },
  { method: "GET", path: "/push/subscriptions", tier: "session" },
  { method: "POST", path: "/push/prepare", tier: "session" },
  { method: "POST", path: "/push/subscriptions", tier: "signed" },
  { method: "POST", path: "/push/:id/remove", tier: "session" },
  { method: "GET", path: "/file-roots", tier: "session" },
  { method: "POST", path: "/file-roots/prepare", tier: "session" },
  { method: "POST", path: "/file-roots/complete", tier: "signed" },
  { method: "GET", path: "/admin/stack", tier: "session" },
  { method: "GET", path: "/admin/doctor", tier: "session" },
  { method: "POST", path: "/admin/stack/start", tier: "elevated" },
  { method: "POST", path: "/admin/stack/stop", tier: "elevated" },
  { method: "POST", path: "/admin/stack/restart", tier: "elevated" },
  { method: "GET", path: "/admin/models", tier: "session" },
  { method: "POST", path: "/admin/models/:id/use", tier: "elevated" },
  { method: "POST", path: "/admin/models/:id/fetch", tier: "elevated" },
  { method: "GET", path: "/admin/login-item", tier: "session" },
  { method: "POST", path: "/admin/login-item", tier: "elevated" },
  { method: "POST", path: "/admin/enrolment-codes/prepare", tier: "session" },
  { method: "POST", path: "/admin/enrolment-codes", tier: "signed" },
  { method: "POST", path: "/admin/secrets/bridge/prepare", tier: "session" },
  { method: "POST", path: "/admin/secrets/bridge", tier: "signed" },
  {
    method: "POST",
    path: "/admin/secrets/bridge-pin/prepare",
    tier: "session",
  },
  { method: "POST", path: "/admin/secrets/bridge-pin", tier: "signed" },
  { method: "POST", path: "/admin/secrets/simplefin/prepare", tier: "session" },
  { method: "POST", path: "/admin/secrets/simplefin", tier: "signed" },
  { method: "POST", path: "/admin/connectors/:id/remove", tier: "elevated" },
  { method: "POST", path: "/admin/connectors/google/prepare", tier: "session" },
  { method: "POST", path: "/admin/connectors/google/start", tier: "signed" },
  // Google's redirect after consent: the single-use state it carries is the credential (#662).
  { method: "GET", path: "/connect/google/callback", tier: "public" },
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

function route(
  state: PhoneState,
  request: GateRequest,
  matched: Matched,
  now: Clock,
  elevations: Elevations,
  execute?: (id: string) => Promise<ExecutionResult>,
  executeUndo?: (id: string) => Promise<ExecutionResult>
): Reply | Promise<Reply> {
  const path: RoutePath = matched.route.path
  switch (path) {
    case "/passkey/status":
      return credentialStatus(state, request, now)
    case "/auth/login/options":
      return loginOptions(state, now)
    case "/auth/login":
      return loginRoute(state, request, now)
    case "/auth/jwt-key":
      return {
        status: 200,
        body: { publicKey: getWebSessionPublicKey(state.db) },
      }
    case "/auth/logout":
      return logoutRoute(state, request, elevations)
    case "/auth/step-up/options":
      return loginOptions(state, now)
    case "/auth/step-up":
      return request.method === "GET"
        ? stepUpStatus(state, request, elevations, now)
        : stepUpRoute(state, request, elevations, now)
    case "/passkey/enroll/options":
      return enrolOptions(state, request, now)
    case "/passkey/enroll":
      return enrolRoute(state, request, now)
    case "/passkey/recover/start":
      return recoverStartRoute(state, request, now)
    case "/passkey/recover/options":
      return recoverOptionsRoute(state, request, now)
    case "/passkey/recover/complete":
      return recoverCompleteRoute(state, request, now)
    case "/passkey/recover/cancel/prepare":
      return recoverCancelPrepareRoute(state, now)
    case "/passkey/recover/cancel":
      return recoverCancelRoute(state, request, now)
    case "/approvals": {
      const list: GatePendingIntentList = { intents: pendingIntents(state.db) }
      return { status: 200, body: list }
    }
    case "/audit":
      return auditPage(state, request)
    case "/audit/chain":
      return { status: 200, body: verifyChain(state.db) }
    case "/connector-settings":
      return connectorSettings(state, now)
    case "/backup/status":
      return backupStatusRoute(state, now)
    case "/connector-settings/:id/repin":
      return repinPrepare(state, request, matched.id)
    case "/connector-settings/:id/repin/decision":
      return repinDecision(state, request, matched.id)
    case "/connector-settings/:id/pin":
      return firstPinPrepare(state, request, matched.id)
    case "/connector-settings/:id/pin/decision":
      return firstPinDecision(state, request, matched.id)
    case "/passkeys":
      return passkeyList(state, request, now)
    case "/permissions":
      return permissionList(state)
    case "/approvals/:id/history":
      return history(state, matched.id)
    case "/approvals/:id/nonce":
      return prepared(state, issueNonce(state.db, matched.id))
    case "/approvals/:id/decision":
      return decision(state, request, matched.id, now, execute)
    case "/approvals/:id/edit":
      return edit(state, request, matched.id)
    case "/executions/:id/undo":
      return undo(state, request, matched.id, executeUndo)
    case "/executions/:id/discard-draft":
      return discardDraft(state, request, matched.id)
    case "/push/key":
      return state.push === undefined
        ? apiError(503, "unavailable", "push is not configured")
        : state.push
            .publicKey()
            .then((publicKey) => ({ status: 200, body: { publicKey } }))
    case "/push/subscriptions":
      return request.method === "GET"
        ? {
            status: 200,
            body: {
              subscriptions: pushSubscriptions(state.db).map(({ id }) => ({
                id,
              })),
            },
          }
        : registerPush(state, request)
    case "/push/prepare":
      return preparePush(state, request)
    case "/admin/enrolment-codes/prepare":
      return { status: 200, body: prepareEnrolmentCodeIssue(state.db) }
    case "/admin/enrolment-codes":
      return issueEnrolmentCodeRoute(state, request, now)
    case "/admin/secrets/bridge/prepare":
      return bridgeSecretPrepare(state, request)
    case "/admin/secrets/bridge":
      return bridgeSecretRoute(state, request, now)
    case "/admin/secrets/bridge-pin/prepare":
      return bridgePinPrepare(state, request)
    case "/admin/secrets/bridge-pin":
      return bridgePinRoute(state, request)
    case "/admin/secrets/simplefin/prepare":
      return prepareSimpleFin(state)
    case "/admin/secrets/simplefin":
      return simpleFinRoute(state, request, now)
    case "/admin/connectors/:id/remove":
      return removeConnectorSecrets(state, matched.id)
    case "/admin/connectors/google/prepare":
      return googlePrepareRoute(state, request)
    case "/admin/connectors/google/start":
      return googleStartRoute(state, request, now)
    case "/connect/google/callback":
      return state.google === undefined
        ? NO_GOOGLE()
        : googleCallback(state.google, request.query, () => now().getTime())
    case "/push/:id/remove":
      removePushSubscription(state.db, matched.id)
      return { status: 200, body: { id: matched.id } }
    case "/file-roots": {
      const roots: GateFileRoots = approvedFileRoots(state.db) ?? { roots: [] }
      return { status: 200, body: roots }
    }
    // Allowed folders (#574): the control socket's signed policy.set ceremony. The phone sends
    // only `{id, path, trashDir}` per root; the gate's own helper captures the canonical path and
    // identity, and only a fresh owner passkey assertion over them stores the roots.
    case "/file-roots/prepare":
      return prepareFileRootsRoute(request, state)
    case "/file-roots/complete":
      return completeFileRootsRoute(request, state)
    case "/admin/stack":
    case "/admin/doctor":
    case "/admin/stack/start":
    case "/admin/stack/stop":
    case "/admin/stack/restart":
    case "/admin/models":
    case "/admin/models/:id/use":
    case "/admin/models/:id/fetch":
    case "/admin/login-item":
      return adminRoute(state.supervisor, path, matched.id, request, jsonBody)
  }
}

export type PhoneOptions = {
  gate: () => PhoneState
  /** Every Host header answered; anything else gets 421. */
  allowedHosts: readonly string[]
  basePath: string
  now: Clock
  execute?: (id: string) => Promise<ExecutionResult>
  undo?: (id: string) => Promise<ExecutionResult>
}

/**
 * The reply that refuses a request for want of its route's tier, or undefined when the request
 * may go on. `signed` routes need the session here and verify their own assertion.
 */
export function tierRefusal(
  tier: RouteTier,
  path: string,
  db: DatabaseSync,
  elevations: Elevations,
  token: string | undefined,
  now: Clock
): Reply | undefined {
  if (tier === "public") return undefined
  if (sessionExpiry(db, token, now) === undefined) {
    return apiError(401, "unauthenticated", "sign in with your passkey")
  }
  if (tier === "elevated" && !useElevation(db, elevations, token, path, now)) {
    return apiError(403, "step_up_required", "confirm with your passkey")
  }
  return undefined
}

/** The phone listener's handler. */
/** The public routes that insert a row or take a credential per call, and so get an attempt limit. */
const RATE_LIMITED_PUBLIC: ReadonlySet<RoutePath> = new Set<RoutePath>([
  "/auth/login/options",
  "/auth/login",
  "/passkey/enroll/options",
  "/passkey/enroll",
  "/passkey/recover/start",
  "/passkey/recover/options",
  "/passkey/recover/complete",
])
export const PUBLIC_ATTEMPT_LIMIT = 30
export const PUBLIC_ATTEMPT_WINDOW_MS = 60_000

export function phoneHandler(options: PhoneOptions): Handler {
  const attempts: RateState = new Map()
  // In memory only, so a gate restart ends every step-up.
  const elevations: Elevations = new Map()
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
    if (
      matched.route.tier === "public" &&
      RATE_LIMITED_PUBLIC.has(matched.route.path) &&
      !allowAttempt(
        attempts,
        matched.route.path,
        options.now().getTime(),
        PUBLIC_ATTEMPT_LIMIT,
        PUBLIC_ATTEMPT_WINDOW_MS
      )
    ) {
      return apiError(429, "busy", "too many attempts; try again shortly")
    }
    const state = options.gate()
    const refusal = tierRefusal(
      matched.route.tier,
      matched.route.path,
      state.db,
      elevations,
      sessionToken(request.headers.cookie),
      options.now
    )
    if (refusal !== undefined) return refusal
    return route(
      state,
      request,
      matched,
      options.now,
      elevations,
      options.execute,
      options.undo
    )
  }
  return async (request) => {
    const reply = await answer(request)
    return { ...reply, headers: { ...reply.headers, ...NO_STORE } }
  }
}
