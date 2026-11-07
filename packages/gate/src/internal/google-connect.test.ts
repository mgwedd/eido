import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  validateGateGoogleConnectPrepared,
  validateGateGoogleConnectStarted,
} from "@eido/schemas"
import type { GateGoogleConnectPrepared } from "@eido/schemas"
import {
  FLOW_TTL_MS,
  googleCallback,
  googleControlRoute,
  GoogleFlows,
  isGoogleTarget,
  prepareGoogleConnect,
  startGoogleConnect,
} from "./google-connect"
import type { GoogleConnect } from "./google-connect"
import type { GateRequest, Reply } from "./http"
import {
  auditRows,
  controlAuthorization,
  loggedText,
  MAIL_OPS,
  manifest,
  setup,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"
import { InMemoryVault } from "./vault/vault"
import type { VaultKey } from "./vault/vault"

// Synthetic values only; hosts are example.invalid.
const WEB_ORIGIN = "https://eido.example.invalid:8443"
const REDIRECT = `${WEB_ORIGIN}/api/gate/connect/google/callback`
const CLIENT_ID = "test-client.apps.example.invalid"
const SECRET = ["test", "client", "secret", "662"].join("-")
const OTHER_SECRET = ["test", "other", "secret", "662"].join("-")
const REFRESH = ["test", "refresh", "662"].join("-")
const CODE = "test-auth-code-662"
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify"
const T0 = Date.parse("2026-11-06T08:00:00.000Z")

const key = (kind: VaultKey["kind"]): VaultKey => ({
  connector: "gmail",
  kind,
  client: "write",
})

let s: Setup
let vault: InMemoryVault
let google: GoogleConnect
let exchanges: URLSearchParams[]
let tokenAnswer: () => Response
let probed: number

beforeEach(() => {
  s = setup([manifest("gmail", MAIL_OPS)])
  vault = new InMemoryVault()
  exchanges = []
  probed = 0
  tokenAnswer = () =>
    Response.json({ refresh_token: REFRESH, scope: GMAIL_MODIFY })
  google = {
    db: s.db,
    vault,
    flows: new GoogleFlows(),
    redirectUri: REDIRECT,
    webOrigin: WEB_ORIGIN,
    clientIds: { gmail: CLIENT_ID },
    probes: {
      gmail: () => {
        probed += 1
        return Promise.resolve("ok")
      },
    },
    fetch: (_input, init) => {
      exchanges.push(
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams()
      )
      return Promise.resolve(tokenAnswer())
    },
  }
})
afterEach(() => s.cleanup())

const code = (reply: Reply): unknown =>
  typeof reply.body === "object" && reply.body !== null && "code" in reply.body
    ? reply.body.code
    : undefined

async function prepared(): Promise<GateGoogleConnectPrepared> {
  const reply = await prepareGoogleConnect(google, "gmail")
  const parsed = validateGateGoogleConnectPrepared(reply.body)
  if (!parsed.ok) throw new Error("prepare does not match the schema")
  return parsed.value
}

/** Starts a signed sign-in and returns Google's consent URL params and the flow id. */
async function started(clientSecret?: string) {
  const { approval } = await prepared()
  const reply = await startGoogleConnect(
    google,
    {
      authorization: controlAuthorization(google.db, approval),
      target: "gmail",
      ...(clientSecret === undefined ? {} : { clientSecret }),
    },
    T0
  )
  expect(reply.status).toBe(200)
  const parsed = validateGateGoogleConnectStarted(reply.body)
  if (!parsed.ok) throw new Error("start does not match the schema")
  return {
    flow: parsed.value.flow,
    url: new URL(parsed.value.authorizationUrl),
  }
}

const callback = (query: Record<string, string>, at = T0 + 1000) =>
  googleCallback(google, new URLSearchParams(query), () => at)

const location = (reply: Reply) => reply.headers?.["location"]

describe("GoogleFlows", () => {
  it("hands a state out once", () => {
    const flows = new GoogleFlows()
    const { state, flow } = flows.begin("gmail", undefined, T0)
    expect(flows.take(state, T0)?.flow).toBe(flow)
    expect(flows.take(state, T0)).toBeUndefined()
  })

  it("refuses a state at its expiry and forgets its flow", () => {
    const flows = new GoogleFlows(1000)
    const { state, flow } = flows.begin("gmail", undefined, T0)
    expect(flows.take(state, T0 + 1000)).toBeUndefined()
    expect(flows.outcome(flow, T0)).toBeUndefined()
  })

  it("keeps eight sign-ins and drops the oldest for a ninth", () => {
    const flows = new GoogleFlows()
    const begun = Array.from({ length: 9 }, () =>
      flows.begin("gmail", undefined, T0)
    )
    expect(flows.outcome(begun[0]?.flow ?? "", T0)).toBeUndefined()
    expect(flows.outcome(begun[1]?.flow ?? "", T0)).toEqual({
      status: "pending",
    })
    expect(flows.take(begun[8]?.state ?? "", T0)).toBeDefined()
  })

  it("keeps an outcome for the TTL after it finishes", () => {
    const flows = new GoogleFlows()
    const { state, flow } = flows.begin("gmail", undefined, T0)
    flows.take(state, T0 + 5)
    flows.finish(flow, { status: "failed", reason: "denied" }, T0 + 5)
    expect(flows.outcome(flow, T0 + FLOW_TTL_MS)).toEqual({
      status: "failed",
      reason: "denied",
    })
    expect(flows.outcome(flow, T0 + 5 + FLOW_TTL_MS)).toBeUndefined()
  })
})

describe("prepareGoogleConnect", () => {
  it("signs over the client id, never the secret, and says whether a secret is stored", async () => {
    const first = await prepared()
    expect(first.clientSecretStored).toBe(false)
    expect(first.approval.target).toBe("connector_oauth:gmail")
    expect(JSON.parse(first.approval.payload)).toEqual({
      action: "connector.oauth.start",
      connector: "gmail",
      client: "write",
      clientId: CLIENT_ID,
    })
    await vault.set(key("api_key"), SECRET)
    expect((await prepared()).clientSecretStored).toBe(true)
  })

  it("answers 503 for a client with no id", async () => {
    const reply = await prepareGoogleConnect(google, "drive")
    expect([reply.status, code(reply)]).toEqual([503, "unavailable"])
  })
})

describe("startGoogleConnect", () => {
  it("returns Google's consent address for the gate's callback", async () => {
    const { url } = await started(SECRET)
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    )
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT)
    expect(url.searchParams.get("scope")).toBe(GMAIL_MODIFY)
    expect(url.toString()).not.toContain(SECRET)
    expect(auditRows(s.db).at(-1)?.action).toBe("connector.oauth.started")
  })

  it("refuses a forged signature", async () => {
    const { approval } = await prepared()
    const authorization = controlAuthorization(s.db, approval)
    const reply = await startGoogleConnect(
      google,
      {
        authorization: {
          config: authorization.config,
          request: { id: approval.id, nonce: "forged", assertion: {} },
        },
        target: "gmail",
        clientSecret: SECRET,
      },
      T0
    )
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
  })

  it("asks for the secret before spending the approval when the vault has none", async () => {
    const { approval } = await prepared()
    const authorization = controlAuthorization(s.db, approval)
    const refused = await startGoogleConnect(
      google,
      { authorization, target: "gmail" },
      T0
    )
    expect([refused.status, code(refused)]).toEqual([
      400,
      "client_secret_required",
    ])
    const retried = await startGoogleConnect(
      google,
      { authorization, target: "gmail", clientSecret: SECRET },
      T0
    )
    expect(retried.status).toBe(200)
  })
})

