import { createECDH, createHash, randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateConnectorSettings,
  validateGateCredentialStatus,
  validateGateDecisionResult,
  validateGateIntentHistory,
  validateGateLoginOptions,
  validateGatePendingIntentList,
  validateGatePrepareApproval,
  validateGateSession,
  validateGatePasskeyList,
  validateGatePermissionList,
} from "@eido/schemas"
import type { Body, GateRequest, Reply } from "./http"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { propose } from "./intents"
import { matchRoute, phoneHandler, routePath } from "./phone-routes"
import { preparePushRegistration } from "./push-subscriptions"
import type { PhoneState } from "./phone-routes"
import {
  assertion,
  controlAuthorization,
  deviceChallenge,
  sample,
  setup,
  testAuthenticator,
  WEBAUTHN,
} from "./test-fixtures"
import type { Setup, TestAuthenticator } from "./test-fixtures"

const HOST = "gate.example.invalid"
const START = new Date("2026-10-19T08:00:00.000Z")
const HOUR = 60 * 60 * 1000

let s: Setup
let state: PhoneState
let at: Date
let auth: TestAuthenticator

type Options = {
  host?: string | null
  cookie?: string
  body?: unknown
  raw?: Body
  contentType?: string | null
  basePath?: string
  query?: URLSearchParams
}

