import {
  validateGateEnrolOptions,
  validateGateRecoveryCancelPrepared,
  validateGateRecoveryCompleted,
  validateGateRecoveryKey,
  validateGateRecoveryKeyRequest,
  validateGateRecoveryWindow,
  type GateRecoveryCancelPrepared,
  type GateRecoveryCancelRequest,
  type GateRecoveryCompleteRequest,
  type GateRecoveryKeyRequest,
  type GateRecoveryWindow,
} from "@eido/schemas"
import { fromBase64url, toBase64url } from "@/lib/approval/challenge"
import { hashPayloadText } from "@/lib/approval/canonical"
import { toAssertion } from "@/lib/approval/sign"
import { creationOptions, toRegistration } from "@/lib/enrol"

const GATE_URL = "/api/gate"

/** How often the pending page asks the gate whether the recovery still stands. */
export const RECOVERY_POLL_MS = 30_000
/** The gate counts public attempts in one-minute windows; a 429 lifts after one. */
export const RATE_LIMIT_COOLDOWN_MS = 60_000

/** The file the recovery key is saved to. */
export const RECOVERY_KEY_FILE = "eido-recovery-key.txt"

const MINUTE_MS = 60_000

/** Where a recovery stands at `nowMs`: waiting out the delay, ready to complete, or ran out. */
export type RecoveryPhase = "pending" | "matured" | "expired"

export function recoveryPhase(
  window: GateRecoveryWindow,
  nowMs: number
): RecoveryPhase {
  if (nowMs >= Date.parse(window.expiresAt)) return "expired"
  return nowMs >= Date.parse(window.maturesAt) ? "matured" : "pending"
}

