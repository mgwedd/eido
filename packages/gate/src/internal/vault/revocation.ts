// Gate internals: only packages/gate may import this file.
import type { Vault, VaultClient } from "./vault"

/**
 * Seam for the `connectors` table (#10). The real implementation sets
 * `enabled = false` and `health = open` on the connector's row.
 */
export interface ConnectorStore {
  isEnabled(connector: string): Promise<boolean>
  disable(connector: string): Promise<void>
}

/** Seam for the append-only audit log (#9). Entries never carry secret values. */
export type AuditEntry = {
  action: "grant_revoked"
  target: string
  errorClass: string
}
export interface AuditLog {
  append(entry: AuditEntry): Promise<void>
}

export type RevocationDeps = {
  vault: Vault
  connectors: ConnectorStore
  audit: AuditLog
}

const CLIENTS: readonly VaultClient[] = ["read", "write", "none"]

export class GrantRevokedError extends Error {
  constructor(connector: string) {
    super(`grant revoked for connector ${connector}`)
    this.name = "GrantRevokedError"
  }
}

export class ConnectorDisabledError extends Error {
  constructor(connector: string) {
    super(`connector ${connector} is disabled until the user re-authorizes`)
    this.name = "ConnectorDisabledError"
  }
}

export class UpstreamError extends Error {
  constructor(connector: string, errorClass: string) {
    super(`upstream call for connector ${connector} failed: ${errorClass}`)
    this.name = "UpstreamError"
  }
}

/**
 * Disables the connector, drops its cached access tokens and audits it. Refresh tokens
 * stay: re-authorization replaces them. Called by the proxy (#14) and executor (#12).
 */
export async function markGrantRevoked(
  connector: string,
  errorClass: string,
  deps: RevocationDeps
): Promise<void> {
  await deps.connectors.disable(connector)
  for (const client of CLIENTS) {
    await deps.vault.delete({ connector, kind: "access_token", client })
  }
  await deps.audit.append({
    action: "grant_revoked",
    target: connector,
    errorClass,
  })
}
