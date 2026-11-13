import { generateKeyPairSync, type KeyObject } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

import {
  clearedCoreRoleCookie,
  coreRoleCookie,
  coreRoleKeyFromEnv,
  CORE_ROLE_COOKIE,
  CORE_ROLE_TTL_SECONDS,
  issueCoreRole,
  parseCoreRoleKey,
} from "@/lib/auth/core-role"
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/auth/permissions"

// Core's real verifier. apps/web may not import @eido/core (.dependency-cruiser.mts), so the
// file is loaded by path at run time: this test is the one place the two sides meet, and it
// fails if the issuer and the verifier drift apart.
const CORE_CALLER_ROLE = fileURLToPath(
  new URL("../../../packages/core/src/api/caller-role.ts", import.meta.url)
)
// The slice of core's verifier this test uses (a type import would cross the boundary too).
type Core = {
  ROLE_COOKIE: string
  rolePublicKey: (value: string) => KeyObject
  verifyRoleAssertion: (
    token: string,
    publicKey: KeyObject,
    nowSeconds: number
  ) => {
    sub: string
    role: string
    permissions: string[]
    exp: number
  } | null
  createRoleGuard: (
    publicKey: KeyObject,
    now?: () => Date
  ) => (request: Request, path: string) => Response | null
}
const core = (await import(
  /* @vite-ignore */ pathToFileURL(CORE_CALLER_ROLE).href
)) as Core

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const NOW = new Date("2026-11-13T12:00:00Z")
const nowSeconds = NOW.getTime() / 1000
const corePublicKey = (key: KeyObject = publicKey) =>
  core.rolePublicKey(
    key.export({ format: "der", type: "spki" }).toString("base64")
  )

describe("an issued assertion, checked with core's verifier", () => {
  it("round-trips for the owner with every permission", () => {
    const token = issueCoreRole(
      { sub: "auth0|owner", role: "owner" },
      privateKey,
      NOW
    )
    expect(
      core.verifyRoleAssertion(token, corePublicKey(), nowSeconds)
    ).toEqual({
      sub: "auth0|owner",
      role: "owner",
      permissions: [...PERMISSIONS],
      exp: nowSeconds + CORE_ROLE_TTL_SECONDS,
    })
  })

  it("carries the assistant's (empty) permissions from ROLE_PERMISSIONS", () => {
    const token = issueCoreRole(
      { sub: "auth0|helper", role: "assistant" },
      privateKey,
      NOW
    )
    const claims = core.verifyRoleAssertion(token, corePublicKey(), nowSeconds)
    expect(claims?.role).toBe("assistant")
    expect(claims?.permissions).toEqual([...ROLE_PERMISSIONS.assistant])
  })

  it("lapses at exp", () => {
    const token = issueCoreRole({ sub: "s", role: "owner" }, privateKey, NOW)
    const exp = nowSeconds + CORE_ROLE_TTL_SECONDS
    expect(core.verifyRoleAssertion(token, corePublicKey(), exp - 1)).not.toBe(
      null
    )
    expect(core.verifyRoleAssertion(token, corePublicKey(), exp)).toBeNull()
  })

  it("is refused under another key and when edited", () => {
    const token = issueCoreRole(
      { sub: "s", role: "assistant" },
      privateKey,
      NOW
    )
    const other = generateKeyPairSync("ed25519").publicKey
    expect(
      core.verifyRoleAssertion(token, corePublicKey(other), nowSeconds)
    ).toBeNull()
    const [payload, signature] = token.split(".") as [string, string]
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        role: "owner",
      })
    ).toString("base64url")
    expect(
      core.verifyRoleAssertion(
        `${edited}.${signature}`,
        corePublicKey(),
        nowSeconds
      )
    ).toBeNull()
  })

  it("lets core's guard through for the owner and answers 403 to the assistant", () => {
    const guard = core.createRoleGuard(corePublicKey(), () => NOW)
    const post = (role: "owner" | "assistant", path: string) =>
      guard(
        new Request(`http://core.test/api/core${path}`, {
          method: "POST",
          headers: {
            cookie: `${core.ROLE_COOKIE}=${issueCoreRole({ sub: "s", role }, privateKey, NOW)}`,
          },
        }),
        path
      )
    expect(post("owner", "/ask")).toBeNull()
    expect(post("owner", "/obligations/1/done")).toBeNull()
    expect(post("assistant", "/ask")?.status).toBe(403)
    expect(post("assistant", "/obligations/1/done")?.status).toBe(403)
    expect(
      core.createRoleGuard(corePublicKey())(
        new Request("http://core.test/x", { method: "POST" }),
        "/ask"
      )?.status
    ).toBe(401)
  })

  it("uses the cookie name core reads", () => {
    expect(CORE_ROLE_COOKIE).toBe(core.ROLE_COOKIE)
  })
})

describe("the cookie", () => {
  it("is HttpOnly, Secure, SameSite=Strict, scoped to /api/core and short-lived", () => {
    expect(coreRoleCookie("a.b")).toBe(
      `eido_core_role=a.b; Path=/api/core; HttpOnly; Secure; SameSite=Strict; Max-Age=${CORE_ROLE_TTL_SECONDS}`
    )
  })

  it("is removed with the same scope", () => {
    expect(clearedCoreRoleCookie()).toBe(
      "eido_core_role=; Path=/api/core; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    )
  })
})

describe("the signing key", () => {
  const pkcs8 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64")

  it("reads a base64 PKCS#8 Ed25519 key", () => {
    expect(parseCoreRoleKey(pkcs8).asymmetricKeyType).toBe("ed25519")
    expect(
      coreRoleKeyFromEnv({ EIDO_WEB_ROLE_PRIVATE_KEY: ` ${pkcs8} ` })
    ).not.toBeNull()
  })

  it("is null when unset or blank", () => {
    expect(coreRoleKeyFromEnv({})).toBeNull()
    expect(coreRoleKeyFromEnv({ EIDO_WEB_ROLE_PRIVATE_KEY: "  " })).toBeNull()
  })

  it("refuses garbage and keys of another type", () => {
    expect(() => parseCoreRoleKey("not a key")).toThrow(/PKCS#8 Ed25519/)
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    expect(() =>
      parseCoreRoleKey(
        rsa.export({ format: "der", type: "pkcs8" }).toString("base64")
      )
    ).toThrow(/Ed25519/)
  })
})
