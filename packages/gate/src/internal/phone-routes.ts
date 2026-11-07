import type { DatabaseSync } from "node:sqlite"
import {
  INTENT_KINDS,
  gateAuditDisplayActor,
  validateGateAuditPageRequest,
  validateGateDecisionRequest,
  validateGateEditRequest,
  validateGateEnrolOptionsRequest,
  validateGateEnrolRequest,
  validateGateLoginRequest,
  validateGatePushRegistration,
  validateGateEnrolmentCodeRequest,
  validateGateBridgePasswordRequest,
  validateGateBridgePin,
  validateGateBridgePinRequest,
  validateGateSimpleFinSecretRequest,
  validateGateGoogleConnectRequest,
  validateGateGoogleConnectTarget,
  validateGateRepinRequest,
} from "@eido/schemas"
import type {
  GateAuditActor,
  GateAuditPage,
  GateConnectorSettings,
  GateCredentialStatus,
  GateEnrolmentCode,
  GateFileRoots,
  GateDecisionResult,
  GateEnrolOptions,
  GateIntentHistory,
  GateLoginOptions,
  GatePendingIntentList,
  GatePrepareApproval,
  GateSession,
  GatePasskeyList,
  GatePermissionList,
  GateRepinResult,
  GateUndoResult,
} from "@eido/schemas"
import { issueNonce, reject, verifyApproval } from "./approvals"
import type { PreparedApproval } from "./approvals"
import { adminRoute } from "./admin-routes"
import { apiError, NOT_FOUND } from "./http"
import type { GateRequest, Handler, Reply } from "./http"
import type { ExecutionResult } from "./executor"
import {
  approvalCard,
  decidePending,
  editIntent,
  intentHistory,
  intentSummary,
  pendingIntents,
} from "./intents"
import type { EditResult } from "./intents"
import type { Policy } from "./policy"
import { kindTier } from "./policy"
import { proposeDraftDiscard } from "./draft-discard"
import { verifyChain } from "./audit"
import {
  beginPhoneRegistration,
  enrolWithCode,
  listPasskeys,
} from "./credentials"
import { readBackupStatus } from "./backup-status"
import {
  checkEnrolmentCode,
  issueSignedEnrolmentCode,
  prepareEnrolmentCodeIssue,
} from "./enrolment"
import {
  prepareBridgeSecret,
  prepareBridgePin,
  prepareSimpleFin,
  removeConnectorSecrets,
  sealBridgeSecret,
  setBridgePin,
  setSimpleFin,
} from "./connector-secrets"
import type { ConnectorProbes } from "./connector-connect"
import type { Vault } from "./vault/vault"
import {
  googleCallback,
  prepareGoogleConnect,
  startGoogleConnect,
} from "./google-connect"
import type { GoogleConnect } from "./google-connect"
import { getConnectorHealth } from "./connector-health"
import { getConnectorState } from "./connectors"
import {
  applyFirstPin,
  applyRepin,
  prepareFirstPin,
  prepareRepin,
  unpinnedReviewed,
} from "./repin"
import {
  completeFileRootsRoute,
  prepareFileRootsRoute,
} from "./file-root-routes"
import { approvedFileRoots } from "./files/file-roots"
import type { FileHelper } from "./files/file-helper"
import type { FirstPinRefusal, RepinRefusal } from "./repin"
import {
  checkedSubscription,
  preparePushRegistration,
  pushSubscriptions,
  registerPushSubscription,
  removePushSubscription,
} from "./push-subscriptions"
import {
  beginLogin,
  hasCredential,
  onlyRevokedCredentials,
  login,
  sessionCookie,
  sessionCredential,
  elevatedUntil,
  stepUp,
  useElevation,
  sessionExpiry,
  sessionToken,
} from "./sessions"
import type { Clock, Elevations } from "./sessions"
import type { SupervisorClient } from "./supervisor-client"
import type { WebAuthnConfig } from "./webauthn"

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

