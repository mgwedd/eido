import { createPublicKey, verify } from "node:crypto"
import type { KeyObject } from "node:crypto"
import type { CoreApiError } from "@eido/schemas"

// Core's API has no sign-in of its own, and the browser reaches it straight through `tailscale
// serve`, past Next. So the web app (which holds the Auth0 session) signs a short-lived role
// assertion and the browser carries it to core as a cookie. Core holds only the public key: it
// can check an assertion, never make one. Configured (EIDO_CORE_ROLE_PUBLIC_KEY), every
// state-changing request needs an assertion that lists the permission the route requires.
// Unconfigured (single-owner mode, no Auth0), core behaves as before. See ADR 0010.

/** The cookie the web app sets with `Path=/api/core; HttpOnly; Secure; SameSite=Strict`. */
export const ROLE_COOKIE = "eido_core_role"

/** What the web app signs: who, which role, and what that role may do, until `exp`. */
export type RoleAssertion = {
  readonly sub: string
  readonly role: "owner" | "assistant"
  readonly permissions: readonly string[]
  /** Seconds since the epoch. */
  readonly exp: number
}

function isRoleAssertion(value: unknown): value is RoleAssertion {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v["sub"] === "string" &&
    (v["role"] === "owner" || v["role"] === "assistant") &&
    Array.isArray(v["permissions"]) &&
    v["permissions"].every((p) => typeof p === "string") &&
    typeof v["exp"] === "number"
  )
}

/**
 * Checks `<payload>.<signature>` (both base64url; the signature is Ed25519 over the payload
 * text) and returns the assertion, or null for a bad signature, malformed payload or a lapsed
 * `exp`.
 */
export function verifyRoleAssertion(
  token: string,
  publicKey: KeyObject,
  nowSeconds: number
): RoleAssertion | null {
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [payload, signature] = parts as [string, string]
  let valid = false
  try {
    valid = verify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(signature, "base64url")
    )
  } catch {
    return null
  }
  if (!valid) return null
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!isRoleAssertion(claims)) return null
  return claims.exp > nowSeconds ? claims : null
}

/** `value` (base64 of an Ed25519 SPKI public key) as a key; anything else throws. */
export function rolePublicKey(value: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(value, "base64"),
    format: "der",
    type: "spki",
  })
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("EIDO_CORE_ROLE_PUBLIC_KEY must be an Ed25519 public key")
  }
  return key
}

/** The value of cookie `name` in a `Cookie` header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** Each state-changing route and the permissions that allow it (any one of them). */
const ROUTE_PERMISSIONS: readonly {
  methods: readonly string[]
  path: RegExp
  anyOf: readonly string[]
}[] = [
  { methods: ["PATCH"], path: /^\/profile$/, anyOf: ["profile:update"] },
  { methods: ["PUT"], path: /^\/default-entity$/, anyOf: ["profile:update"] },
  { methods: ["POST"], path: /^\/entities$/, anyOf: ["profile:update"] },
  {
    methods: ["PATCH", "DELETE"],
    path: /^\/entities\/[^/]+$/,
    anyOf: ["profile:update"],
  },
  {
    methods: ["PUT", "DELETE"],
    path: /^\/entity-assignments$/,
    anyOf: ["profile:update"],
  },
  {
    methods: ["POST"],
    path: /^\/connectors\/simplefin\/sync$/,
    anyOf: ["connector:update"],
  },
  {
    methods: ["PUT"],
    path: /^\/connectors\/simplefin\/assignments$/,
    anyOf: ["connector:update"],
  },
  { methods: ["POST"], path: /^\/ask$/, anyOf: ["ask:query"] },
  { methods: ["POST"], path: /^\/replies\/draft$/, anyOf: ["draft:create"] },
  // Proposals from the document actions and from Ask answers; the gate still needs the owner's
  // passkey signature to run them.
  {
    methods: ["POST"],
    path: /^\/intents$/,
    anyOf: ["document:update", "ask:query"],
  },
  {
    methods: ["POST"],
    path: /^\/obligations\/[^/]+\/(done|resolve|reopen)$/,
    anyOf: ["obligation:resolve"],
  },
  {
    methods: ["PUT"],
    path: /^\/documents\/[^/]+\/type$/,
    anyOf: ["document:update"],
  },
  {
    methods: ["POST"],
    path: /^\/extractions\/\d+\/confirm$/,
    anyOf: ["document:update"],
  },
]

/**
 * The permissions that allow `method` on `path` (below the base path), or null when the request
 * changes nothing. A state-changing request no row names gets an empty list: nobody holds it,
 * so a route added without a row here is refused rather than open.
 */
export function permissionsFor(
  method: string,
  path: string
): readonly string[] | null {
  const verb = method.toUpperCase()
  if (SAFE_METHODS.has(verb)) return null
  const row = ROUTE_PERMISSIONS.find(
    (r) => r.methods.includes(verb) && r.path.test(path)
  )
  return row?.anyOf ?? []
}

function refusal(
  status: 401 | 403,
  code: "unauthenticated" | "forbidden",
  message: string
): Response {
  const body: CoreApiError = { error: { code, message } }
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

export type RoleGuard = (request: Request, path: string) => Response | null

/**
 * The check run before a route. Null lets the request through; otherwise the response to send:
 * 401 with no valid assertion, 403 when the assertion lacks the permission the route needs.
 */
export function createRoleGuard(
  publicKey: KeyObject,
  now: () => Date = () => new Date()
): RoleGuard {
  return (request, path) => {
    const needed = permissionsFor(request.method, path)
    if (needed === null) return null
    const token = readCookie(request.headers.get("cookie"), ROLE_COOKIE)
    const assertion =
      token === null
        ? null
        : verifyRoleAssertion(token, publicKey, now().getTime() / 1000)
    if (assertion === null) {
      return refusal(401, "unauthenticated", "sign in again")
    }
    if (!needed.some((p) => assertion.permissions.includes(p))) {
      return refusal(403, "forbidden", "you do not have access to this action")
    }
    return null
  }
}
