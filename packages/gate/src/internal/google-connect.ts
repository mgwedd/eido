import { randomBytes } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { validateGateGoogleConnectLocalRequest } from "@eido/schemas"
import type {
  GateConnectorHealth,
  GateGoogleConnectFlow,
  GateGoogleConnectPrepared,
  GateGoogleConnectStarted,
} from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import {
  authorizationUrl,
  DRIVE_READONLY_SCOPE,
  exchangeCode,
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  oauthState,
  pkcePair,
} from "./connect/oauth"
import { checkConnector } from "./connector-connect"
import type { ConnectorProbes } from "./connector-connect"
import {
  getConnectorHealth,
  recordConnectorAccountEmail,
} from "./connector-health"
import {
  controlApprovalChallenge,
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type { ControlAuthorization } from "./control-approvals"
import { apiError } from "./http"
import type { GateRequest, Reply } from "./http"
import type { Vault, VaultClient, VaultKey } from "./vault/vault"

// Google sign-in through the gate (#662, ADR 0009 decision 5). Google redirects to the gate's
// own callback on the tailnet name, so the same flow works from the phone, the Mac's browser and
// the `connect` command. A start is a signed control change on the phone listener (decision 7:
// connector add and reconnect) and a local request on the control socket. The gate keeps the
// PKCE verifier and the client secret in memory, under a random state, until the callback: each
// flow is single-use and expires. The refresh token and a new client secret go to the vault only
// after Google's answer checks out; none of them is sent back, logged or hashed into an audit row.

export const GOOGLE_TARGETS = {
  gmail: { connector: "gmail", client: "write", scope: GMAIL_MODIFY_SCOPE },
  "gmail-read": {
    connector: "gmail",
    client: "read",
    scope: GMAIL_READONLY_SCOPE,
  },
  drive: { connector: "drive", client: "read", scope: DRIVE_READONLY_SCOPE },
} as const satisfies Record<
  string,
  { connector: string; client: VaultClient; scope: string }
>
export type GoogleTarget = keyof typeof GOOGLE_TARGETS

/** How long a started sign-in may take before its state is refused. */
export const FLOW_TTL_MS = 10 * 60_000
/** At most this many sign-ins wait at once; a new one drops the oldest. */
const MAX_PENDING = 8
/** The callback path below the phone listener's base path. */
export const GOOGLE_CALLBACK_PATH = "/connect/google/callback"
/** Where the browser lands after the callback: the web Admin page's connectors list. */
const ADMIN_CONNECTORS_PATH = "/admin/connectors"

export type FlowFailure = NonNullable<GateGoogleConnectFlow["reason"]>

type Pending = {
  flow: string
  target: GoogleTarget
  verifier: string
  /** Only when the vault has none: sealed with the refresh token, after Google's answer. */
  clientSecret?: string
  expiresAt: number
}

type Outcome =
  | { status: "pending"; expiresAt: number }
  | { status: "connected"; health: GateConnectorHealth; expiresAt: number }
  | { status: "failed"; reason: FlowFailure; expiresAt: number }

/** The in-memory sign-ins: a gate restart ends every one. */
export class GoogleFlows {
  readonly #pending = new Map<string, Pending>()
  readonly #outcomes = new Map<string, Outcome>()
  readonly #ttlMs: number

  constructor(ttlMs: number = FLOW_TTL_MS) {
    this.#ttlMs = ttlMs
  }

  begin(
    target: GoogleTarget,
    clientSecret: string | undefined,
    now: number
  ): { state: string; flow: string; challenge: string } {
    this.#sweep(now)
    while (this.#pending.size >= MAX_PENDING) {
      const [oldest] = this.#pending.keys()
      if (oldest === undefined) break
      this.#drop(oldest)
    }
    const pkce = pkcePair()
    const state = oauthState()
    const flow = randomBytes(32).toString("base64url")
    const expiresAt = now + this.#ttlMs
    this.#pending.set(state, {
      flow,
      target,
      verifier: pkce.verifier,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      expiresAt,
    })
    this.#outcomes.set(flow, { status: "pending", expiresAt })
    return { state, flow, challenge: pkce.challenge }
  }

  /** Takes the flow for a state once: a second take, or one after expiry, finds nothing. */
  take(state: string, now: number): Pending | undefined {
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (pending === undefined) return undefined
    if (pending.expiresAt <= now) {
      this.#outcomes.delete(pending.flow)
      return undefined
    }
    return pending
  }

  finish(
    flow: string,
    outcome:
      | { status: "connected"; health: GateConnectorHealth }
      | { status: "failed"; reason: FlowFailure },
    now: number
  ): void {
    this.#outcomes.set(flow, { ...outcome, expiresAt: now + this.#ttlMs })
  }

  outcome(flow: string, now: number): GateGoogleConnectFlow | undefined {
    this.#sweep(now)
    const outcome = this.#outcomes.get(flow)
    if (outcome === undefined) return undefined
    switch (outcome.status) {
      case "pending":
        return { status: "pending" }
      case "connected":
        return { status: "connected", health: outcome.health }
      case "failed":
        return { status: "failed", reason: outcome.reason }
    }
  }

  #drop(state: string): void {
    const pending = this.#pending.get(state)
    this.#pending.delete(state)
    if (pending !== undefined) this.#outcomes.delete(pending.flow)
  }

  #sweep(now: number): void {
    for (const [state, pending] of this.#pending)
      if (pending.expiresAt <= now) this.#drop(state)
    for (const [flow, outcome] of this.#outcomes)
      if (outcome.expiresAt <= now) this.#outcomes.delete(flow)
  }
}