export type PhoneState = {
  db: DatabaseSync
  policy: Policy
  webAuthn: WebAuthnConfig
  nudge?: { threshold: number; windowMs: number }
  push?: { publicKey: () => Promise<string>; notifyPending: () => void }
  backupStampPath?: string
  /** The owner's re-reviewed manifest for a drifted connector (#97); undefined when none is placed. */
  reviewedManifest?: (connector: string) => unknown
  /** The connector names with a reviewed manifest placed (#627); none when undefined. */
  reviewedManifests?: () => string[]
  /** The gate-side native helper that identifies a requested file root (#574); never the phone's. */
  fileHelper?: FileHelper
  /** The stack supervisor's socket client (#659); undefined when the gate runs outside the stack. */
  supervisor?: SupervisorClient
  /** The gate vault the Admin page's signed secret routes seal into (#661); undefined without one. */
  vault?: Vault
  /** The Bridge pin the gate runs with and its certificate file (#661); undefined without Bridge. */
  bridge?: { certificateSha256: string; certificatePath: string }
  /** Each connector's health probe, run after a new secret is sealed (#661). */
  probes?: ConnectorProbes
  /** How the gate claims a SimpleFIN access URL (#661); the global fetch by default. */
  fetch?: typeof fetch
  /** Google sign-in through the gate (#662); undefined without a vault and a redirect URI. */
  google?: GoogleConnect
}

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
  { method: "POST", path: "/auth/step-up/options", tier: "session" },
  { method: "POST", path: "/auth/step-up", tier: "session" },
  { method: "GET", path: "/auth/step-up", tier: "session" },
  { method: "POST", path: "/passkey/enroll/options", tier: "public" },
  { method: "POST", path: "/passkey/enroll", tier: "public" },
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
    revoked: onlyRevokedCredentials(state.db),
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

async function stepUpRoute(
  state: PhoneState,
  request: GateRequest,
  elevations: Elevations,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateLoginRequest(body.value)
  if (!checked.ok) return invalid("a step-up request", checked.errors)
  const result = stepUp(
    state.db,
    state.webAuthn,
    elevations,
    sessionToken(request.headers.cookie),
    checked.value.assertion,
    now
  )
  if (!result.ok) {
    return apiError(403, "verification_failed", "the step-up was refused")
  }
  const elevated: GateSession = { expiresAt: result.until.toISOString() }
  return { status: 200, body: elevated }
}

