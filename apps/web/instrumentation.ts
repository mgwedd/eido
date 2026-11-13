import { coreRoleKeyFromEnv } from "@/lib/auth/core-role"
import { allowListFromEnv } from "@/lib/auth/roles"

/**
 * Runs once when the server starts. When Auth0 is enabled (AUTH0_DOMAIN set) or when an owner
 * email is configured, a missing or malformed owner/assistant allow-list throws here, so the app
 * refuses to start instead of serving with the wrong people let in (or nobody).
 * In passkey-only mode (AUTH0_DOMAIN unset and no owner email configured), Auth0 and allow-lists
 * are optional (issue 679).
 */
export function register(): void {
  assertAuth0BuildMatchesRuntime(
    process.env["NEXT_PUBLIC_AUTH0_ENABLED"],
    process.env["AUTH0_DOMAIN"]
  )
  const requiresAllowList =
    Boolean(process.env["AUTH0_DOMAIN"]) || "EIDO_OWNER_EMAIL" in process.env
  if (requiresAllowList) {
    allowListFromEnv()
  }
  // A set but unusable role-signing key (#720) would leave every core write refused: say so now.
  coreRoleKeyFromEnv()
}

/**
 * NEXT_PUBLIC_AUTH0_ENABLED is fixed at build time from AUTH0_DOMAIN (next.config.ts) and read by
 * the browser; the proxy reads AUTH0_DOMAIN at run time. If they disagree the app would be
 * half-enabled (client signs out via Auth0, server checks passkeys, or the reverse), so refuse to start.
 */
export function assertAuth0BuildMatchesRuntime(
  builtEnabled: string | undefined,
  runtimeDomain: string | undefined
): void {
  const built = builtEnabled === "true"
  const runtime = Boolean(runtimeDomain)
  if (built !== runtime) {
    throw new Error(
      `Auth0 is ${built ? "enabled" : "disabled"} in this build but AUTH0_DOMAIN is ${
        runtime ? "set" : "unset"
      } at run time. Rebuild with the same AUTH0_DOMAIN the server runs with.`
    )
  }
}