export type GoogleConnect = {
  db: DatabaseSync
  vault: Vault
  flows: GoogleFlows
  /** `https://<host>.ts.net:8443/api/gate/connect/google/callback`, registered with Google. */
  redirectUri: string
  /** The origin the browser returns to after the callback: the web app's. */
  webOrigin: string
  /** Each client's id; a target without one cannot start. */
  clientIds: Partial<Record<GoogleTarget, string>>
  probes?: ConnectorProbes
  fetch?: typeof fetch
}

const controlTarget = (target: GoogleTarget) => `connector_oauth:${target}`

const controlPayload = (target: GoogleTarget, clientId: string) => ({
  action: "connector.oauth.start",
  connector: GOOGLE_TARGETS[target].connector,
  client: GOOGLE_TARGETS[target].client,
  clientId,
})

const vaultKey = (target: GoogleTarget, kind: VaultKey["kind"]): VaultKey => ({
  connector: GOOGLE_TARGETS[target].connector,
  kind,
  client: GOOGLE_TARGETS[target].client,
})

const NO_CLIENT = () =>
  apiError(
    503,
    "unavailable",
    "the gate has no client id for this Google client"
  )
const SECRET_REQUIRED = () =>
  apiError(
    400,
    "client_secret_required",
    "the gate vault has no OAuth client secret for this client; give it with the request"
  )

function audit(
  db: DatabaseSync,
  action: string,
  target: GoogleTarget,
  detail: Record<string, string>
): number {
  return append(db, {
    actor: "owner",
    action,
    target: GOOGLE_TARGETS[target].connector,
    detailHash: payloadHash({ target, ...detail }),
  }).seq
}

export const SHARED_GOOGLE_SECRET_KEY: VaultKey = {
  connector: "google",
  kind: "api_key",
  client: "none",
}

export async function getClientSecret(
  google: GoogleConnect,
  target: GoogleTarget
): Promise<string | undefined> {
  const specific = await google.vault.get(vaultKey(target, "api_key"))
  if (specific !== undefined) return specific
  const targetClientId = google.clientIds[target]
  if (targetClientId === undefined) return undefined
  for (const other of Object.keys(GOOGLE_TARGETS) as GoogleTarget[]) {
    if (other === target) continue
    if (google.clientIds[other] === targetClientId) {
      const secret = await google.vault.get(vaultKey(other, "api_key"))
      if (secret !== undefined) return secret
    }
  }
  const shared = await google.vault.get(SHARED_GOOGLE_SECRET_KEY)
  if (shared !== undefined) return shared
  return undefined
}

async function secretStored(
  google: GoogleConnect,
  target: GoogleTarget
): Promise<boolean> {
  return (await getClientSecret(google, target)) !== undefined
}

