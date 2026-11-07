import { createHash, X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import type {
  GateConnectorHealth,
  GateConnectorRemoved,
  GateControlPrepared,
} from "@eido/schemas"
import { supervisorFailure } from "./admin-routes"
import { append } from "./audit"
import { BRIDGE_PASSWORD_KEY } from "./bridge/bridge"
import { PROTON_CALENDAR_CONNECTOR, PROTON_CONNECTOR } from "./bridge/config"
import { payloadHash } from "./canonical"
import { claimSimpleFin } from "./connect/simplefin-claim"
import { checkConnector } from "./connector-connect"
import type { ConnectorProbes } from "./connector-connect"
import { getConnectorHealth } from "./connector-health"
import {
  controlApprovalChallenge,
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type { ControlAuthorization } from "./control-approvals"
import { apiError } from "./http"
import type { Reply } from "./http"
import type { SupervisorClient } from "./supervisor-client"
import type { Vault, VaultClient, VaultKey, VaultKeyKind } from "./vault/vault"

// Connector secrets from the web Admin page (#661, ADR 0009 Decision 3). The browser posts the
// value straight to a signed route. The owner's passkey signs a payload naming the action, the
// connector and any certificate pin; the secret itself is only in the request body, goes to the
// vault, and is never sent back, logged or hashed into an audit row. The audit rows hold hashes
// of the action and outcome only.

export const SIMPLEFIN_CONNECTOR = "simplefin"
/** The stack setting holding the Bridge pin; the gate reads it at start (bridge/config.ts). */
const BRIDGE_PIN_SETTING = "EIDO_BRIDGE_CERT_SHA256"

const BRIDGE_SECRET_TARGET = `connector_secret:${PROTON_CONNECTOR}`
const BRIDGE_PIN_TARGET = `connector_pin:${PROTON_CONNECTOR}`
const SIMPLEFIN_TARGET = `connector_secret:${SIMPLEFIN_CONNECTOR}`

/** Both Proton connectors sign in to Bridge with the one stored password. */
const PROTON_CONNECTORS = [PROTON_CONNECTOR, PROTON_CALENDAR_CONNECTOR]

const bridgeSecretPayload = (certificateSha256: string) => ({
  action: "connector.secret.set",
  connector: PROTON_CONNECTOR,
  certificateSha256,
})
const bridgePinPayload = (certificateSha256: string) => ({
  action: "connector.pin.set",
  connector: PROTON_CONNECTOR,
  certificateSha256,
})
const SIMPLEFIN_PAYLOAD = {
  action: "connector.secret.set",
  connector: SIMPLEFIN_CONNECTOR,
}

export type SecretState = {
  db: DatabaseSync
  vault?: Vault
  /** The pin the running gate trusts Bridge with, and its certificate file; undefined without Bridge. */
  bridge?: { certificateSha256: string; certificatePath: string }
  supervisor?: SupervisorClient
  probes?: ConnectorProbes
  fetch?: typeof fetch
}

const KINDS: readonly VaultKeyKind[] = [
  "refresh_token",
  "access_token",
  "api_key",
  "password",
]
const CLIENTS: readonly VaultClient[] = ["read", "write", "none"]

function audit(
  db: DatabaseSync,
  action: string,
  target: string,
  detail: Record<string, string>
): number {
  return append(db, {
    actor: "owner",
    action,
    target,
    detailHash: payloadHash(detail),
  }).seq
}

function prepare(
  db: DatabaseSync,
  target: string,
  payload: unknown
): GateControlPrepared {
  const prepared = prepareControlApproval(db, "policy.set", target, payload)
  return {
    ...prepared,
    purpose: "policy.set",
    challenge: controlApprovalChallenge(prepared),
  }
}

/** Consumes the signed ceremony and audits the approval; throws when it does not verify. */
function approve(
  db: DatabaseSync,
  target: string,
  payload: unknown,
  authorization: ControlAuthorization,
  action: string,
  connector: string
): void {
  withControlApproval(
    db,
    "policy.set",
    target,
    payloadHash(payload),
    authorization,
    () => ({
      result: undefined,
      auditSeq: audit(db, action, connector, { outcome: "approved" }),
    })
  )
}

const REFUSED = () =>
  apiError(403, "verification_failed", "the passkey signature was refused")
const NO_VAULT = () =>
  apiError(503, "unavailable", "the gate has no vault configured")
const NO_BRIDGE = () =>
  apiError(503, "unavailable", "Proton Bridge is not configured")

/** The pin recorded with the stored Bridge password, or undefined when none is. */
function recordedPin(db: DatabaseSync): string | undefined {
  const row = db
    .prepare("SELECT certificate_sha256 FROM bridge_password_pin")
    .get()
  return row === undefined ? undefined : String(row["certificate_sha256"])
}

function recordPin(db: DatabaseSync, certificateSha256: string): void {
  db.prepare(
    "INSERT INTO bridge_password_pin (singleton, certificate_sha256) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET certificate_sha256 = excluded.certificate_sha256"
  ).run(certificateSha256)
}

/**
 * At gate start: the stored Bridge password belongs to the pin it was sealed under. A gate now
 * running with a different pin deletes the password, so it is never sent to the new endpoint
 * before the owner types it again. With no pin recorded, the running one is recorded.
 */
export async function reconcileBridgePin(
  db: DatabaseSync,
  vault: Vault,
  certificateSha256: string
): Promise<"kept" | "deleted"> {
  const recorded = recordedPin(db)
  if (recorded === undefined || recorded === certificateSha256) {
    recordPin(db, certificateSha256)
    return "kept"
  }
  await vault.delete(BRIDGE_PASSWORD_KEY)
  recordPin(db, certificateSha256)
  audit(db, "connector.secret.deleted", PROTON_CONNECTOR, {
    reason: "pin_changed",
  })
  return "deleted"
}

/** Runs each named connector's probe with its new credential and replies with their health. */
async function sealed(
  state: SecretState,
  names: readonly string[],
  now: () => number
): Promise<Reply> {
  const pinned = new Set(getConnectorHealth(state.db).map(({ name }) => name))
  for (const name of names)
    if (pinned.has(name) && state.probes?.[name] !== undefined)
      await checkConnector(state.db, name, state.probes, now)
  const body: GateConnectorHealth = {
    connectors: getConnectorHealth(state.db).filter(({ name }) =>
      names.includes(name)
    ),
  }
  return { status: 201, body }
}

function pinMismatch(): Reply {
  return apiError(
    409,
    "pin_mismatch",
    "the gate runs with another Bridge certificate pin"
  )
}

export function prepareBridgeSecret(
  state: SecretState,
  certificateSha256: string
): Reply {
  if (state.bridge === undefined) return NO_BRIDGE()
  if (certificateSha256 !== state.bridge.certificateSha256) return pinMismatch()
  return {
    status: 200,
    body: prepare(
      state.db,
      BRIDGE_SECRET_TARGET,
      bridgeSecretPayload(certificateSha256)
    ),
  }
}

/** Seals the Bridge password, for the pin the gate runs with only. */
export async function sealBridgeSecret(
  state: SecretState,
  input: {
    authorization: ControlAuthorization
    certificateSha256: string
    password: string
  },
  now: () => number
): Promise<Reply> {
  if (state.bridge === undefined) return NO_BRIDGE()
  if (state.vault === undefined) return NO_VAULT()
  if (input.certificateSha256 !== state.bridge.certificateSha256)
    return pinMismatch()
  try {
    approve(
      state.db,
      BRIDGE_SECRET_TARGET,
      bridgeSecretPayload(input.certificateSha256),
      input.authorization,
      "connector.secret.set",
      PROTON_CONNECTOR
    )
  } catch {
    return REFUSED()
  }
  await state.vault.set(BRIDGE_PASSWORD_KEY, input.password)
  recordPin(state.db, input.certificateSha256)
  return sealed(state, PROTON_CONNECTORS, now)
}

/** The SHA-256 of the certificate file's DER bytes, or undefined when it cannot be read. */
function fileFingerprint(path: string): string | undefined {
  try {
    const pem = readFileSync(path, "utf8")
    if (pem.includes("PRIVATE KEY")) return undefined
    return createHash("sha256")
      .update(new X509Certificate(pem).raw)
      .digest("hex")
  } catch {
    return undefined
  }
}

/**
 * Checks a pin change before the owner signs it, and again before it runs: the certificate file
 * must already match the new pin. Answers the supervisor to write it with, or the refusal.
 */
function pinChange(
  state: SecretState,
  certificateSha256: string
): { ok: true; supervisor: SupervisorClient } | { ok: false; reply: Reply } {
  const problem = pinChangeProblem(state, certificateSha256)
  if (problem !== undefined) return { ok: false, reply: problem }
  return state.supervisor === undefined
    ? { ok: false, reply: noSupervisor() }
    : { ok: true, supervisor: state.supervisor }
}

const noSupervisor = () =>
  apiError(
    503,
    "supervisor_unavailable",
    "the stack supervisor is not available"
  )

function pinChangeProblem(
  state: SecretState,
  certificateSha256: string
): Reply | undefined {
  if (state.bridge === undefined) return NO_BRIDGE()
  if (certificateSha256 === state.bridge.certificateSha256)
    return apiError(400, "invalid_request", "that is the pin in use")
  if (fileFingerprint(state.bridge.certificatePath) !== certificateSha256)
    return apiError(
      409,
      "certificate_mismatch",
      "the exported Bridge certificate does not match that pin"
    )
  return undefined
}

export function prepareBridgePin(
  state: SecretState,
  certificateSha256: string
): Reply {
  const change = pinChange(state, certificateSha256)
  if (!change.ok) return change.reply
  return {
    status: 200,
    body: prepare(
      state.db,
      BRIDGE_PIN_TARGET,
      bridgePinPayload(certificateSha256)
    ),
  }
}

/**
 * Changes the Bridge pin: deletes the stored Bridge password first, then writes the pin to the
 * stack settings, where the gate reads it when the stack restarts.
 */
export async function setBridgePin(
  state: SecretState,
  input: { authorization: ControlAuthorization; certificateSha256: string }
): Promise<Reply> {
  const change = pinChange(state, input.certificateSha256)
  if (!change.ok) return change.reply
  if (state.vault === undefined) return NO_VAULT()
  const { supervisor } = change
  try {
    approve(
      state.db,
      BRIDGE_PIN_TARGET,
      bridgePinPayload(input.certificateSha256),
      input.authorization,
      "connector.pin.set",
      PROTON_CONNECTOR
    )
  } catch {
    return REFUSED()
  }
  await state.vault.delete(BRIDGE_PASSWORD_KEY)
  recordPin(state.db, input.certificateSha256)
  audit(state.db, "connector.secret.deleted", PROTON_CONNECTOR, {
    reason: "pin_changed",
  })
  try {
    const current = await supervisor.settings()
    await supervisor.writeSettings({
      expectedSha256: current.sha256,
      set: { [BRIDGE_PIN_SETTING]: input.certificateSha256 },
    })
  } catch (error) {
    return supervisorFailure(error)
  }
  return {
    status: 200,
    body: { certificateSha256: input.certificateSha256 },
  }
}

export function prepareSimpleFin(state: SecretState): Reply {
  return {
    status: 200,
    body: prepare(state.db, SIMPLEFIN_TARGET, SIMPLEFIN_PAYLOAD),
  }
}

/**
 * Claims the SimpleFIN access URL with a setup token and seals it. The ceremony is consumed
 * before the claim, so an unsigned request never spends the one-time token.
 */
export async function setSimpleFin(
  state: SecretState,
  input: { authorization: ControlAuthorization; setupToken: string },
  now: () => number
): Promise<Reply> {
  if (state.vault === undefined) return NO_VAULT()
  try {
    approve(
      state.db,
      SIMPLEFIN_TARGET,
      SIMPLEFIN_PAYLOAD,
      input.authorization,
      "connector.secret.set",
      SIMPLEFIN_CONNECTOR
    )
  } catch {
    return REFUSED()
  }
  const claim = await claimSimpleFin(input.setupToken, state.fetch ?? fetch)
  if (!claim.ok) {
    audit(state.db, "connector.secret.refused", SIMPLEFIN_CONNECTOR, {
      reason: claim.reason,
    })
    return claim.reason === "invalid_token" || claim.reason === "host_refused"
      ? apiError(400, "invalid_request", "that is not a SimpleFIN setup token")
      : apiError(
          502,
          "claim_failed",
          "SimpleFIN did not hand over the access URL; the token may be spent"
        )
  }
  await state.vault.set(
    { connector: SIMPLEFIN_CONNECTOR, kind: "api_key", client: "read" },
    claim.accessUrl
  )
  return sealed(state, [SIMPLEFIN_CONNECTOR], now)
}

/**
 * Deletes every vault entry a connector has, of each kind and client. The connector's pinned
 * manifest, health row and indexed data stay; it fails its next read until it is connected again.
 */
export async function removeConnectorSecrets(
  state: SecretState,
  connector: string
): Promise<Reply> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connector))
    return apiError(400, "invalid_request", "not a connector name")
  if (state.vault === undefined) return NO_VAULT()
  const vault = state.vault
  const keys: VaultKey[] = KINDS.flatMap((kind) =>
    CLIENTS.map((client) => ({ connector, kind, client }))
  )
  for (const key of keys) await vault.delete(key)
  if (connector === PROTON_CONNECTOR)
    state.db.prepare("DELETE FROM bridge_password_pin").run()
  audit(state.db, "connector.secrets.removed", connector, {
    outcome: "removed",
  })
  const body: GateConnectorRemoved = { connector }
  return { status: 200, body }
}
