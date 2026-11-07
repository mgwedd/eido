import type { DatabaseSync } from "node:sqlite"
import type { GateConnectorHealth } from "@eido/schemas"
import { append } from "./audit"
import { BridgeError } from "./bridge/errors"
import type { ProtonBridge } from "./bridge/bridge"
import { payloadHash } from "./canonical"
import {
  beginConnectorRead,
  disableConnectorAfterAuthFailure,
  getConnectorHealth,
  recordConnectorReadFailure,
  recordConnectorReadSuccess,
} from "./connector-health"
import { apiError } from "./http"
import type { GateRequest, Reply } from "./http"

// After the Mac-side `connect` command (#98) stores a credential in the vault, it asks the gate,
// over the control socket only, to check the connector: POST /connectors/{name}/connected. The
// gate runs the connector's health probe (a real read with the new credential) and records the
// result through the same health transitions a read makes (#24). A connector disabled because
// its credential was refused is enabled again here; one disabled for manifest drift or a missing
// signed pin is not, since only a re-reviewed pin clears that. The audit row holds a hash of the
// outcome only, never the credential or its hash.

/** What a connector's health probe saw; it never throws. */
export type ProbeOutcome =
  "ok" | "auth_failed" | "handshake_failed" | "timeout" | "unavailable"
export type ConnectorProbe = () => Promise<ProbeOutcome>
export type ConnectorProbes = Readonly<Record<string, ConnectorProbe>>

const CONNECTED_PATH = /^\/connectors\/([a-z0-9][a-z0-9-]{0,63})\/connected$/

/** A Bridge probe: one folder list, which needs an IMAP login with the stored password. */
export function bridgeProbe(
  mail: Pick<ProtonBridge, "listFolders">
): ConnectorProbe {
  return async () => {
    try {
      await mail.listFolders()
      return "ok"
    } catch (error) {
      if (error instanceof BridgeError) {
        if (error.code === "auth_failed") return "auth_failed"
        if (error.code === "handshake_failed") return "handshake_failed"
      }
      return "unavailable"
    }
  }
}

async function runProbe(probe: ConnectorProbe): Promise<ProbeOutcome> {
  try {
    return await probe()
  } catch {
    return "unavailable"
  }
}

/** POST /connectors/{name}/connected, or undefined when the request is another route. */
export async function connectedRoute(
  request: GateRequest,
  db: DatabaseSync,
  probes: ConnectorProbes | undefined,
  now: () => number
): Promise<Reply | undefined> {
  if (request.method !== "POST") return undefined
  const match = CONNECTED_PATH.exec(request.path)
  if (match === null) return undefined
  return checkConnector(db, match[1] ?? "", probes, now)
}

/**
 * Runs a connector's health probe after it gets a new credential, re-enabling it when its old
 * credential was refused. The control socket's connected route and the Admin page's signed
 * secret routes (#661) both use it.
 */
export async function checkConnector(
  db: DatabaseSync,
  name: string,
  probes: ConnectorProbes | undefined,
  now: () => number
): Promise<Reply> {
  const row = db
    .prepare(
      "SELECT enabled, last_error, drift_json FROM connectors WHERE name = ?"
    )
    .get(name)
  if (row === undefined)
    return apiError(404, "not_found", "no connector with that name is pinned")
  const probe = probes?.[name]
  if (probe === undefined)
    return apiError(
      503,
      "unavailable",
      "the gate has no health probe for this connector; check its configuration"
    )
  const disabled = row["enabled"] !== 1
  if (
    disabled &&
    (row["last_error"] !== "auth_failed" || row["drift_json"] !== null)
  )
    return apiError(
      403,
      "forbidden",
      "the connector stays disabled until its reviewed manifest is pinned again"
    )
  const started = now()
  // A new credential deserves an immediate check: lift any backoff, drop a stale probe lease,
  // and re-enable a connector whose old credential was refused. The generation bump makes any
  // read still in flight with the old credential record nothing.
  db.prepare(
    `UPDATE connectors SET
       enabled = 1,
       health = CASE WHEN enabled = 0 THEN 'open' ELSE health END,
       next_attempt_at = CASE WHEN enabled = 1 AND health = 'healthy' THEN NULL ELSE ? END,
       probe_started_at = NULL, probe_lease_id = NULL,
       health_generation = health_generation + 1
     WHERE name = ?`
  ).run(new Date(started).toISOString(), name)
  // The row is now enabled with no backoff and no lease, and nothing ran in between (these
  // statements are synchronous), so the read is admitted as a probe or a plain read.
  const attempt = beginConnectorRead(db, name, started)
  const outcome = await runProbe(probe)
  const finished = now()
  if (outcome === "ok") recordConnectorReadSuccess(db, name, attempt, finished)
  else if (outcome === "auth_failed") disableConnectorAfterAuthFailure(db, name)
  else recordConnectorReadFailure(db, name, outcome, attempt, finished)
  append(db, {
    actor: "admin",
    action: "connector.connected",
    target: name,
    detailHash: payloadHash({ outcome, reenabled: disabled }),
  })
  const body: GateConnectorHealth = {
    connectors: getConnectorHealth(db).filter(
      (connector) => connector.name === name
    ),
  }
  return { status: 200, body }
}
