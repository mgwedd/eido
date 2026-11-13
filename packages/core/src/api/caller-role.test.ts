import { generateKeyPairSync, sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { openIndex } from "../index/schema"
import { createProfileStore } from "../profile/index"
import {
  ROLE_COOKIE,
  createRoleGuard,
  permissionsFor,
  readCookie,
  verifyRoleAssertion,
} from "./caller-role"
import type { RoleAssertion } from "./caller-role"
import { listenCoreApi } from "./listen"
import type { CoreApi } from "./listen"

const web = generateKeyPairSync("ed25519")
const stranger = generateKeyPairSync("ed25519")
const NOW = new Date("2026-01-01T12:00:00Z")
const nowSeconds = NOW.getTime() / 1000

function token(
  claims: Partial<RoleAssertion> | Record<string, unknown>,
  privateKey: KeyObject = web.privateKey
): string {
  const payload = Buffer.from(
    JSON.stringify({
      sub: "auth0|assistant-1",
      role: "assistant",
      permissions: [],
      exp: nowSeconds + 600,
      ...claims,
    })
  ).toString("base64url")
  const signature = sign(null, Buffer.from(payload), privateKey)
  return `${payload}.${signature.toString("base64url")}`
}

const OWNER = token({
  sub: "auth0|owner",
  role: "owner",
  permissions: ["profile:update", "obligation:resolve", "ask:query"],
})
const ASSISTANT = token({})

describe("verifyRoleAssertion", () => {
  it("returns the claims of a token the web app signed", () => {
    expect(verifyRoleAssertion(OWNER, web.publicKey, nowSeconds)).toEqual({
      sub: "auth0|owner",
      role: "owner",
      permissions: ["profile:update", "obligation:resolve", "ask:query"],
      exp: nowSeconds + 600,
    })
  })

  it("rejects a token signed by another key", () => {
    const forged = token({ role: "owner" }, stranger.privateKey)
    expect(verifyRoleAssertion(forged, web.publicKey, nowSeconds)).toBeNull()
  })

  it("rejects a payload edited after signing", () => {
    const signature = ASSISTANT.split(".")[1]
    const edited = Buffer.from(
      JSON.stringify({
        sub: "x",
        role: "owner",
        permissions: ["profile:update"],
        exp: nowSeconds + 600,
      })
    ).toString("base64url")
    expect(
      verifyRoleAssertion(`${edited}.${signature}`, web.publicKey, nowSeconds)
    ).toBeNull()
  })

  it("rejects a lapsed token, including at the second it lapses", () => {
    const lapsed = token({ exp: nowSeconds })
    expect(verifyRoleAssertion(lapsed, web.publicKey, nowSeconds)).toBeNull()
    expect(
      verifyRoleAssertion(lapsed, web.publicKey, nowSeconds - 1)
    ).not.toBeNull()
  })

  it.each([
    ["no dot", "abc"],
    ["three parts", "a.b.c"],
    ["empty", ""],
    ["bad signature bytes", "e30.!!"],
  ])("rejects a malformed token: %s", (_name, bad) => {
    expect(verifyRoleAssertion(bad, web.publicKey, nowSeconds)).toBeNull()
  })

  it.each([
    ["a role outside owner and assistant", { role: "admin" }],
    ["permissions that are not strings", { permissions: [1] }],
    ["an expiry that is not a number", { exp: "soon" }],
    ["a subject that is not a string", { sub: 7 }],
  ])("rejects signed claims with %s", (_name, claims) => {
    expect(
      verifyRoleAssertion(token(claims), web.publicKey, nowSeconds)
    ).toBeNull()
  })

  it("rejects a signed payload that is not JSON", () => {
    const payload = Buffer.from("not json").toString("base64url")
    const signature = sign(null, Buffer.from(payload), web.privateKey)
    expect(
      verifyRoleAssertion(
        `${payload}.${signature.toString("base64url")}`,
        web.publicKey,
        nowSeconds
      )
    ).toBeNull()
  })
})

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie(`a=1; ${ROLE_COOKIE}=tok.sig; b=2`, ROLE_COOKIE)).toBe(
      "tok.sig"
    )
  })
  it("does not match a cookie whose name only ends the same way", () => {
    expect(readCookie(`x${ROLE_COOKIE}=nope`, ROLE_COOKIE)).toBeNull()
  })
  it("returns null without a header", () => {
    expect(readCookie(null, ROLE_COOKIE)).toBeNull()
  })
})