function stepUpStatus(
  state: PhoneState,
  request: GateRequest,
  elevations: Elevations,
  now: Clock
): Reply {
  const until = elevatedUntil(
    state.db,
    elevations,
    sessionToken(request.headers.cookie),
    now
  )
  return {
    status: 200,
    body: { expiresAt: until === undefined ? null : until.toISOString() },
  }
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

const ENROL_REFUSED = "the enrolment was refused"

async function enrolOptions(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateEnrolOptionsRequest(body.value)
  if (!checked.ok)
    return invalid("an enrolment options request", checked.errors)
  const code = checkEnrolmentCode(state.db, "phone", checked.value.code, now)
  if (!code.ok) return apiError(403, "verification_failed", ENROL_REFUSED)
  const options: GateEnrolOptions = {
    challenge: beginPhoneRegistration(state.db, now),
    rpId: state.webAuthn.rpId,
    expiresAt: code.expiresAt.toISOString(),
  }
  return { status: 200, body: options }
}

async function enrolRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateEnrolRequest(body.value)
  if (!checked.ok) return invalid("an enrolment request", checked.errors)
  const result = enrolWithCode(
    state.db,
    state.webAuthn,
    checked.value.code,
    checked.value.registration,
    now
  )
  if (!result.ok) return apiError(403, "verification_failed", ENROL_REFUSED)
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
    ...(card.injection === null ? {} : { injection: card.injection }),
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

function auditActor(value: string): GateAuditActor {
  switch (value) {
    case "data-plane":
    case "policy":
    case "approver":
    case "executor":
    case "system":
    case "owner":
    case "gate":
      return value
    default:
      throw new Error("stored audit actor is not recognized")
  }
}

function auditPage(state: PhoneState, request: GateRequest): Reply {
  const raw: Record<string, unknown> = {}
  for (const key of new Set([...request.query.keys()])) {
    if (
      (key !== "before" && key !== "limit") ||
      request.query.getAll(key).length !== 1
    ) {
      return apiError(400, "invalid_request", "invalid audit page query")
    }
    const value = request.query.get(key)
    if (value === null || !/^\d+$/.test(value)) {
      return apiError(400, "invalid_request", "invalid audit page query")
    }
    raw[key] = Number(value)
  }
  const checked = validateGateAuditPageRequest(raw)
  if (!checked.ok) {
    return apiError(
      400,
      "invalid_request",
      checked.errors[0] ?? "invalid audit page query"
    )
  }
  const { before, limit = 50 } = checked.value
  const columns = `SELECT a.seq, a.ts, a.actor, a.action, a.target, a.detail_hash,
      EXISTS (
        SELECT 1 FROM approvals p
        JOIN approval_nonces n ON n.nonce = p.nonce AND n.intent_id = p.intent_id
        JOIN credentials c ON c.credential_id = p.credential_id
        JOIN intents i ON i.id = p.intent_id
        WHERE p.intent_id = a.target AND p.decision = 'approved'
          AND p.signature IS NOT NULL AND p.bundle_hash = i.payload_hash
          AND n.used_at IS NOT NULL
          AND (c.revoked_at IS NULL OR c.revoked_at >= p.decided_at)
          AND p.decided_at <= a.ts
      ) AS approved,
      CASE WHEN e.audit_seq = a.seq THEN
        CASE WHEN u.intent_id IS NOT NULL THEN 'done'
             WHEN e.inverse_op IS NOT NULL AND (i.tier = 'auto' OR (i.kind = 'file.delete' AND i.tier = 'approval')) THEN 'available'
             ELSE 'none' END
      ELSE 'none' END AS undo
    FROM audit_log a
    LEFT JOIN executions e ON e.audit_seq = a.seq
    LEFT JOIN execution_undos u ON u.intent_id = e.intent_id
    LEFT JOIN intents i ON i.id = e.intent_id`
  const selected =
    before === undefined
      ? state.db
          .prepare(`${columns} ORDER BY a.seq DESC LIMIT ?`)
          .all(limit + 1)
      : state.db
          .prepare(`${columns} WHERE a.seq < ? ORDER BY a.seq DESC LIMIT ?`)
          .all(before, limit + 1)
  const hasMore = selected.length > limit
  const pageRows = selected.slice(0, limit)
  const entries: GateAuditPage["entries"] = pageRows.map((row) => {
    const actor = auditActor(String(row["actor"]))
    const approved = Number(row["approved"]) === 1
    const undo = row["undo"]
    if (undo !== "available" && undo !== "done" && undo !== "none") {
      throw new Error("stored undo state is not recognized")
    }
    return {
      seq: Number(row["seq"]),
      ts: String(row["ts"]),
      actor,
      displayActor: gateAuditDisplayActor(actor, approved),
      action: String(row["action"]),
      target: String(row["target"]),
      detailHash: String(row["detail_hash"]),
      undo,
    }
  })
  const lastEntry = entries.at(-1)
  const body: GateAuditPage = {
    entries,
    ...(hasMore && lastEntry !== undefined
      ? { nextBefore: lastEntry.seq }
      : {}),
  }
  return { status: 200, body }
}

function connectorSettings(state: PhoneState, now: Clock): Reply {
  const health = new Map(
    getConnectorHealth(state.db).map((connector) => [connector.name, connector])
  )
  const connectors: GateConnectorSettings["connectors"] = state.db
    .prepare(
      "SELECT name, pinned_at, manifest_hash, last_success_at FROM connectors ORDER BY name"
    )
    .all()
    .map((row) => {
      const name = String(row["name"])
      const stored = getConnectorState(state.db, name)
      const current = health.get(name)
      if (stored === undefined || current === undefined) {
        throw new Error("stored connector state is incomplete")
      }
      return {
        name,
        enabled: stored.enabled,
        pinnedAt: String(row["pinned_at"]),
        scopes: [...stored.manifest.auth.scopes],
        health: current.health,
        consecutiveFailures: current.consecutiveFailures,
        ...(current.lastError === undefined
          ? {}
          : { lastError: current.lastError }),
        ...(current.nextAttemptAt === undefined
          ? {}
          : { nextAttemptAt: current.nextAttemptAt }),
        ...(typeof row["last_success_at"] === "string"
          ? { lastSuccessAt: row["last_success_at"] }
          : {}),
        manifestHash: String(row["manifest_hash"]),
        ...(name === "gmail"
          ? {
              clientIdConfigured: state.google?.clientIds.gmail !== undefined,
            }
          : name === "drive"
            ? {
                clientIdConfigured: state.google?.clientIds.drive !== undefined,
              }
            : {}),
        ...(stored.drift === null || stored.enabled
          ? {}
          : {
              drift: {
                added: [...stored.drift.added],
                removed: [...stored.drift.removed],
              },
            }),
      }
    })
  const unpinned = unpinnedReviewed(state.db, placedManifests(state), (name) =>
    reviewedManifest(state, name)
  ).slice(0, 50)
  const googleRedirectUri = state.google?.redirectUri
  const googleTargets: GateConnectorSettings["googleTargets"] =
    state.google === undefined
      ? undefined
      : {
          gmail: {
            clientIdConfigured: state.google.clientIds.gmail !== undefined,
          },
          "gmail-read": {
            clientIdConfigured:
              state.google.clientIds["gmail-read"] !== undefined,
          },
          drive: {
            clientIdConfigured: state.google.clientIds.drive !== undefined,
          },
        }
  const body: GateConnectorSettings = {
    connectors,
    ...(unpinned.length === 0 ? {} : { unpinned }),
    asOf: now().toISOString(),
    ...(googleRedirectUri === undefined ? {} : { googleRedirectUri }),
    ...(googleTargets === undefined ? {} : { googleTargets }),
  }
  return { status: 200, body }
}

function backupStatusRoute(state: PhoneState, now: Clock): Reply {
  const body = readBackupStatus(state.backupStampPath, now)
  return { status: 200, body }
}

const REPIN_REFUSALS = {
  not_found: [404, "not_found", "no such connector"],
  not_drifted: [409, "unavailable", "the connector is not disabled for drift"],
  no_reviewed_manifest: [
    409,
    "unavailable",
    "no reviewed manifest is placed for this connector",
  ],
  invalid_manifest: [
    422,
    "invalid_request",
    "the reviewed manifest cannot replace the pin",
  ],
  mismatch: [
    409,
    "unavailable",
    "the reviewed manifest does not match the tools the server reports",
  ],
} as const satisfies Record<
  RepinRefusal,
  readonly [number, Parameters<typeof apiError>[1], string]
>

const FIRST_PIN_REFUSALS = {
  already_pinned: [409, "unavailable", "the connector is already pinned"],
  no_reviewed_manifest: REPIN_REFUSALS.no_reviewed_manifest,
  invalid_manifest: [
    422,
    "invalid_request",
    "the reviewed manifest cannot be pinned",
  ],
} as const satisfies Record<
  FirstPinRefusal,
  readonly [number, Parameters<typeof apiError>[1], string]
>

function placedManifests(state: PhoneState): string[] {
  try {
    return state.reviewedManifests?.() ?? []
  } catch {
    return []
  }
}

function reviewedManifest(state: PhoneState, connector: string): unknown {
  try {
    return state.reviewedManifest?.(connector)
  } catch {
    return undefined
  }
}

async function repinPrepare(
  state: PhoneState,
  request: GateRequest,
  connector: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0
  )
    return invalid("an empty re-pin request", ["expected an empty object"])
  const result = prepareRepin(
    state.db,
    connector,
    reviewedManifest(state, connector)
  )
  if (!result.ok) {
    const [status, code, message] = REPIN_REFUSALS[result.code]
    return apiError(status, code, message)
  }
  return { status: 200, body: result.prepared }
}

