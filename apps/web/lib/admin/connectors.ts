import {
  validateGateBridgePin,
  validateGateConnectorHealth,
  validateGateConnectorRemoved,
  validateGateGoogleConnectPrepared,
  validateGateGoogleConnectStarted,
  type GateConnectorRemoved,
  type GateControlPrepared,
  type GateGoogleConnectPrepared,
} from "@eido/schemas"
import { shortHash } from "@/lib/approval/challenge"
import {
  checkPrepared,
  prepareControl,
  submitControl,
  type PrepareOutcome,
  type SubmitOutcome,
} from "@/lib/admin/control"
import { callGate, type GateOutcome } from "@/lib/admin/gate"
import { displayName } from "@/lib/connectors"

/** The connector ids the gate's Admin routes name. */
export const PROTON = "proton-mail"
export const SIMPLEFIN = "simplefin"

export type GoogleTarget = "gmail" | "gmail-read" | "drive"

/** The client each Google target signs in with, as the gate derives the payload from it. */
const GOOGLE_TARGETS: Readonly<
  Record<GoogleTarget, { connector: string; client: string }>
> = {
  gmail: { connector: "gmail", client: "write" },
  "gmail-read": { connector: "gmail", client: "read" },
  drive: { connector: "drive", client: "read" },
}

/** What `useAdmin().signed` is; passed in so this module holds no React. */
export type Signer = <T>(
  change: {
    action: string
    fields: readonly (readonly [string, string])[]
    payloadHash: string
  },
  send: () => Promise<SubmitOutcome<T>>
) => Promise<SubmitOutcome<T>>

/** What one secret or sign-in attempt came to, as the secret field announces it. */
export type SecretResult =
  | { kind: "sealed"; message?: string }
  | { kind: "refused" }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" }
  | { kind: "invalid"; message: string }

/** The reason the gate gave, in words, for the codes these routes answer with. */
const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  pin_mismatch: "the gate runs with another Bridge certificate pin",
  certificate_mismatch:
    "the exported Bridge certificate does not match that pin",
  invalid_request: "the gate did not accept that value",
  claim_failed:
    "SimpleFIN did not hand over the access URL; the token may be spent",
  client_secret_required: "the gate has no client secret for this client",
  supervisor_unavailable: "the stack supervisor is not available",
  unavailable: "the gate cannot do this right now",
}

type Failed = Extract<SecretResult, { kind: "failed" | "refused" }>

/** Turns any outcome that is not a success into the result the field shows. */
function failure(
  outcome: Exclude<
    GateOutcome<unknown> | PrepareOutcome | SubmitOutcome<unknown>,
    { kind: "ok" } | { kind: "cancelled" }
  >
): Failed {
  switch (outcome.kind) {
    case "unreachable":
      return { kind: "failed", reason: "the gate could not be reached" }
    case "expired":
      return { kind: "failed", reason: "the sign-in ended" }
    case "step-up":
      return { kind: "failed", reason: "the gate asked for a fresh step-up" }
    case "invalid":
      return { kind: "failed", reason: "the gate's answer was not understood" }
    case "mismatch":
      return {
        kind: "failed",
        reason:
          "the gate prepared a different change than asked, so nothing was signed",
      }
    case "refused":
      if (outcome.code === "verification_failed") return { kind: "refused" }
      return {
        kind: "failed",
        reason:
          REFUSAL_REASONS[outcome.code] ??
          `the gate refused it (${outcome.code})`,
      }
  }
}

/** A failure in words, without the field's "type it again" tail. */
function reasonOf(outcome: Parameters<typeof failure>[0]): string {
  const result = failure(outcome)
  return result.kind === "refused"
    ? "the passkey signature was refused"
    : result.reason
}

/** Why a result that did not work, in words for a sentence of its own. */
export function resultReason(result: SecretResult): string {
  switch (result.kind) {
    case "refused":
      return "the passkey signature was refused"
    case "failed":
      return result.reason
    case "invalid":
      return result.message
    default:
      return ""
  }
}

/** The SHA-256 pin as the gate wants it: lowercase hex, with colons and spaces dropped. */
export function normalizePin(text: string): string {
  return text.replace(/[\s:]/g, "").toLowerCase()
}

export const isPin = (pin: string): boolean => /^[0-9a-f]{64}$/.test(pin)

const BAD_PIN = "The certificate pin must be 64 hex characters (SHA-256)."

/**
 * Seals the Bridge password. Prepares and checks the change, shows it for signing, and on Sign
 * posts the password, which is read from its field only at that moment.
 */
export async function sealBridgePassword(
  signed: Signer,
  pinText: string,
  read: () => string
): Promise<SecretResult> {
  const pin = normalizePin(pinText)
  if (!isPin(pin)) return { kind: "invalid", message: BAD_PIN }
  const prepared = await prepareControl({
    preparePath: "/admin/secrets/bridge/prepare",
    prepareBody: { certificateSha256: pin },
    target: `connector_secret:${PROTON}`,
    payload: {
      action: "connector.secret.set",
      connector: PROTON,
      certificateSha256: pin,
    },
  })
  if (prepared.kind !== "ok") return failure(prepared)
  const sent = await signed(
    {
      action: "Seal the Bridge password",
      fields: [
        ["Connector", displayName(PROTON)],
        ["Pin sha256", shortHash(pin)],
      ],
      payloadHash: prepared.value.payloadHash,
    },
    () =>
      submitControl(
        prepared.value,
        "/admin/secrets/bridge",
        validateGateConnectorHealth,
        () => ({ certificateSha256: pin, password: read() })
      )
  )
  return sent.kind === "ok" ? { kind: "sealed" } : settle(sent)
}

