import type { DatabaseSync } from "node:sqlite"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import type { RefreshResult } from "./vault/authorized-call"
import type { RevocationDeps } from "./vault/revocation"
import type { Vault, VaultClient } from "./vault/vault"

// The pieces every gate OAuth client shares: Google's refresh-token exchange and the connector
// and audit seams `authorizedCall` uses. The Gmail write transport (compose client) and the read
// egress proxy (read clients) both use them, so a revoked grant is handled one way.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export type GoogleRefreshOptions = {
  vault: Vault
  connector: string
  client: VaultClient
  clientId: string | undefined
  fetch?: typeof fetch
  signal?: AbortSignal
}

/**
 * Exchanges a refresh token at Google's token endpoint, with the client secret stored in the
 * vault under the same connector and client. `invalid_grant` is the revoked-grant answer; any
 * other failure, a missing client id or a missing secret is temporary.
 */
export async function refreshGoogleToken(
  options: GoogleRefreshOptions,
  refreshToken: string
): Promise<RefreshResult> {
  const clientSecret =
    (await options.vault.get({
      connector: options.connector,
      kind: "api_key",
      client: options.client,
    })) ??
    (await options.vault.get({
      connector: "google",
      kind: "api_key",
      client: "none",
    }))
  if (!options.clientId || !clientSecret)
    return { ok: false, error: "temporarily_unavailable" }
  const response = await (options.fetch ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    redirect: "manual",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (
    response.status === 400 &&
    isRecord(value) &&
    value["error"] === "invalid_grant"
  )
    return { ok: false, error: "invalid_grant" }
  if (
    !response.ok ||
    !isRecord(value) ||
    typeof value["access_token"] !== "string"
  )
    return { ok: false, error: "temporarily_unavailable" }
  return { ok: true, accessToken: value["access_token"] }
}

/**
 * The connectors-table and audit seams for `authorizedCall` and `markGrantRevoked`. A revoked
 * grant disables the connector with `auth_failed`; the audit row holds a hash of the error class.
 */
export function connectorRevocationDeps(
  db: DatabaseSync,
  vault: Vault,
  actor: string
): RevocationDeps {
  return {
    vault,
    connectors: {
      isEnabled: (name) =>
        Promise.resolve(
          db.prepare("SELECT enabled FROM connectors WHERE name=?").get(name)?.[
            "enabled"
          ] === 1
        ),
      disable: (name) => {
        db.prepare(
          `UPDATE connectors SET enabled=0, health='open', last_error='auth_failed',
             next_attempt_at=NULL, probe_started_at=NULL, probe_lease_id=NULL,
             health_generation=health_generation + 1 WHERE name=?`
        ).run(name)
        return Promise.resolve()
      },
    },
    audit: {
      append: (entry) => {
        append(db, {
          actor,
          action: entry.action,
          target: entry.target,
          detailHash: payloadHash({ errorClass: entry.errorClass }),
        })
        return Promise.resolve()
      },
    },
  }
}