describe("permissionsFor", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get"])("%s changes nothing", (m) => {
    expect(permissionsFor(m, "/profile")).toBeNull()
  })

  it.each([
    ["PATCH", "/profile", ["profile:update"]],
    ["PUT", "/default-entity", ["profile:update"]],
    ["POST", "/entities", ["profile:update"]],
    ["DELETE", "/entities/e1", ["profile:update"]],
    ["PUT", "/entity-assignments", ["profile:update"]],
    ["POST", "/connectors/simplefin/sync", ["connector:update"]],
    ["PUT", "/connectors/simplefin/assignments", ["connector:update"]],
    ["POST", "/ask", ["ask:query"]],
    ["POST", "/replies/draft", ["draft:create"]],
    ["POST", "/intents", ["document:update", "ask:query"]],
    ["POST", "/obligations/o1/resolve", ["obligation:resolve"]],
    ["PUT", `/documents/${"a".repeat(64)}/type`, ["document:update"]],
    ["POST", "/extractions/12/confirm", ["document:update"]],
  ])("%s %s needs %j", (method, path, needed) => {
    expect(permissionsFor(method, path)).toEqual(needed)
  })

  it("gives a state-changing request no row names an empty list, so nobody holds it", () => {
    expect(permissionsFor("POST", "/brand-new-route")).toEqual([])
    expect(permissionsFor("DELETE", "/profile")).toEqual([])
  })
})

describe("createRoleGuard", () => {
  const guard = createRoleGuard(web.publicKey, () => NOW)
  const call = (method: string, path: string, jwt?: string) =>
    guard(
      new Request(`http://127.0.0.1:8789${path}`, {
        method,
        headers: jwt === undefined ? {} : { cookie: `${ROLE_COOKIE}=${jwt}` },
      }),
      path
    )

  it("lets a read through with no assertion", () => {
    expect(call("GET", "/profile")).toBeNull()
  })

  it("answers 401 to a change with no cookie", async () => {
    const response = call("PATCH", "/profile")
    expect(response?.status).toBe(401)
    expect(await response?.json()).toEqual({
      error: { code: "unauthenticated", message: "sign in again" },
    })
  })

  it("answers 401 to a change whose assertion has lapsed", () => {
    const lapsed = token({
      exp: nowSeconds - 1,
      permissions: ["profile:update"],
    })
    expect(call("PATCH", "/profile", lapsed)?.status).toBe(401)
  })

  it("answers 403 to an assistant for every change it holds no permission for", () => {
    expect(call("PATCH", "/profile", ASSISTANT)?.status).toBe(403)
    expect(call("POST", "/obligations/o1/done", ASSISTANT)?.status).toBe(403)
  })

  it("lets a role through the route its permission names, and no other", () => {
    expect(call("PATCH", "/profile", OWNER)).toBeNull()
    expect(call("POST", "/replies/draft", OWNER)?.status).toBe(403)
  })

  it("refuses an unlisted state-changing route even for a role with every listed permission", () => {
    expect(call("POST", "/brand-new-route", OWNER)?.status).toBe(403)
  })
})

describe("core over HTTP with a role key", () => {
  const open: CoreApi[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((api) => api.close()))
  })

  async function send(
    method: string,
    path: string,
    jwt?: string
  ): Promise<{ status: number; body: string }> {
    const api = await listenCoreApi({
      profile: createProfileStore(openIndex(":memory:"), {
        audit: () => Promise.resolve(),
      }),
      host: "127.0.0.1",
      port: 0,
      basePath: "/api/core",
      allowedHosts: [],
      rolePublicKey: web.publicKey,
    })
    open.push(api)
    const response = await fetch(`http://${api.host}:${api.port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(jwt === undefined ? {} : { cookie: `${ROLE_COOKIE}=${jwt}` }),
      },
      body:
        method === "GET"
          ? undefined
          : JSON.stringify({
              displayName: "Test Owner",
              timezone: "Europe/Zurich",
              signature: "New",
            }),
    })
    return { status: response.status, body: await response.text() }
  }

  // The listener reads the real clock, so sign a fresh assertion.
  const live = (claims: Partial<RoleAssertion>) =>
    token({ exp: Date.now() / 1000 + 600, ...claims })

  it("refuses an assistant's direct PATCH /api/core/profile", async () => {
    const refused = await send("PATCH", "/api/core/profile", live({}))
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body)).toEqual({
      error: {
        code: "forbidden",
        message: "you do not have access to this action",
      },
    })
  })

  it("serves the same PATCH to a role holding profile:update", async () => {
    const allowed = await send(
      "PATCH",
      "/api/core/profile",
      live({ role: "owner", permissions: ["profile:update"] })
    )
    expect(allowed.status).toBe(200)
  })

  it("still serves reads without an assertion", async () => {
    expect((await send("GET", "/api/core/profile")).status).toBe(200)
  })
})