/** The pin change alone: it deletes the stored Bridge password and sends nothing secret. */
export async function changeBridgePin(
  signed: Signer,
  pinText: string
): Promise<SecretResult> {
  const pin = normalizePin(pinText)
  if (!isPin(pin)) return { kind: "invalid", message: BAD_PIN }
  const prepared = await prepareControl({
    preparePath: "/admin/secrets/bridge-pin/prepare",
    prepareBody: { certificateSha256: pin },
    target: `connector_pin:${PROTON}`,
    payload: {
      action: "connector.pin.set",
      connector: PROTON,
      certificateSha256: pin,
    },
  })
  if (prepared.kind !== "ok") return failure(prepared)
  const sent = await signed(
    {
      action: "Change the Bridge certificate pin",
      fields: [
        ["Connector", displayName(PROTON)],
        ["Pin sha256", shortHash(pin)],
        ["Effect", "Deletes the stored Bridge password"],
      ],
      payloadHash: prepared.value.payloadHash,
    },
    () =>
      submitControl(
        prepared.value,
        "/admin/secrets/bridge-pin",
        validateGateBridgePin,
        () => ({
          certificateSha256: pin,
        })
      )
  )
  return sent.kind === "ok"
    ? {
        kind: "sealed",
        message:
          "Pin changed and the stored Bridge password deleted. Restart the stack from Status, then seal the password again.",
      }
    : settle(sent)
}

/** Claims and seals the SimpleFIN setup token, read from its field only when sent. */
export async function sealSimpleFin(
  signed: Signer,
  read: () => string
): Promise<SecretResult> {
  const prepared = await prepareControl({
    preparePath: "/admin/secrets/simplefin/prepare",
    target: `connector_secret:${SIMPLEFIN}`,
    payload: { action: "connector.secret.set", connector: SIMPLEFIN },
  })
  if (prepared.kind !== "ok") return failure(prepared)
  const sent = await signed(
    {
      action: "Seal the SimpleFIN setup token",
      fields: [["Connector", "SimpleFIN"]],
      payloadHash: prepared.value.payloadHash,
    },
    () =>
      submitControl(
        prepared.value,
        "/admin/secrets/simplefin",
        validateGateConnectorHealth,
        () => ({ setupToken: read() })
      )
  )
  return sent.kind === "ok" ? { kind: "sealed" } : settle(sent)
}

function settle(
  sent: Exclude<SubmitOutcome<unknown>, { kind: "ok" }>
): SecretResult {
  return sent.kind === "cancelled" ? { kind: "cancelled" } : failure(sent)
}

/** The two Google prepare results: the ceremony and whether a client secret is still needed. */
export type GooglePrepare =
  | {
      kind: "ready"
      prepared: GateControlPrepared
      clientSecretStored: boolean
    }
  | { kind: "failed"; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** The four fields of a Google sign-in payload, or undefined when the text is anything else. */
function googlePayload(
  text: string
):
  | { action: string; connector: string; client: string; clientId: string }
  | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(payload)) return undefined
  if (
    Object.keys(payload).sort().join(",") !== "action,client,clientId,connector"
  )
    return undefined
  const { action, client, clientId, connector } = payload
  if (
    typeof action !== "string" ||
    typeof client !== "string" ||
    typeof clientId !== "string" ||
    typeof connector !== "string"
  )
    return undefined
  return { action, client, clientId, connector }
}

/**
 * Checks on this device what it can of a Google sign-in ceremony. The client id is the gate's
 * and the device cannot know it in advance, so the payload must be exactly the four known keys
 * with action, connector and client as this target requires, and any client id; the target, the
 * payload hash and the challenge are then checked as for every signed change.
 */
export async function checkGoogleApproval(
  approval: GateControlPrepared,
  target: GoogleTarget
): Promise<boolean> {
  const payload = googlePayload(approval.payload)
  if (payload === undefined) return false
  const want = GOOGLE_TARGETS[target]
  if (
    payload.action !== "connector.oauth.start" ||
    payload.connector !== want.connector ||
    payload.client !== want.client ||
    payload.clientId === ""
  )
    return false
  return checkPrepared(approval, {
    target: `connector_oauth:${target}`,
    payload,
  })
}