/** POST /admin/connectors/google/prepare: the ceremony to sign, and whether a secret is needed. */
export async function prepareGoogleConnect(
  google: GoogleConnect,
  target: GoogleTarget
): Promise<Reply> {
  const clientId = google.clientIds[target]
  if (clientId === undefined) return NO_CLIENT()
  const prepared = prepareControlApproval(
    google.db,
    "policy.set",
    controlTarget(target),
    controlPayload(target, clientId)
  )
  const body: GateGoogleConnectPrepared = {
    approval: {
      ...prepared,
      purpose: "policy.set",
      challenge: controlApprovalChallenge(prepared),
    },
    clientSecretStored: await secretStored(google, target),
  }
  return { status: 200, body }
}

/** Starts a sign-in and replies with Google's consent address and the flow id. */
async function begin(
  google: GoogleConnect,
  target: GoogleTarget,
  clientSecret: string | undefined,
  now: number,
  authorize: (clientId: string) => void
): Promise<Reply> {
  const clientId = google.clientIds[target]
  if (clientId === undefined) return NO_CLIENT()
  // A stored secret wins: the request's copy is used only when the vault has none.
  const targetStored =
    (await google.vault.get(vaultKey(target, "api_key"))) !== undefined
  const stored = targetStored || (await secretStored(google, target))
  if (!stored && clientSecret === undefined) return SECRET_REQUIRED()
  try {
    authorize(clientId)
  } catch {
    return apiError(
      403,
      "verification_failed",
      "the passkey signature was refused"
    )
  }
  const started = google.flows.begin(
    target,
    targetStored ? undefined : clientSecret,
    now
  )
  const body: GateGoogleConnectStarted = {
    authorizationUrl: authorizationUrl({
      clientId,
      redirectUri: google.redirectUri,
      scope: GOOGLE_TARGETS[target].scope,
      state: started.state,
      challenge: started.challenge,
    }),
    flow: started.flow,
  }
  return { status: 200, body }
}

/** POST /admin/connectors/google/start: the signed start from the Admin page. */
export async function startGoogleConnect(
  google: GoogleConnect,
  input: {
    authorization: ControlAuthorization
    target: GoogleTarget
    clientSecret?: string
  },
  now: number
): Promise<Reply> {
  return begin(google, input.target, input.clientSecret, now, (clientId) => {
    withControlApproval(
      google.db,
      "policy.set",
      controlTarget(input.target),
      payloadHash(controlPayload(input.target, clientId)),
      input.authorization,
      () => ({
        result: undefined,
        auditSeq: audit(google.db, "connector.oauth.started", input.target, {
          via: "admin",
        }),
      })
    )
  })
}

/** POST /connect/google/start on the control socket: the `connect` command's start. */
export async function startLocalGoogleConnect(
  google: GoogleConnect,
  input: { target: GoogleTarget; clientSecret?: string },
  now: number
): Promise<Reply> {
  return begin(google, input.target, input.clientSecret, now, () => {
    audit(google.db, "connector.oauth.started", input.target, { via: "cli" })
  })
}

/** GET /connect/google/flows/{flow} on the control socket. */
export function googleFlowRoute(
  google: GoogleConnect,
  flow: string,
  now: number
): Reply {
  const outcome = google.flows.outcome(flow, now)
  return outcome === undefined
    ? apiError(404, "not_found", "no Google sign-in with that id is waiting")
    : { status: 200, body: outcome }
}

function backToAdmin(google: GoogleConnect, query: string): Reply {
  return {
    status: 303,
    body: {},
    headers: {
      location: `${google.webOrigin}${ADMIN_CONNECTORS_PATH}?${query}`,
    },
  }
}

const failed = (
  google: GoogleConnect,
  pending: Pending,
  reason: FlowFailure,
  now: number
): Reply => {
  google.flows.finish(pending.flow, { status: "failed", reason }, now)
  audit(google.db, "connector.oauth.failed", pending.target, { reason })
  return backToAdmin(
    google,
    new URLSearchParams({ google: pending.target, error: reason }).toString()
  )
}

const CODE = /^[\x21-\x7e]{1,2048}$/

/**
 * GET /connect/google/callback: Google's redirect. The state is the only credential, so an
 * unknown, used or expired state changes nothing. The browser always goes back to the Admin
 * page, with the target and the outcome in the query and never a token or the code.
 */