async function repinDecision(
  state: PhoneState,
  request: GateRequest,
  connector: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateRepinRequest(body.value)
  if (!checked.ok) return invalid("a re-pin request", checked.errors)
  const result = applyRepin(
    state.db,
    connector,
    reviewedManifest(state, connector),
    { config: state.webAuthn, request: checked.value }
  )
  if (!result.ok) {
    if (result.code === "refused")
      return apiError(403, "verification_failed", "the re-pin was refused")
    const [status, code, message] = REPIN_REFUSALS[result.code]
    return apiError(status, code, message)
  }
  const done: GateRepinResult = { connector, manifestHash: result.manifestHash }
  return { status: 200, body: done }
}

async function firstPinPrepare(
  state: PhoneState,
  request: GateRequest,
  connector: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0
  )
    return invalid("an empty pin request", ["expected an empty object"])
  const result = prepareFirstPin(
    state.db,
    connector,
    reviewedManifest(state, connector)
  )
  if (!result.ok) {
    const [status, code, message] = FIRST_PIN_REFUSALS[result.code]
    return apiError(status, code, message)
  }
  return { status: 200, body: result.prepared }
}

async function firstPinDecision(
  state: PhoneState,
  request: GateRequest,
  connector: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateRepinRequest(body.value)
  if (!checked.ok) return invalid("a pin request", checked.errors)
  const result = applyFirstPin(
    state.db,
    connector,
    reviewedManifest(state, connector),
    { config: state.webAuthn, request: checked.value }
  )
  if (!result.ok) {
    if (result.code === "refused")
      return apiError(403, "verification_failed", "the pin was refused")
    const [status, code, message] = FIRST_PIN_REFUSALS[result.code]
    return apiError(status, code, message)
  }
  const done: GateRepinResult = { connector, manifestHash: result.manifestHash }
  return { status: 200, body: done }
}