describe("googleCallback", () => {
  it("stores the refresh token and the new secret, drops the old access token, and checks the connector", async () => {
    await vault.set(key("access_token"), "test-old-access-662")
    const { url, flow } = await started(SECRET)
    const reply = await callback({
      state: url.searchParams.get("state") ?? "",
      code: CODE,
    })
    expect([reply.status, location(reply)]).toEqual([
      303,
      `${WEB_ORIGIN}/admin/connectors?google=gmail&connected=healthy`,
    ])
    expect(exchanges[0]?.get("client_secret")).toBe(SECRET)
    expect(exchanges[0]?.get("redirect_uri")).toBe(REDIRECT)
    expect(await vault.get(key("refresh_token"))).toBe(REFRESH)
    expect(await vault.get(key("api_key"))).toBe(SECRET)
    expect(await vault.get(key("access_token"))).toBeUndefined()
    expect(probed).toBe(1)
    expect(google.flows.outcome(flow, T0 + 2000)).toMatchObject({
      status: "connected",
    })
    const text = loggedText(s.db)
    for (const value of [SECRET, REFRESH, CODE])
      expect(text).not.toContain(value)
  })

  it("keeps the stored secret and ignores the request's copy", async () => {
    await vault.set(key("api_key"), SECRET)
    const { url } = await started(OTHER_SECRET)
    await callback({ state: url.searchParams.get("state") ?? "", code: CODE })
    expect(exchanges[0]?.get("client_secret")).toBe(SECRET)
    expect(await vault.get(key("api_key"))).toBe(SECRET)
  })

  it("reports an unpinned connector without probing it", async () => {
    const empty = setup([])
    google = { ...google, db: empty.db }
    const { url } = await started(SECRET)
    const reply = await callback({
      state: url.searchParams.get("state") ?? "",
      code: CODE,
    })
    expect(location(reply)).toBe(
      `${WEB_ORIGIN}/admin/connectors?google=gmail&connected=unpinned`
    )
    expect(probed).toBe(0)
    empty.cleanup()
  })

  it("changes nothing for an unknown or used state", async () => {
    const { url } = await started(SECRET)
    const state = url.searchParams.get("state") ?? ""
    await callback({ state, code: CODE })
    const again = await callback({ state, code: CODE })
    expect(location(again)).toBe(`${WEB_ORIGIN}/admin/connectors?error=expired`)
    expect(location(await callback({ state: "forged", code: CODE }))).toBe(
      `${WEB_ORIGIN}/admin/connectors?error=expired`
    )
    expect(exchanges).toHaveLength(1)
  })

  it("refuses a state past its ten minutes", async () => {
    const { url } = await started(SECRET)
    const reply = await callback(
      { state: url.searchParams.get("state") ?? "", code: CODE },
      T0 + FLOW_TTL_MS
    )
    expect(location(reply)).toBe(`${WEB_ORIGIN}/admin/connectors?error=expired`)
    expect(exchanges).toEqual([])
  })

  it.each([
    [{ error: "access_denied" }, "denied"],
    [{ code: "has space" }, "invalid_callback"],
    [{}, "invalid_callback"],
  ])("fails %j as %s and stores nothing", async (answer, reason) => {
    const { url, flow } = await started(SECRET)
    const reply = await callback({
      state: url.searchParams.get("state") ?? "",
      ...answer,
    })
    expect(location(reply)).toBe(
      `${WEB_ORIGIN}/admin/connectors?google=gmail&error=${reason}`
    )
    expect(google.flows.outcome(flow, T0 + 2000)).toEqual({
      status: "failed",
      reason,
    })
    expect(exchanges).toEqual([])
    expect(await vault.get(key("api_key"))).toBeUndefined()
    expect(auditRows(s.db).at(-1)?.action).toBe("connector.oauth.failed")
  })

  it.each([
    [
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      "token_endpoint_refused",
    ],
    [() => Response.json({ scope: GMAIL_MODIFY }), "no_refresh_token"],
    [
      () => Response.json({ refresh_token: REFRESH, scope: "openid" }),
      "scope_not_granted",
    ],
  ])("fails a bad token answer as %#", async (answer, reason) => {
    tokenAnswer = answer
    const { url } = await started(SECRET)
    const reply = await callback({
      state: url.searchParams.get("state") ?? "",
      code: CODE,
    })
    expect(location(reply)).toBe(
      `${WEB_ORIGIN}/admin/connectors?google=gmail&error=${reason}`
    )
    expect(await vault.get(key("refresh_token"))).toBeUndefined()
    expect(await vault.get(key("api_key"))).toBeUndefined()
  })

  it("fails as unreachable when Google cannot be reached", async () => {
    google = { ...google, fetch: () => Promise.reject(new Error("offline")) }
    const { url } = await started(SECRET)
    const reply = await callback({
      state: url.searchParams.get("state") ?? "",
      code: CODE,
    })
    expect(location(reply)).toBe(
      `${WEB_ORIGIN}/admin/connectors?google=gmail&error=token_endpoint_unreachable`
    )
  })

  it("fails without exchanging when the client id was removed since the start", async () => {
    const { url } = await started(SECRET)
    google = { ...google, clientIds: {} }
    const reply = await callback({
      state: url.searchParams.get("state") ?? "",
      code: CODE,
    })
    expect(location(reply)).toBe(
      `${WEB_ORIGIN}/admin/connectors?google=gmail&error=token_endpoint_refused`
    )
    expect(exchanges).toEqual([])
  })
})