export async function googleCallback(
  google: GoogleConnect,
  query: URLSearchParams,
  now: () => number
): Promise<Reply> {
  const pending = google.flows.take(query.get("state") ?? "", now())
  if (pending === undefined) return backToAdmin(google, "error=expired")
  if (query.has("error")) return failed(google, pending, "denied", now())
  const code = query.get("code") ?? ""
  if (!CODE.test(code))
    return failed(google, pending, "invalid_callback", now())
  const clientId = google.clientIds[pending.target]
  const secret =
    pending.clientSecret ?? (await getClientSecret(google, pending.target))
  if (clientId === undefined || secret === undefined)
    return failed(google, pending, "token_endpoint_refused", now())
  const exchanged = await exchangeCode({
    fetch: google.fetch ?? fetch,
    clientId,
    clientSecret: secret,
    code,
    verifier: pending.verifier,
    redirectUri: google.redirectUri,
    scope: GOOGLE_TARGETS[pending.target].scope,
  })
  if (!exchanged.ok) return failed(google, pending, exchanged.reason, now())
  await google.vault.set(
    vaultKey(pending.target, "refresh_token"),
    exchanged.refreshToken
  )
  if (pending.clientSecret !== undefined) {
    await google.vault.set(
      vaultKey(pending.target, "api_key"),
      pending.clientSecret
    )
    await google.vault.set(SHARED_GOOGLE_SECRET_KEY, pending.clientSecret)
  } else if (
    (await google.vault.get(vaultKey(pending.target, "api_key"))) === undefined
  ) {
    await google.vault.set(vaultKey(pending.target, "api_key"), secret)
  }
  // A cached access token belongs to the old grant; the next call refreshes from the new one.
  await google.vault.delete(vaultKey(pending.target, "access_token"))
  audit(google.db, "connector.oauth.connected", pending.target, {
    secret: pending.clientSecret === undefined ? "kept" : "sealed",
  })
  const connector = GOOGLE_TARGETS[pending.target].connector
  recordConnectorAccountEmail(google.db, connector, null)
  const pinned = getConnectorHealth(google.db).some(
    ({ name }) => name === connector
  )
  if (pinned && google.probes?.[connector] !== undefined)
    await checkConnector(google.db, connector, google.probes, now)
  const health: GateConnectorHealth = {
    connectors: getConnectorHealth(google.db).filter(
      ({ name }) => name === connector
    ),
  }
  google.flows.finish(pending.flow, { status: "connected", health }, now())
  return backToAdmin(
    google,
    new URLSearchParams({
      google: pending.target,
      connected: health.connectors[0]?.health ?? "unpinned",
    }).toString()
  )
}

export const isGoogleTarget = (value: string): value is GoogleTarget =>
  Object.hasOwn(GOOGLE_TARGETS, value)

const FLOW_PATH = /^\/connect\/google\/flows\/([A-Za-z0-9_-]{43})$/

/**
 * The control socket's Google routes, or undefined when the request is another route:
 * POST /connect/google/start and GET /connect/google/flows/{flow}.
 */
export async function googleControlRoute(
  request: GateRequest,
  google: GoogleConnect | undefined,
  now: () => number
): Promise<Reply | undefined> {
  const start =
    request.method === "POST" && request.path === "/connect/google/start"
  const flow = request.method === "GET" ? FLOW_PATH.exec(request.path) : null
  if (!start && flow === null) return undefined
  if (google === undefined)
    return apiError(
      503,
      "unavailable",
      "Google sign-in is not configured on the gate"
    )
  if (flow !== null) return googleFlowRoute(google, flow[1] ?? "", now())
  const body = await request.body()
  if (!body.ok)
    return apiError(413, "invalid_request", "the body is over 1 MiB")
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    return apiError(400, "invalid_request", "the body is not valid JSON")
  }
  const checked = validateGateGoogleConnectLocalRequest(parsed)
  if (!checked.ok)
    return apiError(
      400,
      "invalid_request",
      `the body is not a Google sign-in request: ${(checked.errors[0] ?? "").slice(0, 200)}`
    )
  return startLocalGoogleConnect(
    google,
    {
      target: checked.value.target,
      ...(checked.value.clientSecret === undefined
        ? {}
        : { clientSecret: checked.value.clientSecret }),
    },
    now()
  )
}
