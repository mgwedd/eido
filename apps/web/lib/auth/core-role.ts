import { createPrivateKey, sign, type KeyObject } from "node:crypto"

import { ROLE_PERMISSIONS } from "@/lib/auth/permissions"
import type { Role } from "@/lib/auth/roles"

// The role assertion core checks (ADR 0010, issue 720). Core's browser-facing API has no sign-in of
// its own and `tailscale serve` routes /api/core past Next, so this app signs a short-lived
// assertion of the Auth0 role and the browser carries it to core as a cookie. The format is
// fixed by core's verifier, `packages/core/src/api/caller-role.ts`: `base64url(payload).
// base64url(Ed25519 signature over the payload text)`, payload `{ sub, role, permissions, exp }`
// with `exp` in seconds. apps/web imports no other workspace package, so the contract is held by
// test/core-role.test.ts, which checks an issued assertion with core's real verifier.

/** The cookie core reads. Scoped to /api/core so it goes nowhere else. */
export const CORE_ROLE_COOKIE = "eido_core_role"

/** The path the client posts to for a fresh assertion; the proxy answers it. */
export const CORE_ROLE_REFRESH_PATH = "/auth/core-role"

/** How long an assertion lasts. A revoked role keeps core access for at most this long. */
export const CORE_ROLE_TTL_SECONDS = 10 * 60

/** The private key variable: base64 of an Ed25519 PKCS#8 DER key. Read by this app only. */
export const CORE_ROLE_KEY_ENV = "EIDO_WEB_ROLE_PRIVATE_KEY"

export type CoreRoleClaims = {
  readonly sub: string
  readonly role: Role
  readonly permissions: readonly string[]
  /** Seconds since the epoch. */
  readonly exp: number
}

/** `value` (base64 PKCS#8 DER) as an Ed25519 private key; anything else throws. */
export function parseCoreRoleKey(value: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "pkcs8",
    })
  } catch {
    throw new Error(
      `${CORE_ROLE_KEY_ENV} must be a base64 PKCS#8 Ed25519 private key.`
    )
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${CORE_ROLE_KEY_ENV} must be an Ed25519 private key.`)
  }
  return key
}

/** The configured key, or null when unset (core then does not enforce roles). Throws if invalid. */
export function coreRoleKeyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): KeyObject | null {
  const value = env[CORE_ROLE_KEY_ENV]?.trim()
  return value ? parseCoreRoleKey(value) : null
}

/** The assertion for `sub` as `role`, valid for the TTL from `now`. */
export function issueCoreRole(
  user: { readonly sub: string; readonly role: Role },
  key: KeyObject,
  now: Date = new Date()
): string {
  const claims: CoreRoleClaims = {
    sub: user.sub,
    role: user.role,
    permissions: ROLE_PERMISSIONS[user.role],
    exp: Math.floor(now.getTime() / 1000) + CORE_ROLE_TTL_SECONDS,
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = sign(null, Buffer.from(payload), key).toString("base64url")
  return `${payload}.${signature}`
}

const COOKIE_ATTRIBUTES = "Path=/api/core; HttpOnly; Secure; SameSite=Strict"

/** The `Set-Cookie` value that carries an assertion until its `exp`. */
export function coreRoleCookie(token: string): string {
  return `${CORE_ROLE_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${CORE_ROLE_TTL_SECONDS}`
}

/** The `Set-Cookie` value that removes the cookie (sign-out, no role). */
export function clearedCoreRoleCookie(): string {
  return `${CORE_ROLE_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`
}