/** Time left until `maturesAt`, in whole hours and minutes, rounded up: "23h 41m", "9m". */
export function formatCountdown(window: GateRecoveryWindow, nowMs: number) {
  const left = Math.max(0, Date.parse(window.maturesAt) - nowMs)
  const minutes = Math.ceil(left / MINUTE_MS)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** Time until `maturesAt` for a Settings line: whole hours while an hour or more is left, else minutes rounded up: "23h", "41m". */
export function formatMaturesIn(window: GateRecoveryWindow, nowMs: number) {
  const left = Math.max(0, Date.parse(window.maturesAt) - nowMs)
  const hours = Math.floor(left / (60 * MINUTE_MS))
  return hours > 0 ? `${hours}h` : `${Math.ceil(left / MINUTE_MS)}m`
}

/** Time since the recovery started as "HH:MM", for "Started 00:19 ago". */
export function formatElapsed(window: GateRecoveryWindow, nowMs: number) {
  const gone = Math.max(0, nowMs - Date.parse(window.startedAt))
  const minutes = Math.floor(gone / MINUTE_MS)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** How far through the delay, as a percentage from 0 to 100. */
export function delayProgress(window: GateRecoveryWindow, nowMs: number) {
  const start = Date.parse(window.startedAt)
  const span = Date.parse(window.maturesAt) - start
  if (span <= 0) return 100
  return Math.min(100, Math.max(0, ((nowMs - start) / span) * 100))
}

/** "Thu 13 Nov, 09:41" in the viewer's own locale and time zone. */
export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const KEY_GROUPS_PER_LINE = 4

/** The key as two lines of four dash-joined groups, for display. */
export function keyLines(recoveryKey: string): readonly string[] {
  const groups = recoveryKey.split("-")
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += KEY_GROUPS_PER_LINE) {
    lines.push(groups.slice(i, i + KEY_GROUPS_PER_LINE).join("-"))
  }
  return lines
}

/** The text of the saved file: the key and nothing else. */
export function recoveryKeyFileText(recoveryKey: string): string {
  return `${recoveryKey}\n`
}

/** Why a recovery call failed. Wrong, malformed, used and superseded keys are all `refused`. */
export type RecoveryFailure =
  | "refused"
  | "rate-limited"
  | "offline"
  | "unreadable"
  | "cancelled"
  | "not-pending"
  | "signed-out"

export type RecoveryResult<T> =
  { ok: true; value: T } | { ok: false; reason: RecoveryFailure }

const fail = (
  reason: RecoveryFailure
): { ok: false; reason: RecoveryFailure } => ({
  ok: false,
  reason,
})

async function post(path: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(`${GATE_URL}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return null
  }
}

/** Reads a non-OK answer. The gate sends one generic 403 for every key problem. */
function refusal(response: Response): RecoveryFailure {
  if (response.status === 429) return "rate-limited"
  if (response.status === 401) return "signed-out"
  if (response.status === 404) return "not-pending"
  return "refused"
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function keyRequest(recoveryKey: string): GateRecoveryKeyRequest | undefined {
  const checked = validateGateRecoveryKeyRequest({ recoveryKey })
  return checked.ok ? checked.value : undefined
}

/**
 * Starts the 24-hour delay with the owner's recovery key. The key is only held in this call:
 * not logged, not stored, never in a URL.
 */
export async function startRecovery(
  recoveryKey: string
): Promise<RecoveryResult<GateRecoveryWindow>> {
  const body = keyRequest(recoveryKey)
  if (body === undefined) return fail("refused")
  const response = await post("/passkey/recover/start", body)
  if (response === null) return fail("offline")
  if (!response.ok) return fail(refusal(response))
  const parsed = validateGateRecoveryWindow(await readJson(response))
  return parsed.ok ? { ok: true, value: parsed.value } : fail("unreadable")
}

/**
 * After the delay: asks the gate for a challenge, creates the new passkey on this device and
 * posts it with the key. The gate starts the session (HttpOnly cookie) and returns the
 * replacement key once.
 */
export async function completeRecovery(
  recoveryKey: string,
  rpId: string
): Promise<RecoveryResult<string>> {
  const request = keyRequest(recoveryKey)
  if (request === undefined) return fail("refused")
  const optionsResponse = await post("/passkey/recover/options", request)
  if (optionsResponse === null) return fail("offline")
  if (!optionsResponse.ok) return fail(refusal(optionsResponse))
  const options = validateGateEnrolOptions(await readJson(optionsResponse))
  if (!options.ok) return fail("unreadable")

  let credential: Credential | null
  try {
    credential = await navigator.credentials.create(
      creationOptions(
        options.value,
        rpId,
        crypto.getRandomValues(new Uint8Array(16))
      )
    )
  } catch {
    return fail("cancelled")
  }
  const registration =
    credential instanceof PublicKeyCredential
      ? toRegistration(credential)
      : undefined
  if (registration === undefined) return fail("cancelled")

  const body: GateRecoveryCompleteRequest = {
    recoveryKey: request.recoveryKey,
    registration,
  }
  const response = await post("/passkey/recover/complete", body)
  if (response === null) return fail("offline")
  if (!response.ok) return fail(refusal(response))
  const parsed = validateGateRecoveryCompleted(await readJson(response))
  return parsed.ok
    ? { ok: true, value: parsed.value.recoveryKey }
    : fail("unreadable")
}

const encoder = new TextEncoder()

async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(text))
  )
}

/**
 * The challenge to sign for a prepared cancel, or undefined when the gate's card is not the
 * cancel of a recovery: the payload must name `recovery.cancel`, hash to the sent hash on this
 * device, and the challenge must be the control ceremony over that hash and nonce (the gate
 * builds the same bytes in `controlApprovalChallenge`).
 */
export async function checkedCancelChallenge(
  prepared: GateRecoveryCancelPrepared
): Promise<Uint8Array | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(prepared.payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  if (Reflect.get(parsed, "action") !== "recovery.cancel") return undefined
  const payloadHash = await hashPayloadText(prepared.payload)
  if (payloadHash === undefined || payloadHash !== prepared.payloadHash) {
    return undefined
  }
  const challenge = toBase64url(
    await sha256Bytes(
      JSON.stringify([
        "eido.control.v1",
        prepared.purpose,
        prepared.target,
        prepared.id,
        payloadHash,
        prepared.nonce,
      ])
    )
  )
  return challenge === prepared.challenge ? fromBase64url(challenge) : undefined
}

/**
 * Cancels the pending recovery with this device's passkey: asks the gate to prepare the
 * ceremony, checks it here, signs it and posts the assertion. Returns the replacement recovery
 * key, which the gate sends once.
 */
export async function cancelRecovery(
  rpId: string
): Promise<RecoveryResult<string>> {
  const preparedResponse = await post("/passkey/recover/cancel/prepare")
  if (preparedResponse === null) return fail("offline")
  if (!preparedResponse.ok) return fail(refusal(preparedResponse))
  const prepared = validateGateRecoveryCancelPrepared(
    await readJson(preparedResponse)
  )
  if (!prepared.ok) return fail("unreadable")
  const challenge = await checkedCancelChallenge(prepared.value)
  if (challenge === undefined) return fail("unreadable")

  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: challenge.buffer as ArrayBuffer,
        rpId,
        userVerification: "required",
        timeout: 60_000,
      },
    })
  } catch {
    return fail("cancelled")
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  if (assertion === undefined) return fail("cancelled")

  const body: GateRecoveryCancelRequest = {
    approval: {
      id: prepared.value.id,
      nonce: prepared.value.nonce,
      assertion,
    },
  }
  const response = await post("/passkey/recover/cancel", body)
  if (response === null) return fail("offline")
  if (!response.ok) return fail(refusal(response))
  const parsed = validateGateRecoveryKey(await readJson(response))
  return parsed.ok
    ? { ok: true, value: parsed.value.recoveryKey }
    : fail("unreadable")
}
