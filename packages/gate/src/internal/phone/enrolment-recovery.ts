import {
  validateGateEnrolOptionsRequest,
  validateGateEnrolRequest,
  validateGateRecoveryCancelRequest,
  validateGateRecoveryCompleteRequest,
  validateGateRecoveryKeyRequest,
  validateGateEnrolmentCodeRequest,
} from "@eido/schemas"
import type {
  GateEnrolmentCode,
  GateEnrolOptions,
  GateEnrolled,
  GateRecoveryCancelPrepared,
  GateRecoveryKey,
  GateRecoveryCompleted,
} from "@eido/schemas"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import {
  beginPhoneRegistration,
  enrolWithCode,
  recoverWithKey,
} from "../credentials"
import {
  cancelRecovery,
  checkRecoveryReady,
  prepareRecoveryCancel,
  startRecovery,
} from "../recovery"
import { checkEnrolmentCode, issueSignedEnrolmentCode } from "../enrolment"
import {
  getOrCreateWebSessionKeys,
  sessionCookie,
  webSessionCookie,
} from "../sessions"
import type { Clock } from "../sessions"
import { jsonBody, invalid } from "./shared"
import type { PhoneState } from "./types"

const ENROL_REFUSED = "the enrolment was refused"

export async function enrolOptions(
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

export async function enrolRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateEnrolRequest(body.value)
  if (!checked.ok) return invalid("an enrolment request", checked.errors)
  const keys = state.webSessionKeyPair ?? getOrCreateWebSessionKeys(state.db)
  const result = enrolWithCode(
    state.db,
    state.webAuthn,
    checked.value.code,
    checked.value.registration,
    now,
    keys
  )
  if (!result.ok) return apiError(403, "verification_failed", ENROL_REFUSED)
  const enrolled: GateEnrolled = {
    expiresAt: result.expiresAt.toISOString(),
    ...(result.recoveryKey === undefined
      ? {}
      : { recoveryKey: result.recoveryKey }),
  }
  return {
    status: 200,
    body: enrolled,
    headers: {
      "set-cookie": [
        sessionCookie(result.token),
        webSessionCookie(result.webSessionToken),
      ],
    },
  }
}

const RECOVERY_REFUSED = "the recovery was refused"

// Passkey recovery with the owner's recovery key (issue 682). A refusal is one generic 403 so the
// reply never says whether the key was wrong, consumed, superseded, early or late; the audit log
// holds the outcome.
export async function recoverStartRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateRecoveryKeyRequest(body.value)
  if (!checked.ok) return invalid("a recovery start request", checked.errors)
  const started = startRecovery(state.db, checked.value.recoveryKey, now)
  if (!started.ok) return apiError(403, "verification_failed", RECOVERY_REFUSED)
  // Fire and forget: the alert must not hold up, or fail, the reply.
  void state.push?.notifyRecovery().catch(() => undefined)
  return { status: 200, body: started.window }
}

export async function recoverOptionsRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateRecoveryKeyRequest(body.value)
  if (!checked.ok) return invalid("a recovery options request", checked.errors)
  const ready = checkRecoveryReady(state.db, checked.value.recoveryKey, now)
  if (!ready.ok) return apiError(403, "verification_failed", RECOVERY_REFUSED)
  const options: GateEnrolOptions = {
    challenge: beginPhoneRegistration(state.db, now),
    rpId: state.webAuthn.rpId,
    expiresAt: ready.expiresAt.toISOString(),
  }
  return { status: 200, body: options }
}

export async function recoverCompleteRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateRecoveryCompleteRequest(body.value)
  if (!checked.ok) return invalid("a recovery request", checked.errors)
  const keys = state.webSessionKeyPair ?? getOrCreateWebSessionKeys(state.db)
  const result = recoverWithKey(
    state.db,
    state.webAuthn,
    checked.value.recoveryKey,
    checked.value.registration,
    now,
    keys
  )
  if (!result.ok) return apiError(403, "verification_failed", RECOVERY_REFUSED)
  const completed: GateRecoveryCompleted = {
    expiresAt: result.expiresAt.toISOString(),
    recoveryKey: result.recoveryKey,
  }
  return {
    status: 200,
    body: completed,
    headers: {
      "set-cookie": [
        sessionCookie(result.token),
        webSessionCookie(result.webSessionToken),
      ],
    },
  }
}

export function recoverCancelPrepareRoute(
  state: PhoneState,
  now: Clock
): Reply {
  const prepared = prepareRecoveryCancel(state.db, now)
  if (prepared === undefined)
    return apiError(404, "not_found", "no recovery is pending")
  const body: GateRecoveryCancelPrepared = {
    id: prepared.id,
    purpose: "policy.set",
    target: "recovery_key",
    payload: prepared.payload,
    payloadHash: prepared.payloadHash,
    nonce: prepared.nonce,
    challenge: prepared.challenge,
  }
  return { status: 200, body }
}

// Any unrevoked passkey cancels with its own signed assertion over the prepared ceremony. The
// replacement key is in this one response and nowhere else.
export async function recoverCancelRoute(
  state: PhoneState,
  request: GateRequest,
  now: Clock
): Promise<Reply> {
  const body = await jsonBody(request)
  if (!body.ok) return body.reply
  const checked = validateGateRecoveryCancelRequest(body.value)
  if (!checked.ok) return invalid("a recovery cancel request", checked.errors)
  try {
    const recoveryKey = cancelRecovery(
      state.db,
      { config: state.webAuthn, request: checked.value.approval },
      now
    )
    const reply: GateRecoveryKey = { recoveryKey }
    return { status: 200, body: reply }
  } catch {
    return apiError(403, "verification_failed", "recovery cancel refused")
  }
}

// Adding a device adds an approver, so the web Admin page issues a code only with the owner's
// passkey over the prepared ceremony (#660). The code is in this one response and nowhere else.
export async function issueEnrolmentCodeRoute(
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