function passkeyList(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Reply {
  const current = sessionCredential(
    state.db,
    sessionToken(request.headers.cookie),
    now
  )
  const body: GatePasskeyList = { passkeys: listPasskeys(state.db, current) }
  return { status: 200, body }
}

function permissionList(state: PhoneState): Reply {
  const tiers: GatePermissionList["tiers"] = INTENT_KINDS.map((kind) => {
    const decision = kindTier(state.db, state.policy, kind)
    const override = state.policy.overlay?.tiers[kind]
    const configured = {
      kind,
      default: state.policy.shipped.tiers[kind] ?? null,
      ...(override === undefined ? {} : { override }),
    }
    return decision.tier === "forbidden"
      ? { ...configured, tier: decision.tier, reason: decision.reason }
      : { ...configured, tier: decision.tier }
  })
  const body: GatePermissionList = {
    tiers,
    forbiddenKinds: tiers
      .filter((entry) => entry.tier === "forbidden")
      .map((entry) => entry.kind),
  }
  return { status: 200, body }
}

async function decision(
  state: PhoneState,
  request: GateRequest,
  id: string,
  now: Clock,
  execute?: (id: string) => Promise<ExecutionResult>
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
    const row = state.db
      .prepare("SELECT kind, state FROM intents WHERE id = ?")
      .get(id)
    if (row === undefined) {
      return apiError(404, "not_found", "no such intent")
    }
    if (row["state"] !== "pending") {
      return apiError(409, "already_decided", "the intent is no longer pending")
    }
    if (row["kind"] === "confirm.field") {
      const decidedHash = decidePending(state.db, id, "approved", "approver")
      if (decidedHash === undefined) {
        return apiError(
          409,
          "already_decided",
          "the intent is no longer pending"
        )
      }
      const approved: GateDecisionResult = {
        intentId: id,
        state: "approved",
        nudge: false,
      }
      return { status: 200, body: approved }
    }
    if (!("assertion" in decided) || !("nonce" in decided)) {
      return apiError(403, "verification_failed", "the approval was refused")
    }
    const result = verifyApproval(
      state.db,
      state.webAuthn,
      {
        intentId: id,
        nonce: decided.nonce,
        assertion: decided.assertion,
      },
      {
        now,
        threshold: state.nudge?.threshold,
        windowMs: state.nudge?.windowMs,
      }
    )
    if (!result.ok) {
      return apiError(403, "verification_failed", "the approval was refused")
    }
    if (execute !== undefined) await execute(id)
    const approved: GateDecisionResult = {
      intentId: id,
      state: "approved",
      nudge: result.nudge,
    }
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
  state.push?.notifyPending()
  return prepared(state, issueNonce(state.db, result.intentId))
}

const undoInFlight = new WeakMap<DatabaseSync, Set<string>>()

async function discardDraft(
  state: PhoneState,
  request: GateRequest,
  id: string
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0 ||
    id.length > 64
  )
    return apiError(
      400,
      "invalid_request",
      "expected an execution id and an empty object"
    )
  const proposed = proposeDraftDiscard(state.db, state.policy, id)
  if (proposed === undefined)
    return apiError(
      409,
      "unavailable",
      "this draft cannot be proposed for discard"
    )
  state.push?.notifyPending()
  return { status: 201, body: proposed }
}

