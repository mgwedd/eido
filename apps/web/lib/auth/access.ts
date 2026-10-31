import { roleFor, type Role, type RoleClaims } from "@/lib/auth/roles"

/**
 * Which role may open which page. Default deny: a path that matches no entry is open to
 * the owner only. The owner may open every page. Route-level only; per-action rules
 * (what an assistant may do on a page they can open) are issue 371 and belong next to this map.
 */
export type RouteRule = {
  /** Exact path, or a prefix that also matches nested paths. "/" matches only "/". */
  readonly path: string
  readonly roles: readonly Role[]
}

/**
 * Today and Queue show and decide approvals; Unlock starts the passkey session that
 * signs them. All three are the owner's. The assistant workspace is issue 382.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  { path: "/", roles: ["owner"] },
  { path: "/queue", roles: ["owner"] },
  { path: "/connectors", roles: ["owner"] },
  { path: "/unlock", roles: ["owner"] },
]

/** Open to anyone signed in, with or without a role, so they can see why and sign out. */
export const FORBIDDEN_PATH = "/forbidden"

export function matchesPath(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/"
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function canAccess(
  role: Role | null,
  pathname: string,
  rules: readonly RouteRule[] = ROUTE_RULES
): boolean {
  if (matchesPath(pathname, FORBIDDEN_PATH)) return true
  if (role === null) return false
  if (role === "owner") return true
  const rule = rules.find((entry) => matchesPath(pathname, entry.path))
  return rule !== undefined && rule.roles.includes(role)
}

export type GuardDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "login"; readonly returnTo: string }
  | { readonly kind: "forbidden" }

/**
 * What the proxy does with a page request. `signedIn` is whether an Auth0 session exists;
 * `role` is null for a session whose email is unverified or on neither list.
 */
export function guard(input: {
  readonly signedIn: boolean
  readonly role: Role | null
  readonly pathname: string
  readonly search: string
}): GuardDecision {
  if (!input.signedIn)
    return { kind: "login", returnTo: `${input.pathname}${input.search}` }
  if (canAccess(input.role, input.pathname)) return { kind: "allow" }
  return { kind: "forbidden" }
}

export type ForbiddenReason = "unverified" | "not-invited" | "owner-only"

/** Why a signed-in user was refused, for the 403 page; null for the owner, who never is. */
export function forbiddenReason(user: RoleClaims): ForbiddenReason | null {
  const role = roleFor(user)
  if (role === "owner") return null
  if (user.email_verified !== true) return "unverified"
  if (role === null) return "not-invited"
  return "owner-only"
}
