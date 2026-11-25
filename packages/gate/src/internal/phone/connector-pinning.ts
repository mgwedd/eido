import { validateGateRepinRequest } from "@eido/schemas"
import type { GateConnectorSettings, GateRepinResult } from "@eido/schemas"
import { apiError } from "../http"
import type { GateRequest, Reply } from "../http"
import { getConnectorHealth } from "../connector-health"
import { getConnectorState } from "../connectors"
import {
  applyFirstPin,
  applyRepin,
  prepareFirstPin,
  prepareRepin,
  unpinnedReviewed,
} from "../repin"
import type { FirstPinRefusal, RepinRefusal } from "../repin"
import type { Clock } from "../sessions"
import { jsonBody, invalid } from "./shared"
import type { PhoneState } from "./types"

export function connectorSettings(state: PhoneState, now: Clock): Reply {
  const health = new Map(
    getConnectorHealth(state.db).map((connector) => [connector.name, connector])
  )
  const bridgePasswordStored =
    state.db
      .prepare("SELECT certificate_sha256 FROM bridge_password_pin")
      .get() !== undefined
  const connectors: GateConnectorSettings["connectors"] = state.db
    .prepare(
      "SELECT name, pinned_at, manifest_hash, last_success_at, account_email FROM connectors ORDER BY name"
    )
    .all()
    .map((row) => {
      const name = String(row["name"])
      const stored = getConnectorState(state.db, name)
      const current = health.get(name)
      if (stored === undefined || current === undefined) {
        throw new Error("stored connector state is incomplete")
      }
      const isProton = name === "proton-mail" || name === "proton-calendar"
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
        ...(isProton ? { bridgePasswordStored } : {}),
        ...(typeof row["account_email"] === "string" &&
        row["account_email"].length > 0
          ? { accountEmail: row["account_email"] }
          : {}),
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

export async function repinPrepare(
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

export async function repinDecision(
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

export async function firstPinPrepare(
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

export async function firstPinDecision(
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