async function undo(
  state: PhoneState,
  request: GateRequest,
  id: string,
  executeUndo?: (id: string) => Promise<ExecutionResult>
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  if (
    typeof body.value !== "object" ||
    body.value === null ||
    Array.isArray(body.value) ||
    Object.keys(body.value).length !== 0
  ) {
    return invalid("an empty undo request", ["expected an empty object"])
  }
  if (id.length > 64) {
    return apiError(400, "invalid_request", "the execution id is invalid")
  }
  if (executeUndo === undefined) {
    return apiError(503, "unavailable", "undo is not configured")
  }
  const activeUndos = undoInFlight.get(state.db)
  if (activeUndos?.has(id)) {
    return apiError(
      409,
      "already_decided",
      "this execution is already being undone"
    )
  }
  if (
    state.db
      .prepare("SELECT 1 FROM execution_undos WHERE intent_id=?")
      .get(id) !== undefined
  ) {
    return apiError(
      409,
      "already_decided",
      "this execution has already been undone"
    )
  }
  const undos = activeUndos ?? new Set<string>()
  if (activeUndos === undefined) undoInFlight.set(state.db, undos)
  undos.add(id)
  try {
    const result = await executeUndo(id)
    if (result.ok) {
      const response: GateUndoResult = { id, undone: true }
      return { status: 200, body: response }
    }
    if (result.code === "not_found") {
      return apiError(404, "not_found", "no such execution")
    }
    if (
      result.code === "upstream_error" ||
      result.code === "connector_unavailable" ||
      result.code === "connector_misconfigured" ||
      result.code === "unknown_writer" ||
      result.code === "changed_during_execution"
    ) {
      return apiError(503, "unavailable", "undo could not be completed")
    }
    return apiError(409, "already_decided", "this execution cannot be undone")
  } catch {
    return apiError(503, "unavailable", "undo could not be completed")
  } finally {
    undos.delete(id)
    if (undos.size === 0) undoInFlight.delete(state.db)
  }
}

async function preparePush(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  if (state.push === undefined)
    return apiError(503, "unavailable", "push is not configured")
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  try {
    checkedSubscription(body.value)
    return { status: 200, body: preparePushRegistration(state.db, body.value) }
  } catch {
    return apiError(400, "invalid_request", "invalid push subscription")
  }
}

