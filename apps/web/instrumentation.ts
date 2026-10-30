import { allowListFromEnv } from "@/lib/auth/roles"

/**
 * Runs once when the server starts. A missing or malformed owner/assistant allow-list
 * throws here, so the app refuses to start instead of serving with the wrong people let in
 * (or nobody). The proxy fails closed on the same error as a second line.
 */
export function register(): void {
  allowListFromEnv()
}
