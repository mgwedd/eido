import { validateGateLoginRequest } from "@eido/schemas"
import type {
  GateCredentialStatus,
  GateRecoveryWindow,
  GateLoginOptions,
  GateSession,
} from "@eido/schemas"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import { pendingRecoveryWindow } from "../recovery"
import {
  beginLogin,
  clearGateSessionCookie,
  clearWebSessionCookie,
  elevatedUntil,
  getOrCreateWebSessionKeys,
  hasCredential,
  login,
  logoutSession,
  onlyRevokedCredentials,
  sessionCookie,
  sessionExpiry,
  sessionToken,
  stepUp,
  webSessionCookie,
} from "../sessions"
import type { Clock, Elevations } from "../sessions"
import { jsonBody, invalid } from "./shared"
import type { PhoneState } from "./types"

export function credentialStatus(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Reply {
  const expiry = sessionExpiry(
    state.db,
    sessionToken(request.headers.cookie),
    now
  )
  const recovery: GateRecoveryWindow | undefined = pendingRecoveryWindow(
    state.db,
    now
  )
  const status: GateCredentialStatus = {
    enrolled: hasCredential(state.db),
    revoked: onlyRevokedCredentials(state.db),
    sessionExpiresAt: expiry === undefined ? null : expiry.toISOString(),
    ...(recovery === undefined ? {} : { recovery }),
  }
  return { status: 200, body: status }
}

export function loginOptions(state: PhoneState, now: Clock): Reply {
  const { challenge, expiresAt } = beginLogin(state.db, now)
  const options: GateLoginOptions = {
    challenge,
    rpId: state.webAuthn.rpId,
    expiresAt: expiresAt.toISOString(),
  }
  return { status: 200, body: options }
}

export async function stepUpRoute(
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

export function stepUpStatus(
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

export async function loginRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateLoginRequest(body.value)
  if (!checked.ok) return invalid("a login request", checked.errors)
  const keys = state.webSessionKeyPair ?? getOrCreateWebSessionKeys(state.db)
  const result = login(
    state.db,
    state.webAuthn,
    checked.value.assertion,
    now,
    keys
  )
  if (!result.ok) {
    return apiError(403, "verification_failed", "the login was refused")
  }
  const session: GateSession = { expiresAt: result.expiresAt.toISOString() }
  return {
    status: 200,
    body: session,
    headers: {
      "set-cookie": [
        sessionCookie(result.token),
        webSessionCookie(result.webSessionToken),
      ],
    },
  }
}

export async function logoutRoute(
  state: PhoneState,
  request: GateRequest,
  elevations: Elevations
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const token = sessionToken(request.headers.cookie)
  if (token !== undefined) {
    logoutSession(state.db, elevations, token)
  }
  return {
    status: 200,
    body: { ok: true },
    headers: {
      "set-cookie": [clearGateSessionCookie(), clearWebSessionCookie()],
    },
  }
}