async function registerPush(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  if (state.push === undefined)
    return apiError(503, "unavailable", "push is not configured")
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGatePushRegistration(body.value)
  if (!checked.ok) return invalid("a push registration", checked.errors)
  try {
    const id = registerPushSubscription(state.db, checked.value.subscription, {
      config: state.webAuthn,
      request: checked.value.approval,
    })
    return { status: 201, body: { id } }
  } catch {
    return apiError(403, "verification_failed", "push registration refused")
  }
}

// Adding a device adds an approver, so the web Admin page issues a code only with the owner's
// passkey over the prepared ceremony (#660). The code is in this one response and nowhere else.
async function issueEnrolmentCodeRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateEnrolmentCodeRequest(body.value)
  if (!checked.ok) return invalid("an enrolment code request", checked.errors)
  try {
    const issued = issueSignedEnrolmentCode(
      state.db,
      { config: state.webAuthn, request: checked.value.approval },
      now
    )
    const reply: GateEnrolmentCode = {
      code: issued.code,
      expiresAt: issued.expiresAt.toISOString(),
    }
    return { status: 201, body: reply }
  } catch {
    return apiError(403, "verification_failed", "enrolment code refused")
  }
}

// Connector secrets from the Admin page (#661): see connector-secrets.ts. Each body is parsed
// with its schema; the secret goes on to the vault and is never part of a reply.
async function bridgeSecretPrepare(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePin(body.value)
  if (!checked.ok) return invalid("a Bridge pin", checked.errors)
  return prepareBridgeSecret(state, checked.value.certificateSha256)
}

async function bridgeSecretRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePasswordRequest(body.value)
  if (!checked.ok) return invalid("a Bridge password request", checked.errors)
  return sealBridgeSecret(
    state,
    {
      authorization: {
        config: state.webAuthn,
        request: checked.value.approval,
      },
      certificateSha256: checked.value.certificateSha256,
      password: checked.value.password,
    },
    () => now().getTime()
  )
}

async function bridgePinPrepare(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePin(body.value)
  if (!checked.ok) return invalid("a Bridge pin", checked.errors)
  return prepareBridgePin(state, checked.value.certificateSha256)
}

async function bridgePinRoute(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateBridgePinRequest(body.value)
  if (!checked.ok) return invalid("a Bridge pin request", checked.errors)
  return setBridgePin(state, {
    authorization: { config: state.webAuthn, request: checked.value.approval },
    certificateSha256: checked.value.certificateSha256,
  })
}

async function simpleFinRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateSimpleFinSecretRequest(body.value)
  if (!checked.ok) return invalid("a SimpleFIN setup request", checked.errors)
  return setSimpleFin(
    state,
    {
      authorization: {
        config: state.webAuthn,
        request: checked.value.approval,
      },
      setupToken: checked.value.setupToken,
    },
    () => now().getTime()
  )
}

const NO_GOOGLE = () =>
  apiError(503, "unavailable", "Google sign-in is not configured on the gate")

async function googlePrepareRoute(
  state: PhoneState,
  request: GateRequest
): Promise<Reply> {
  if (state.google === undefined) return NO_GOOGLE()
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateGoogleConnectTarget(body.value)
  if (!checked.ok) return invalid("a Google client", checked.errors)
  return prepareGoogleConnect(state.google, checked.value.target)
}

async function googleStartRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  if (state.google === undefined) return NO_GOOGLE()
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateGoogleConnectRequest(body.value)
  if (!checked.ok) return invalid("a Google sign-in request", checked.errors)
  return startGoogleConnect(
    state.google,
    {
      authorization: {
        config: state.webAuthn,
        request: checked.value.approval,
      },
      target: checked.value.target,
      ...(checked.value.clientSecret === undefined
        ? {}
        : { clientSecret: checked.value.clientSecret }),
    },
    now().getTime()
  )
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

const NO_STORE = { "cache-control": "no-store" } as const

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
export function phoneHandler(options: PhoneOptions): Handler {
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
