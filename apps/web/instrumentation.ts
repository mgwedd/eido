import { allowListFromEnv } from "@/lib/auth/roles"

/**
 * Runs once when the server starts. When Auth0 is enabled (AUTH0_DOMAIN set) or when an owner
 * email is configured, a missing or malformed owner/assistant allow-list throws here, so the app
 * refuses to start instead of serving with the wrong people let in (or nobody).
 * In passkey-only mode (AUTH0_DOMAIN unset and no owner email configured), Auth0 and allow-lists
 * are optional (issue 679).
 */
export function register(): void {
  const requiresAllowList =
    Boolean(process.env["AUTH0_DOMAIN"]) || "EIDO_OWNER_EMAIL" in process.env
  if (requiresAllowList) {
    allowListFromEnv()
  }
}