/** Asks the gate for a Google sign-in ceremony and checks it on this device. */
export async function prepareGoogle(
  target: GoogleTarget
): Promise<GooglePrepare> {
  const outcome: GateOutcome<GateGoogleConnectPrepared> = await callGate(
    "/admin/connectors/google/prepare",
    validateGateGoogleConnectPrepared,
    { method: "POST", body: { target } }
  )
  if (outcome.kind !== "ok")
    return { kind: "failed", reason: reasonOf(outcome) }
  if (!(await checkGoogleApproval(outcome.value.approval, target)))
    return { kind: "failed", reason: reasonOf({ kind: "mismatch" }) }
  return {
    kind: "ready",
    prepared: outcome.value.approval,
    clientSecretStored: outcome.value.clientSecretStored,
  }
}

const GOOGLE_HOST = "https://accounts.google.com/"

/**
 * Signs the prepared sign-in and starts it, then hands Google's address to `navigate`. The
 * client secret, when the vault has none, is read from its field only at send time.
 */
export async function startGoogle(
  signed: Signer,
  target: GoogleTarget,
  prepared: GateControlPrepared,
  read: (() => string) | undefined,
  navigate: (url: string) => void
): Promise<SecretResult> {
  const payload = googlePayload(prepared.payload)
  if (payload === undefined)
    return { kind: "failed", reason: reasonOf({ kind: "mismatch" }) }
  const sent = await signed(
    {
      action: `Sign in to ${googleName(target)} with Google`,
      fields: [
        ["Connector", googleName(target)],
        ["Client", payload.client],
        ["Google client ID", payload.clientId],
      ],
      payloadHash: prepared.payloadHash,
    },
    () =>
      submitControl(
        prepared,
        "/admin/connectors/google/start",
        validateGateGoogleConnectStarted,
        () => ({
          target,
          ...(read === undefined ? {} : { clientSecret: read() }),
        })
      )
  )
  if (sent.kind !== "ok") return settle(sent)
  if (!sent.value.authorizationUrl.startsWith(GOOGLE_HOST))
    return {
      kind: "failed",
      reason: "the gate sent an address that is not Google's",
    }
  navigate(sent.value.authorizationUrl)
  return {
    kind: "sealed",
    message: "Sent to the gate. Opening Google… The field is cleared.",
  }
}

export function googleName(target: GoogleTarget): string {
  return target === "gmail-read" ? "Gmail (read only)" : displayName(target)
}

/** What removing a connector's secrets says to the owner, per connector. */
export function removeCopy(id: string): {
  title: string
  text: string
  button: string
} {
  const name = displayName(id)
  if (id === PROTON)
    return {
      title: `Remove ${name}?`,
      text: "Eido deletes the Bridge password from the vault. Mail already indexed stays.",
      button: `Remove ${name}`,
    }
  const noun =
    id === "drive"
      ? "Files already indexed stay."
      : "Mail already indexed stays."
  return {
    title: `Remove ${name}?`,
    text: `Eido deletes ${name}'s tokens from the vault. ${noun}`,
    button: `Remove ${name}`,
  }
}

/** Deletes the connector's secrets; elevated, so the caller wraps it in `useAdmin().elevated`. */
export function removeConnector(
  id: string
): Promise<GateOutcome<GateConnectorRemoved>> {
  return callGate(
    `/admin/connectors/${encodeURIComponent(id)}/remove`,
    validateGateConnectorRemoved,
    { method: "POST", body: {} }
  )
}

/** Why a remove failed, in words for the page's alert. */
export function removeFailure(
  outcome: Exclude<GateOutcome<unknown>, { kind: "ok" }>
): string {
  return reasonOf(outcome)
}

/** What the gate's callback left in the page address after a Google sign-in. */
export type GoogleLanding =
  | { kind: "expired" }
  | { kind: "connected"; target: GoogleTarget; health: string }
  | { kind: "failed"; target: GoogleTarget; reason: string }

const isTarget = (value: string | null): value is GoogleTarget =>
  value !== null && Object.hasOwn(GOOGLE_TARGETS, value)

/** Reads `?google=&connected=`, `?google=&error=` and `?error=expired`; anything else is not a landing. */
export function readGoogleLanding(search: string): GoogleLanding | null {
  const query = new URLSearchParams(search)
  const error = query.get("error")
  const target = query.get("google")
  if (error === "expired" && target === null) return { kind: "expired" }
  if (!isTarget(target)) return null
  const connected = query.get("connected")
  if (connected !== null)
    return { kind: "connected", target, health: connected }
  return error === null ? null : { kind: "failed", target, reason: error }
}

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  denied: "Google sign-in was denied.",
  invalid_callback: "Google's answer was not valid.",
  token_endpoint_unreachable:
    "Google could not be reached to finish the sign-in.",
  token_endpoint_refused: "Google refused the sign-in.",
  no_refresh_token: "Google did not give a refresh token.",
  scope_not_granted: "The access Eido asked for was not granted.",
}

/** The landing's one-line message. */
export function landingMessage(landing: GoogleLanding): string {
  if (landing.kind === "expired")
    return "The Google sign-in expired or was already used. Start it again."
  const name = googleName(landing.target)
  if (landing.kind === "failed")
    return `${name} was not connected. ${FAILURE_REASONS[landing.reason] ?? "The sign-in failed."}`
  if (landing.health === "unpinned")
    return `${name} signed in. It is not pinned yet, so it stays unused until it is.`
  return `${name} connected. Health: ${landing.health}.`
}
