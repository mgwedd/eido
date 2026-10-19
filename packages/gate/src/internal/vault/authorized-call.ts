// Gate internals: only packages/gate may import this file.
import {
  ConnectorDisabledError,
  GrantRevokedError,
  UpstreamError,
  markGrantRevoked,
  type RevocationDeps,
} from "./revocation"
import type { VaultClient } from "./vault"

export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: "invalid_grant" | "temporarily_unavailable" }

export type UpstreamResponse = { status: number }

export type AuthorizedCallOptions<T extends UpstreamResponse> =
  RevocationDeps & {
    connector: string
    client: VaultClient
    /** Exchanges the refresh token at the token endpoint. */
    refresh(refreshToken: string): Promise<RefreshResult>
    /** The actual upstream call, made with an access token. */
    call(accessToken: string): Promise<T>
  }

/**
 * Vault-backed upstream call. A revoked grant (`invalid_grant` on refresh) disables the
 * connector and stops: no retry. A disabled connector is refused without contacting upstream.
 * A 401 triggers one refresh; the call is retried once only if that refresh succeeds.
 */
export async function authorizedCall<T extends UpstreamResponse>(
  options: AuthorizedCallOptions<T>
): Promise<T> {
  const { connector, client, vault, connectors } = options
  if (!(await connectors.isEnabled(connector)))
    throw new ConnectorDisabledError(connector)

  const accessKey = { connector, kind: "access_token", client } as const
  const refreshKey = { connector, kind: "refresh_token", client } as const

  const refreshAccessToken = async (): Promise<string> => {
    const refreshToken = await vault.get(refreshKey)
    if (refreshToken === undefined)
      throw new UpstreamError(connector, "no_refresh_token")
    const result = await options.refresh(refreshToken)
    if (!result.ok) {
      if (result.error === "invalid_grant") {
        await markGrantRevoked(connector, "invalid_grant", options)
        throw new GrantRevokedError(connector)
      }
      throw new UpstreamError(connector, result.error)
    }
    await vault.set(accessKey, result.accessToken)
    return result.accessToken
  }

  const cached = await vault.get(accessKey)
  const first = await options.call(cached ?? (await refreshAccessToken()))
  if (first.status !== 401 || cached === undefined) return first

  await vault.delete(accessKey)
  return options.call(await refreshAccessToken())
}
