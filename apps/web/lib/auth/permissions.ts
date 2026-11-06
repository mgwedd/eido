import { roleFor, type Role, type RoleClaims } from "@/lib/auth/roles"

/**
 * What a signed-in person may do, as `resource:action`. Route access (`access.ts`) decides
 * which pages a role may open; these decide which actions it may take on them. Each entry
 * names an action the web app offers today. Default deny: a role holds only the permissions
 * listed for it. A permission never stands in for the owner's passkey signature on a gate
 * write; the gate checks that on its own.
 */
export const PERMISSIONS = [
  "approval:decide", // approve or deny a queued intent, signed with the passkey
  "approval:edit", // change a queued draft's fields before deciding
  "approval:undo", // undo an executed action inside its window
  "passkey:unlock", // start the gate's passkey session
  "passkey:enroll", // register a passkey on this device
  "ask:query", // ask a question over the indexed mail and documents
  "draft:create", // have Eido draft a reply for the queue
  "obligation:resolve", // mark a ledger obligation done
  "document:update", // set a document's type, or file a document action
  "folders:update", // add, review or remove a watched folder
  "connector:update", // repin, sync or assign accounts on a connector
  "profile:update", // edit the profile, entities and their assignments
  "notifications:update", // add or remove a push subscription
] as const

export type Permission = (typeof PERMISSIONS)[number]

/**
 * The permissions each role holds. The owner holds every one. The assistant holds none yet:
 * every action the web app offers today is approval work or the owner's own setup, and the
 * hand-off workspace that gives the assistant actions is issue 382. Changing this map is a
 * change to who may do what; record it in docs/auth0-setup.md in the same PR.
 */
export const ROLE_PERMISSIONS = {
  owner: PERMISSIONS,
  assistant: [],
} as const satisfies Record<Role, readonly Permission[]>

/** Whether `role` holds `permission`. False for no role and for any string not in the list. */
export function roleHas(
  role: Role | null,
  permission: string,
  map: Readonly<Record<Role, readonly string[]>> = ROLE_PERMISSIONS
): boolean {
  if (role === null) return false
  return map[role].includes(permission)
}

/** The session claims a permission check reads: the role claims, plus the Auth0 user id. */
export type PermissionUser = RoleClaims & { readonly sub?: unknown }

/**
 * Whether the signed-in user may take the action. The UI uses this to hide or disable a
 * control the user lacks, so nobody sees a button that only fails. Hiding is not the check:
 * the server action or route handler still calls `requirePermission`.
 */
export function can(
  user: PermissionUser | null | undefined,
  permission: Permission
): boolean {
  return roleHas(roleFor(user), permission)
}

/** One refusal, as logged. Carries the Auth0 user id, never the email address. */
export type PermissionRefusal = {
  readonly event: "permission_denied"
  readonly role: Role | "none"
  readonly permission: Permission
  readonly route: string
  readonly userId: string | null
}

function refusalRecord(
  user: PermissionUser | null | undefined,
  role: Role | null,
  permission: Permission,
  route: string
): PermissionRefusal {
  return {
    event: "permission_denied",
    role: role ?? "none",
    permission,
    route,
    userId: typeof user?.sub === "string" ? user.sub : null,
  }
}

/**
 * The check every mutating server action and route handler runs before it acts. Returns
 * null when the user holds `permission`. Otherwise logs the refusal (role, permission, route,
 * Auth0 user id) and returns the 403 response to send; a server action calls `forbidden()`
 * instead. `route` is the handler's path, for example "/api/drafts/send".
 *
 *     const denied = requirePermission(session?.user, "draft:create", "/api/drafts")
 *     if (denied) return denied
 */
export function requirePermission(
  user: PermissionUser | null | undefined,
  permission: Permission,
  route: string,
  log: (line: string) => void = console.warn
): Response | null {
  const role = roleFor(user)
  if (roleHas(role, permission)) return null
  log(JSON.stringify(refusalRecord(user, role, permission, route)))
  return Response.json(
    { error: "forbidden", message: "You do not have access to this action." },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  )
}