async function call(
  method: string,
  path: string,
  options: Options = {}
): Promise<Reply> {
  const handler = phoneHandler({
    gate: () => state,
    allowedHosts: [HOST],
    basePath: options.basePath ?? "",
    now: () => at,
  })
  const host = options.host === undefined ? HOST : options.host
  const contentType =
    options.contentType === undefined ? "application/json" : options.contentType
  const body: Body =
    options.raw ??
    (options.body === undefined
      ? { ok: true, text: "" }
      : { ok: true, text: JSON.stringify(options.body) })
  const request: GateRequest = {
    method,
    path: path.split("?")[0] ?? path,
    query: options.query ?? new URLSearchParams(path.split("?")[1] ?? ""),
    headers: {
      ...(host === null ? {} : { host }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(method === "POST" && contentType !== null ? { contentType } : {}),
    },
    body: () => Promise.resolve(body),
  }
  return handler(request)
}

function enrol(who: TestAuthenticator): void {
  s.db
    .prepare(
      "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
    )
    .run(who.credentialId, who.publicKey, START.toISOString())
}

function code(reply: Reply): unknown {
  return typeof reply.body === "object" &&
    reply.body !== null &&
    "code" in reply.body
    ? reply.body.code
    : undefined
}

async function signIn(): Promise<string> {
  const options = await call("POST", "/auth/login/options")
  const parsed = validateGateLoginOptions(options.body)
  if (!parsed.ok) throw new Error("login options do not match the schema")
  const reply = await call("POST", "/auth/login", {
    body: { assertion: assertion(auth, parsed.value.challenge) },
  })
  const cookie = reply.headers?.["set-cookie"]
  if (cookie === undefined)
    throw new Error(`login refused: ${String(code(reply))}`)
  return cookie.split(";")[0] ?? ""
}

function pendingSend(
  extra: { rationale?: string; subject?: string } = {}
): string {
  const result = propose(s.db, s.policy, {
    intent: sample(
      "email.send",
      extra.subject === undefined ? {} : { subject: extra.subject }
    ),
    origin: "reactive",
    contextPackId: "pack-1",
    documentIds: ["doc-1", "doc-2"],
    ...(extra.rationale === undefined ? {} : { rationale: extra.rationale }),
  })
  if (!result.ok || result.state !== "pending") throw new Error("not pending")
  return result.intentId
}

function intentState(id: string): unknown {
  return s.db.prepare("SELECT state FROM intents WHERE id = ?").get(id)?.[
    "state"
  ]
}

beforeEach(() => {
  s = setup()
  state = { db: s.db, policy: s.policy, webAuthn: WEBAUTHN }
  at = START
  auth = testAuthenticator()
})

describe("phoneHandler: push subscriptions", () => {
  it("returns unavailable when the gate has no configured push vault", async () => {
    enrol(auth)
    const cookie = await signIn()
    expect((await call("GET", "/push/key", { cookie })).status).toBe(503)
    expect(
      (await call("POST", "/push/prepare", { cookie, body: {} })).status
    ).toBe(503)
    expect(
      (await call("POST", "/push/subscriptions", { cookie, body: {} })).status
    ).toBe(503)
  })

  it("refuses a signed registration whose endpoint changed after preparation", async () => {
    enrol(auth)
    const cookie = await signIn()
    state.push = {
      publicKey: () => Promise.resolve("synthetic-public-key"),
      notifyPending: () => undefined,
    }
    const receiver = createECDH("prime256v1")
    receiver.generateKeys()
    const subscription = {
      endpoint: "https://push.example.invalid/one",
      p256dh: receiver
        .getPublicKey(undefined, "uncompressed")
        .toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    }
    const authorization = controlAuthorization(
      s.db,
      preparePushRegistration(s.db, subscription)
    )
    const changed = {
      ...subscription,
      endpoint: "https://other.example.invalid/one",
    }
    const reply = await call("POST", "/push/subscriptions", {
      cookie,
      body: { subscription: changed, approval: authorization.request },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect((await call("GET", "/push/subscriptions", { cookie })).body).toEqual(
      { subscriptions: [] }
    )
  })

  it("requires a session and a signed binding, then lists and removes the subscription", async () => {
    enrol(auth)
    const cookie = await signIn()
    state.push = {
      publicKey: () => Promise.resolve("synthetic-public-key"),
      notifyPending: () => undefined,
    }
    const receiver = createECDH("prime256v1")
    receiver.generateKeys()
    const subscription = {
      endpoint: "https://push.example.invalid/one",
      p256dh: receiver
        .getPublicKey(undefined, "uncompressed")
        .toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    }
    expect((await call("GET", "/push/key")).status).toBe(401)
    expect((await call("GET", "/push/key", { cookie })).body).toEqual({
      publicKey: "synthetic-public-key",
    })
    const prepared = await call("POST", "/push/prepare", {
      cookie,
      body: subscription,
    })
    expect(prepared.status).toBe(200)
    if (
      typeof prepared.body !== "object" ||
      prepared.body === null ||
      !("challenge" in prepared.body) ||
      !("purpose" in prepared.body)
    )
      throw new Error("push preparation did not return a challenge")
    expect(prepared.body.purpose).toBe("policy.set")
    expect(typeof prepared.body.challenge).toBe("string")
    expect(
      (
        await call("POST", "/push/prepare", {
          cookie,
          body: { ...subscription, endpoint: "http://localhost/send" },
        })
      ).status
    ).toBe(400)
    const unsigned = await call("POST", "/push/subscriptions", {
      cookie,
      body: { subscription, approval: {} },
    })
    expect(unsigned.status).toBe(400)
    const ceremony = preparePushRegistration(s.db, subscription)
    const authorization = controlAuthorization(s.db, ceremony)
    const registered = await call("POST", "/push/subscriptions", {
      cookie,
      body: { subscription, approval: authorization.request },
    })
    expect(registered.status).toBe(201)
    if (
      typeof registered.body !== "object" ||
      registered.body === null ||
      !("id" in registered.body) ||
      typeof registered.body.id !== "string"
    )
      throw new Error("registration did not return an id")
    const id = registered.body.id
    expect((await call("GET", "/push/subscriptions", { cookie })).body).toEqual(
      { subscriptions: [{ id }] }
    )
    expect((await call("POST", `/push/${id}/remove`, { cookie })).status).toBe(
      200
    )
    expect((await call("GET", "/push/subscriptions", { cookie })).body).toEqual(
      { subscriptions: [] }
    )
  })
})

describe("phoneHandler: authenticated settings reads", () => {
  it("rejects every settings read without a valid session cookie", async () => {
    for (const path of [
      "/audit",
      "/audit/chain",
      "/connector-settings",
      "/passkeys",
      "/permissions",
    ]) {
      expect((await call("GET", path)).status, path).toBe(401)
    }
  })

  it("returns live connector, passkey, policy and chain state after login", async () => {
    enrol(auth)
    const cookie = await signIn()
    const connectors = await call("GET", "/connector-settings", { cookie })
    const checkedConnectors = validateGateConnectorSettings(connectors.body)
    expect(checkedConnectors.ok).toBe(true)
    if (!checkedConnectors.ok) throw new Error("connector settings are invalid")
    const mail = checkedConnectors.value.connectors.find(
      (connector) => connector.name === "mail"
    )
    expect(mail).toMatchObject({ enabled: true, scopes: ["write"] })
    expect(Date.parse(mail?.pinnedAt ?? "")).not.toBeNaN()

    const passkeys = await call("GET", "/passkeys", { cookie })
    const checkedPasskeys = validateGatePasskeyList(passkeys.body)
    expect(checkedPasskeys.ok).toBe(true)
    if (!checkedPasskeys.ok) throw new Error("passkey list is invalid")
    expect(checkedPasskeys.value.passkeys).toContainEqual({
      fingerprint: createHash("sha256").update(auth.credentialId).digest("hex"),
      createdAt: START.toISOString(),
      revokedAt: null,
    })

    const permissions = await call("GET", "/permissions", { cookie })
    const checkedPermissions = validateGatePermissionList(permissions.body)
    expect(checkedPermissions.ok).toBe(true)
    if (!checkedPermissions.ok) throw new Error("permission list is invalid")
    expect(checkedPermissions.value.tiers).toContainEqual({
      kind: "email.archive",
      tier: "auto",
    })
    expect(checkedPermissions.value.tiers).toContainEqual({
      kind: "email.send",
      tier: "approval",
    })

    const chain = await call("GET", "/audit/chain", { cookie })
    expect(validateGateAuditChainStatus(chain.body)).toMatchObject({ ok: true })

    append(s.db, {
      actor: "owner",
      action: "owner.settings_read",
      target: "settings",
      detailHash: payloadHash({ source: "test" }),
    })
    append(s.db, {
      actor: "gate",
      action: "gate.settings_read",
      target: "settings",
      detailHash: payloadHash({ source: "test" }),
    })
    const audit = await call("GET", "/audit", { cookie })
    const checkedAudit = validateGateAuditPage(audit.body)
    expect(checkedAudit.ok).toBe(true)
    if (!checkedAudit.ok) throw new Error("audit page is invalid")
    expect(checkedAudit.value.entries).toContainEqual(
      expect.objectContaining({ actor: "owner", displayActor: "you" })
    )
    expect(checkedAudit.value.entries).toContainEqual(
      expect.objectContaining({ actor: "gate", displayActor: "gate" })
    )
  })

  it("pages audit rows by seq and derives undo from execution records", async () => {
    enrol(auth)
    const cookie = await signIn()
    const firstPage = await call("GET", "/audit?limit=1", { cookie })
    const first = validateGateAuditPage(firstPage.body)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error("audit page is invalid")
    expect(first.value.entries).toHaveLength(1)
    expect(first.value.nextBefore).toBeDefined()

    const priorPage = await call(
      "GET",
      `/audit?before=${first.value.nextBefore}&limit=1`,
      { cookie }
    )
    const prior = validateGateAuditPage(priorPage.body)
    expect(prior.ok).toBe(true)
    if (!prior.ok) throw new Error("audit cursor page is invalid")
    expect(prior.value.entries[0]?.seq).toBeLessThan(
      first.value.entries[0]?.seq ?? 0
    )

    const automatic = propose(s.db, s.policy, {
      intent: sample("email.archive"),
      origin: "reactive",
    })
    if (!automatic.ok) throw new Error("automatic intent was refused")
    const executed = append(s.db, {
      actor: "executor",
      action: "execute",
      target: automatic.intentId,
      detailHash: payloadHash({ result: "synthetic" }),
    })
    s.db
      .prepare("UPDATE intents SET state = 'executed' WHERE id = ?")
      .run(automatic.intentId)
    s.db
      .prepare(
        "INSERT INTO executions (intent_id, upstream_ref, result, inverse_op, audit_seq) VALUES (?, ?, ?, ?, ?)"
      )
      .run(automatic.intentId, "synthetic-ref", "{}", "{}", executed.seq)

    const completedUndo = append(s.db, {
      actor: "executor",
      action: "undo",
      target: automatic.intentId,
      detailHash: payloadHash({ result: "restored" }),
    })
    s.db
      .prepare(
        "INSERT INTO execution_undos (intent_id, upstream_ref, result, audit_seq) VALUES (?, ?, ?, ?)"
      )
      .run(automatic.intentId, "synthetic-ref", "{}", completedUndo.seq)

    const allRows = await call("GET", "/audit", { cookie })
    const parsed = validateGateAuditPage(allRows.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("audit page is invalid")
    const executeRow = parsed.value.entries.find(
      (entry) => entry.seq === executed.seq
    )
    expect(executeRow).toMatchObject({ displayActor: "auto", undo: "done" })
  })

  it("marks a reversible automatic execution as undoable until an undo is recorded", async () => {
    enrol(auth)
    const cookie = await signIn()
    const automatic = propose(s.db, s.policy, {
      intent: sample("email.archive"),
      origin: "reactive",
    })
    if (!automatic.ok) throw new Error("automatic intent was refused")
    const executed = append(s.db, {
      actor: "executor",
      action: "execute",
      target: automatic.intentId,
      detailHash: payloadHash({ result: "synthetic" }),
    })
    s.db
      .prepare("UPDATE intents SET state = 'executed' WHERE id = ?")
      .run(automatic.intentId)
    s.db
      .prepare(
        "INSERT INTO executions (intent_id, upstream_ref, result, inverse_op, audit_seq) VALUES (?, ?, ?, ?, ?)"
      )
      .run(automatic.intentId, "synthetic-ref", "{}", "{}", executed.seq)

    const reply = await call("GET", "/audit", { cookie })
    const parsed = validateGateAuditPage(reply.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("audit page is invalid")
    expect(
      parsed.value.entries.find((entry) => entry.seq === executed.seq)
    ).toMatchObject({ undo: "available" })
  })

  it("rejects malformed and unsupported audit page query parameters", async () => {
    enrol(auth)
    const cookie = await signIn()
    expect((await call("GET", "/audit?limit=bad", { cookie })).status).toBe(400)
    expect((await call("GET", "/audit?limit=0", { cookie })).status).toBe(400)
    expect(
      (await call("GET", "/audit?limit=1&limit=2", { cookie })).status
    ).toBe(400)
    expect((await call("GET", "/audit?unknown=1", { cookie })).status).toBe(400)
  })
})

afterEach(() => {
  s.cleanup()
})

describe("the route table", () => {
  it.each([
    ["GET", "/approvals", "/approvals", ""],
    ["GET", "/approvals/abc/history", "/approvals/:id/history", "abc"],
    ["POST", "/approvals/a%2Fb/nonce", "/approvals/:id/nonce", "a/b"],
    ["POST", "/auth/login", "/auth/login", ""],
  ])("matches %s %s", (method, path, route, id) => {
    expect(matchRoute(method, path)).toMatchObject({
      route: { path: route },
      id,
    })
  })

  it.each([
    ["POST", "/approvals"],
    ["GET", "/approvals/abc/nonce"],
    ["POST", "/approvals//nonce"],
    ["POST", "/approvals/%E0%A4%A/nonce"],
    ["GET", "/approvals/abc/history/more"],
  ])("matches nothing for %s %s", (method, path) => {
    expect(matchRoute(method, path)).toBeUndefined()
  })

  it.each([
    ["/api/gate/approvals", "/approvals"],
    ["/api/gate", "/"],
    ["/api/gateway/approvals", undefined],
    ["/approvals", undefined],
  ])("reads %s below the /api/gate base path as %s", (path, local) => {
    expect(routePath(path, "/api/gate")).toBe(local)
  })
})

describe("phoneHandler: listener rules", () => {
  // The admin listener's routes (#78), the control listener's and the data plane's.
  const foreign: readonly (readonly [string, string])[] = [
    ["POST", "/enrolment-codes"],
    ["POST", "/enrollment-codes"],
    ["POST", "/passkey/register/options"],
    ["POST", "/passkey/register"],
    ["POST", "/credentials/revoke"],
    ["POST", "/policy"],
    ["POST", "/connectors/mail/pin"],
    ["POST", "/audit"],
    ["POST", "/intents"],
    ["GET", "/intents"],
  ]

  it.each(foreign)("404s %s %s without a session", async (method, path) => {
    const reply = await call(method, path)
    expect([reply.status, code(reply)]).toEqual([404, "not_found"])
  })

  it.each(foreign)("404s %s %s with a valid session", async (method, path) => {
    enrol(auth)
    const cookie = await signIn()
    const reply = await call(method, path, { cookie })
    expect([reply.status, code(reply)]).toEqual([404, "not_found"])
  })

  it.each([
    ["another host", "evil.example.invalid"],
    ["no host", null],
  ])("answers 421 for %s", async (_name, host) => {
    const reply = await call("GET", "/passkey/status", { host })
    expect([reply.status, code(reply)]).toEqual([421, "misdirected_request"])
  })

  it("matches the Host header without regard to case", async () => {
    const reply = await call("GET", "/passkey/status", {
      host: HOST.toUpperCase(),
    })
    expect(reply.status).toBe(200)
  })

  it("serves only below its base path", async () => {
    const inside = await call("GET", "/api/gate/passkey/status", {
      basePath: "/api/gate",
    })
    const outside = await call("GET", "/passkey/status", {
      basePath: "/api/gate",
    })
    expect(inside.status).toBe(200)
    expect(outside.status).toBe(404)
  })

  it.each([
    ["no content type", null],
    ["a form", "application/x-www-form-urlencoded"],
    ["text", "text/plain"],
  ])("answers 415 for a POST with %s", async (_name, contentType) => {
    const reply = await call("POST", "/auth/login/options", { contentType })
    expect([reply.status, code(reply)]).toEqual([415, "unsupported_media_type"])
  })

  it("accepts application/json with a charset", async () => {
    const reply = await call("POST", "/auth/login/options", {
      contentType: "application/json; charset=utf-8",
    })
    expect(reply.status).toBe(200)
  })

  it("marks every answer no-store, errors included", async () => {
    const replies = await Promise.all([
      call("GET", "/passkey/status"),
      call("GET", "/approvals"),
      call("GET", "/nowhere"),
      call("GET", "/passkey/status", { host: "evil.example.invalid" }),
    ])
    expect(replies.map((reply) => reply.headers?.["cache-control"])).toEqual([
      "no-store",
      "no-store",
      "no-store",
      "no-store",
    ])
  })
})

describe("phoneHandler: session", () => {
  const gated: readonly (readonly [string, string])[] = [
    ["GET", "/approvals"],
    ["GET", "/approvals/x/history"],
    ["POST", "/approvals/x/nonce"],
    ["POST", "/approvals/x/decision"],
    ["POST", "/approvals/x/edit"],
  ]

  it.each(gated)(
    "401s %s %s without a session cookie",
    async (method, path) => {
      const reply = await call(method, path)
      expect([reply.status, code(reply)]).toEqual([401, "unauthenticated"])
    }
  )

  it.each(gated)(
    "401s %s %s with a cookie the gate did not issue",
    async (method, path) => {
      const reply = await call(method, path, {
        cookie: `eido_gate_session=${"A".repeat(43)}`,
      })
      expect(reply.status).toBe(401)
    }
  )

  it("sets the session cookie with its attributes and returns when it ends", async () => {
    enrol(auth)
    const options = await call("POST", "/auth/login/options")
    const parsed = validateGateLoginOptions(options.body)
    if (!parsed.ok) throw new Error(parsed.errors.join("; "))
    expect(parsed.value.rpId).toBe(WEBAUTHN.rpId)
    expect(parsed.value.expiresAt).toBe("2026-10-19T08:05:00.000Z")
    const reply = await call("POST", "/auth/login", {
      body: { assertion: assertion(auth, parsed.value.challenge) },
    })
    expect(reply.status).toBe(200)
    expect(validateGateSession(reply.body)).toEqual({
      ok: true,
      value: { expiresAt: "2026-10-19T20:00:00.000Z" },
    })
    expect(reply.headers?.["set-cookie"]).toMatch(
      /^eido_gate_session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/api\/gate; HttpOnly; Secure; SameSite=Strict$/
    )
  })

  it("lets a session in until 12 hours after login, then 401s", async () => {
    enrol(auth)
    const cookie = await signIn()
    at = new Date(START.getTime() + 12 * HOUR - 1)
    expect((await call("GET", "/approvals", { cookie })).status).toBe(200)
    at = new Date(START.getTime() + 12 * HOUR)
    expect((await call("GET", "/approvals", { cookie })).status).toBe(401)
  })

  it("refuses a login signed over a challenge it did not issue", async () => {
    enrol(auth)
    const reply = await call("POST", "/auth/login", {
      body: { assertion: assertion(auth, "A".repeat(43)) },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(reply.headers?.["set-cookie"]).toBeUndefined()
  })

  it.each([
    ["not JSON", { ok: true, text: "{" } as const, 400, "invalid_request"],
    ["over 1 MiB", { ok: false } as const, 413, "invalid_request"],
    [
      "not a login request",
      { ok: true, text: "{}" } as const,
      400,
      "invalid_request",
    ],
  ])("refuses a login body that is %s", async (_name, raw, status, error) => {
    const reply = await call("POST", "/auth/login", { raw })
    expect([reply.status, code(reply)]).toEqual([status, error])
  })

  it("reports enrolment and the session's end on the credential status route", async () => {
    const before = await call("GET", "/passkey/status")
    expect(validateGateCredentialStatus(before.body)).toEqual({
      ok: true,
      value: { enrolled: false, sessionExpiresAt: null },
    })
    enrol(auth)
    const cookie = await signIn()
    const after = await call("GET", "/passkey/status", { cookie })
    expect(after.body).toEqual({
      enrolled: true,
      sessionExpiresAt: "2026-10-19T20:00:00.000Z",
    })
  })
})

describe("phoneHandler: approvals", () => {
  let cookie: string

  beforeEach(async () => {
    enrol(auth)
    cookie = await signIn()
  })

  async function prepare(id: string): Promise<{
    payload: string
    payloadHash: string
    nonce: string
  }> {
    const reply = await call("POST", `/approvals/${id}/nonce`, { cookie })
    const parsed = validateGatePrepareApproval(reply.body)
    if (!parsed.ok) throw new Error(`prepare: ${JSON.stringify(reply.body)}`)
    return parsed.value
  }

  async function approve(id: string): Promise<Reply> {
    const prepared = await prepare(id)
    return call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: {
        intentId: id,
        decision: "approved",
        nonce: prepared.nonce,
        assertion: assertion(
          auth,
          deviceChallenge(prepared.payloadHash, id, prepared.nonce),
          { signCount: 0 }
        ),
      },
    })
  }

  it("lists pending intents with their rationale", async () => {
    const id = pendingSend({ rationale: "lorem ipsum dolor" })
    const reply = await call("GET", "/approvals", { cookie })
    const parsed = validateGatePendingIntentList(reply.body)
    if (!parsed.ok) throw new Error(parsed.errors.join("; "))
    expect(parsed.value.intents).toEqual([
      expect.objectContaining({
        id,
        kind: "email.send",
        origin: "reactive",
        rationale: "lorem ipsum dolor",
      }),
    ])
  })

  it("prepares the card: payload, its hash, a nonce, the sources and the rationale", async () => {
    const id = pendingSend({ rationale: "lorem ipsum dolor" })
    const reply = await call("POST", `/approvals/${id}/nonce`, { cookie })
    const parsed = validateGatePrepareApproval(reply.body)
    if (!parsed.ok) throw new Error(parsed.errors.join("; "))
    const card = parsed.value
    expect(card).toMatchObject({
      intentId: id,
      kind: "email.send",
      origin: "reactive",
      state: "pending",
      contextPackId: "pack-1",
      documentIds: ["doc-1", "doc-2"],
      rationale: "lorem ipsum dolor",
    })
    expect(card.editedFrom).toBeUndefined()
    expect(card.payloadHash).toBe(
      createHash("sha256").update(card.payload, "utf8").digest("hex")
    )
    expect(card.payload).not.toContain("lorem ipsum dolor")
    expect(reply.body).not.toHaveProperty("challenge")
  })

  it("leaves the rationale out of the payload hash", async () => {
    const withNote = await prepare(pendingSend({ rationale: "lorem ipsum" }))
    const without = await prepare(pendingSend())
    expect(withNote.payloadHash).toBe(without.payloadHash)
    expect(without).not.toHaveProperty("rationale")
  })

  it("issues a new nonce on each prepare", async () => {
    const id = pendingSend()
    const first = await prepare(id)
    const second = await prepare(id)
    expect(second.nonce).not.toBe(first.nonce)
  })

  it("404s a prepare for an unknown intent and 409s one already decided", async () => {
    const unknown = await call("POST", "/approvals/nope/nonce", { cookie })
    expect([unknown.status, code(unknown)]).toEqual([404, "not_found"])
    const id = pendingSend()
    await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: { intentId: id, decision: "rejected" },
    })
    const decided = await call("POST", `/approvals/${id}/nonce`, { cookie })
    expect([decided.status, code(decided)]).toEqual([409, "already_decided"])
  })

  it("approves an intent signed over the prepared challenge", async () => {
    const id = pendingSend()
    const reply = await approve(id)
    expect(reply.status).toBe(200)
    expect(validateGateDecisionResult(reply.body)).toEqual({
      ok: true,
      value: { intentId: id, state: "approved", nudge: false },
    })
    expect(intentState(id)).toBe("approved")
  })

  it("refuses an approval signed over another intent's challenge", async () => {
    const id = pendingSend()
    const prepared = await prepare(id)
    const reply = await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: {
        intentId: id,
        decision: "approved",
        nonce: prepared.nonce,
        assertion: assertion(
          auth,
          deviceChallenge(prepared.payloadHash, "other-intent", prepared.nonce)
        ),
      },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(intentState(id)).toBe("rejected")
  })

  it("refuses a decision whose intentId is not the one in the path", async () => {
    const id = pendingSend()
    const reply = await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: { intentId: "another", decision: "rejected" },
    })
    expect([reply.status, code(reply)]).toEqual([400, "invalid_request"])
    expect(intentState(id)).toBe("pending")
  })

  it("rejects with a reason code and records it", async () => {
    const id = pendingSend()
    const reply = await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: { intentId: id, decision: "rejected", reasonCode: "wrong_tone" },
    })
    expect(reply.body).toEqual({ intentId: id, state: "rejected" })
    expect(
      s.db
        .prepare("SELECT reason_code FROM approvals WHERE intent_id = ?")
        .get(id)
    ).toEqual({ reason_code: "wrong_tone" })
  })

  it("refuses a reason code outside the decided list", async () => {
    const id = pendingSend()
    const reply = await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: { intentId: id, decision: "rejected", reasonCode: "not_now" },
    })
    expect([reply.status, code(reply)]).toEqual([400, "invalid_request"])
    expect(intentState(id)).toBe("pending")
  })

  it("404s a reject of an unknown intent and 409s a second reject", async () => {
    const unknown = await call("POST", "/approvals/nope/decision", {
      cookie,
      body: { intentId: "nope", decision: "rejected" },
    })
    expect([unknown.status, code(unknown)]).toEqual([404, "not_found"])
    const id = pendingSend()
    const reject = { cookie, body: { intentId: id, decision: "rejected" } }
    await call("POST", `/approvals/${id}/decision`, reject)
    const again = await call("POST", `/approvals/${id}/decision`, reject)
    expect([again.status, code(again)]).toEqual([409, "already_decided"])
  })

  it.each([
    ["not JSON", { ok: true, text: "[" } as const, 400],
    ["over 1 MiB", { ok: false } as const, 413],
  ])("refuses a decision body that is %s", async (_name, raw, status) => {
    const reply = await call("POST", "/approvals/x/decision", { cookie, raw })
    expect(reply.status).toBe(status)
  })

  it("returns the history of an intent, and 404 for an unknown one", async () => {
    const id = pendingSend()
    const reply = await call("GET", `/approvals/${id}/history`, { cookie })
    const parsed = validateGateIntentHistory(reply.body)
    if (!parsed.ok) throw new Error(parsed.errors.join("; "))
    expect(parsed.value.entries.map((entry) => entry.to)).toEqual([
      "proposed",
      "pending",
    ])
    const unknown = await call("GET", "/approvals/nope/history", { cookie })
    expect(unknown.status).toBe(404)
  })

  describe("edit", () => {
    it("replaces the intent and returns a prepare for the new one, which then signs", async () => {
      const original = pendingSend({ rationale: "lorem ipsum" })
      const reply = await call("POST", `/approvals/${original}/edit`, {
        cookie,
        body: { intent: sample("email.send", { subject: "Edited" }) },
      })
      expect(reply.status).toBe(200)
      const parsed = validateGatePrepareApproval(reply.body)
      if (!parsed.ok) throw new Error(parsed.errors.join("; "))
      const card = parsed.value
      expect(card.intentId).not.toBe(original)
      expect(card).toMatchObject({
        editedFrom: original,
        rationale: "lorem ipsum",
        documentIds: ["doc-1", "doc-2"],
        contextPackId: "pack-1",
      })
      expect(card.payload).toContain("Edited")
      const history = await call("GET", `/approvals/${original}/history`, {
        cookie,
      })
      expect(history.body).toMatchObject({
        entries: [{}, {}, { to: "rejected", reason: "edited" }],
      })
      const signed = await call(
        "POST",
        `/approvals/${card.intentId}/decision`,
        {
          cookie,
          body: {
            intentId: card.intentId,
            decision: "approved",
            nonce: card.nonce,
            assertion: assertion(
              auth,
              deviceChallenge(card.payloadHash, card.intentId, card.nonce)
            ),
          },
        }
      )
      expect(signed.body).toEqual({
        intentId: card.intentId,
        state: "approved",
        nudge: false,
      })
    })

    it("refuses an edit that would change the tier, keeping the original pending", async () => {
      const created = propose(s.db, s.policy, {
        intent: sample("calendar.create", { guests: ["guest@example.com"] }),
        origin: "proactive",
      })
      if (!created.ok || created.state !== "pending")
        throw new Error("not pending")
      const reply = await call("POST", `/approvals/${created.intentId}/edit`, {
        cookie,
        body: { intent: sample("calendar.create") },
      })
      expect([reply.status, code(reply)]).toEqual([409, "tier_changed"])
      expect(intentState(created.intentId)).toBe("pending")
    })

    it("refuses an edit policy forbids", async () => {
      const created = propose(s.db, s.policy, {
        intent: sample("file.delete"),
        origin: "task",
      })
      if (!created.ok || created.state !== "pending")
        throw new Error("not pending")
      const reply = await call("POST", `/approvals/${created.intentId}/edit`, {
        cookie,
        body: { intent: sample("file.delete", { root: "elsewhere" }) },
      })
      expect([reply.status, code(reply)]).toEqual([403, "forbidden"])
      expect(intentState(created.intentId)).toBe("pending")
    })

    it.each([
      ["of another kind", { kind: "email.trash", args: { messageIds: ["m"] } }],
      ["the schemas refuse", { kind: "email.send", args: { to: [] } }],
    ])("422s an edited intent %s", async (_name, intent) => {
      const id = pendingSend()
      const reply = await call("POST", `/approvals/${id}/edit`, {
        cookie,
        body: { intent },
      })
      expect([reply.status, code(reply)]).toEqual([422, "invalid_request"])
      expect(intentState(id)).toBe("pending")
    })

    it("404s an edit of an unknown intent and 409s one already decided", async () => {
      const body = { intent: sample("email.send") }
      const unknown = await call("POST", "/approvals/nope/edit", {
        cookie,
        body,
      })
      expect(unknown.status).toBe(404)
      const id = pendingSend()
      await call("POST", `/approvals/${id}/decision`, {
        cookie,
        body: { intentId: id, decision: "rejected" },
      })
      const decided = await call("POST", `/approvals/${id}/edit`, {
        cookie,
        body,
      })
      expect([decided.status, code(decided)]).toEqual([409, "already_decided"])
    })

    it.each([
      ["not JSON", { ok: true, text: "nope" } as const, 400],
      ["not an edit", { ok: true, text: '{"intent":1}' } as const, 400],
      ["over 1 MiB", { ok: false } as const, 413],
    ])("refuses an edit body that is %s", async (_name, raw, status) => {
      const reply = await call("POST", "/approvals/x/edit", { cookie, raw })
      expect(reply.status).toBe(status)
    })
  })
})