describe("googleControlRoute", () => {
  const request = (
    method: string,
    path: string,
    body: string | null = ""
  ): GateRequest => ({
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    body: () =>
      Promise.resolve(body === null ? { ok: false } : { ok: true, text: body }),
  })
  const now = () => T0

  it("leaves other routes alone", async () => {
    expect(
      await googleControlRoute(
        request("GET", "/connect/google/start"),
        google,
        now
      )
    ).toBeUndefined()
    expect(
      await googleControlRoute(request("GET", "/health"), google, now)
    ).toBeUndefined()
  })

  it("answers 503 when Google is not configured", async () => {
    const reply = await googleControlRoute(
      request("POST", "/connect/google/start", "{}"),
      undefined,
      now
    )
    expect([reply?.status, reply && code(reply)]).toEqual([503, "unavailable"])
  })

  it("starts a local sign-in and reports its flow", async () => {
    const reply = await googleControlRoute(
      request(
        "POST",
        "/connect/google/start",
        JSON.stringify({ target: "gmail", clientSecret: SECRET })
      ),
      google,
      now
    )
    const parsed = validateGateGoogleConnectStarted(reply?.body)
    if (!parsed.ok) throw new Error("start does not match the schema")
    const flow = await googleControlRoute(
      request("GET", `/connect/google/flows/${parsed.value.flow}`),
      google,
      now
    )
    expect(flow).toEqual({ status: 200, body: { status: "pending" } })
    const unknown = await googleControlRoute(
      request("GET", `/connect/google/flows/${"a".repeat(43)}`),
      google,
      now
    )
    expect([unknown?.status, unknown && code(unknown)]).toEqual([
      404,
      "not_found",
    ])
  })

  it.each([
    ["not json", "{", 400],
    ["not a request", JSON.stringify({ target: "proton" }), 400],
    ["too large", null, 413],
  ])("refuses a body that is %s", async (_name, body, status) => {
    const reply = await googleControlRoute(
      request("POST", "/connect/google/start", body),
      google,
      now
    )
    expect([reply?.status, reply && code(reply)]).toEqual([
      status,
      "invalid_request",
    ])
  })
})

describe("isGoogleTarget", () => {
  it("knows the three clients and nothing inherited", () => {
    expect(
      ["gmail", "gmail-read", "drive", "toString"].map(isGoogleTarget)
    ).toEqual([true, true, true, false])
  })
})
