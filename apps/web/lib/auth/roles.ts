/**
 * Who may use the web app, and as what. Roles come from the verified email on the Auth0
 * session, checked against two lists in the web app's own environment:
 *
 * - `EIDO_OWNER_EMAIL`: exactly one address, the person Eido works for.
 * - `EIDO_ASSISTANT_EMAILS`: comma-separated addresses of human assistants.
 *
 * Addresses are compared trimmed and lowercased. Anyone else gets no role.
 */
export type Role = "owner" | "assistant"

export type AllowList = {
  readonly owner: string
  readonly assistants: readonly string[]
}

/** Thrown when the allow-list in the environment is unusable; the app must not start. */
export class AllowListError extends Error {
  override name = "AllowListError"
}

/** `process.env`, or any object holding the two variables. */
export type AllowListEnv = Readonly<Record<string, string | undefined>>

const EMAIL = /^[^\s@,]+@[^\s@,]+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Reads the allow-list. Throws `AllowListError` when the owner is missing or more than one
 * address, when an entry is not an email address, or when one address is on both lists.
 * Error messages never include the addresses themselves.
 */
export function parseAllowList(env: AllowListEnv): AllowList {
  const owner = normalizeEmail(env["EIDO_OWNER_EMAIL"] ?? "")
  if (owner === "") throw new AllowListError("EIDO_OWNER_EMAIL is not set.")
  if (!EMAIL.test(owner))
    throw new AllowListError(
      "EIDO_OWNER_EMAIL must be exactly one email address."
    )

  const assistants = [
    ...new Set(
      (env["EIDO_ASSISTANT_EMAILS"] ?? "")
        .split(",")
        .map(normalizeEmail)
        .filter((entry) => entry !== "")
    ),
  ]
  if (assistants.some((entry) => !EMAIL.test(entry)))
    throw new AllowListError(
      "EIDO_ASSISTANT_EMAILS must be a comma-separated list of email addresses."
    )
  if (assistants.includes(owner))
    throw new AllowListError(
      "The owner's address is also in EIDO_ASSISTANT_EMAILS. An address can hold one role only."
    )

  return { owner, assistants }
}

let cached: { key: string; list: AllowList } | undefined

/** The allow-list from `process.env`, parsed once per distinct value. Throws like `parseAllowList`. */
export function allowListFromEnv(env: AllowListEnv = process.env): AllowList {
  const key = `${env["EIDO_OWNER_EMAIL"] ?? ""}\n${env["EIDO_ASSISTANT_EMAILS"] ?? ""}`
  if (cached?.key !== key) cached = { key, list: parseAllowList(env) }
  return cached.list
}

/** The claims `roleFor` reads; an Auth0 session user has both. */
export type RoleClaims = {
  readonly email?: unknown
  readonly email_verified?: unknown
}

/** The role for a signed-in user, or null when the email is unverified or on neither list. */
export function roleFor(
  user: RoleClaims | null | undefined,
  allowList: AllowList = allowListFromEnv()
): Role | null {
  if (!user || user.email_verified !== true) return null
  if (typeof user.email !== "string") return null
  const email = normalizeEmail(user.email)
  if (email === "") return null
  if (email === allowList.owner) return "owner"
  if (allowList.assistants.includes(email)) return "assistant"
  return null
}
