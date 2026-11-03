import { createECDH, createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  validateGateAuditChainStatus,
  validateGateAuditPage,
  validateGateBackupStatus,
  validateGateConnectorSettings,
  validateGateCredentialStatus,
  validateGateDecisionResult,
  validateGateEnrolOptions,
  validateGateIntentHistory,
  validateGateLoginOptions,
  validateGatePendingIntentList,
  validateGatePrepareApproval,
  validateGateSession,
  validateGatePasskeyList,
  validateGatePermissionList,
  validateGateRepinPrepared,
  validateGateRepinResult,
  validateGateUndoResult,
} from "@eido/schemas"
import type { GateIntentInjection } from "@eido/schemas"
import type { Body, GateRequest, Reply } from "./http"
import { append } from "./audit"
import {
  beginConnectorRead,
  recordConnectorReadFailure,
  recordConnectorReadSuccess,
} from "./connector-health"
import { checkDrift, manifestHash } from "./connectors"
import { payloadHash } from "./canonical"
import { loadPolicy, SHIPPED_DEFAULT_PATH } from "./policy"
import { propose } from "./intents"
import { revokeCredential } from "./credentials"
import { issueEnrolmentCode } from "./enrolment"
import { matchRoute, phoneHandler, routePath } from "./phone-routes"
import type { ExecutionResult } from "./executor"
import { preparePushRegistration } from "./push-subscriptions"
import type { PhoneState } from "./phone-routes"
import {
  assertion,
  signedFileRoots,
  auditRows,
  controlAuthorization,
  loggedText,
  registration,
  FILE_OPS,
  manifest,
  deviceChallenge,
  sample,
  setup,
  signedPolicy,
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
  undo?: (id: string) => Promise<ExecutionResult>
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
    undo: options.undo,
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
  extra: {
    rationale?: string
    subject?: string
    injection?: GateIntentInjection
  } = {}
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
    ...(extra.injection === undefined ? {} : { injection: extra.injection }),
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

describe("phoneHandler: connector settings detail", () => {
  it("serves last success, manifest hash and asOf for healthy, open and drift-disabled connectors", async () => {
    enrol(auth)
    const cookie = await signIn()
    const READ = Date.parse("2026-10-19T08:30:00.000Z")
    recordConnectorReadSuccess(
      s.db,
      "mail",
      beginConnectorRead(s.db, "mail", READ),
      READ
    )
    for (let i = 0; i < 5; i += 1) {
      recordConnectorReadFailure(
        s.db,
        "calendar",
        "timeout",
        beginConnectorRead(s.db, "calendar", READ + i),
        READ + i
      )
    }
    checkDrift(s.db, "files", ["files.unpinned_tool"])
    at = new Date("2026-10-19T09:00:00.000Z")

    const reply = await call("GET", "/connector-settings", { cookie })
    const checked = validateGateConnectorSettings(reply.body)
    if (!checked.ok) throw new Error("connector settings are invalid")
    expect(checked.value.asOf).toBe(at.toISOString())
    const byName = new Map(checked.value.connectors.map((c) => [c.name, c]))

    const mail = byName.get("mail")
    expect(mail).toMatchObject({
      enabled: true,
      health: "healthy",
      lastSuccessAt: new Date(READ).toISOString(),
    })
    expect(mail?.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(mail).not.toHaveProperty("drift")

    const calendar = byName.get("calendar")
    expect(calendar).toMatchObject({ enabled: true, health: "open" })
    expect(calendar).not.toHaveProperty("lastSuccessAt")
    expect(calendar).not.toHaveProperty("drift")

    const files = byName.get("files")
    expect(files?.enabled).toBe(false)
    expect(files?.drift?.added).toEqual(["files.unpinned_tool"])
    expect(files?.drift?.removed.length).toBeGreaterThan(0)
    expect(files?.manifestHash).toBe(manifestHash(manifest("files", FILE_OPS)))
    expect(JSON.stringify(reply.body)).not.toMatch(/token|secret/i)
  })
})

describe("phoneHandler: authenticated settings reads", () => {
  it("reports every shipped default independently of the effective tier", async () => {
    enrol(auth)
    const cookie = await signIn()
    const reply = await call("GET", "/permissions", { cookie })
    const checked = validateGatePermissionList(reply.body)
    if (!checked.ok) throw new Error("permission list is invalid")
    const shipped: unknown = JSON.parse(
      readFileSync(SHIPPED_DEFAULT_PATH, "utf8")
    )
    expect({
      version: 1,
      tiers: Object.fromEntries(
        checked.value.tiers
          .filter((row) => row.default !== null)
          .map((row) => [row.kind, row.default])
      ),
    }).toEqual(shipped)
    expect(checked.value.tiers.every((row) => !("override" in row))).toBe(true)
  })

  it("reports only active signed overrides, including one equal to the default", async () => {
    enrol(auth)
    const cookie = await signIn()
    signedPolicy(s.db, {
      version: 1,
      tiers: { "email.archive": "approval", "email.label": "auto" },
    })
    state.policy = loadPolicy(s.db, s.options).policy
    const reply = await call("GET", "/permissions", { cookie })
    const checked = validateGatePermissionList(reply.body)
    if (!checked.ok) throw new Error("permission list is invalid")
    expect(
      checked.value.tiers.filter((row) => row.override !== undefined)
    ).toEqual([
      { kind: "email.label", default: "auto", override: "auto", tier: "auto" },
      {
        kind: "email.archive",
        default: "auto",
        override: "approval",
        tier: "approval",
      },
    ])
    // A file proposal is not an approved policy and must never appear as an override.
    s.writeOverlay({ version: 1, tiers: { "email.send": "auto" } })
    state.policy = loadPolicy(s.db, s.options).policy
    const unapproved = await call("GET", "/permissions", { cookie })
    const parsed = validateGatePermissionList(unapproved.body)
    if (!parsed.ok) throw new Error("permission list is invalid")
    expect(parsed.value.tiers.find((row) => row.kind === "email.send")).toEqual(
      {
        kind: "email.send",
        default: "approval",
        tier: "approval",
      }
    )
  })

  it("keeps configured tiers visible when a connector is disabled or a default is absent", async () => {
    enrol(auth)
    const cookie = await signIn()
    signedPolicy(s.db, { version: 1, tiers: { "email.archive": "approval" } })
    state.policy = loadPolicy(s.db, s.options).policy
    delete state.policy.shipped.tiers["email.send"]
    checkDrift(s.db, "mail", ["unexpected_tool"])
    const reply = await call("GET", "/permissions", { cookie })
    const checked = validateGatePermissionList(reply.body)
    if (!checked.ok) throw new Error("permission list is invalid")
    expect(
      checked.value.tiers.find((row) => row.kind === "email.archive")
    ).toEqual({
      kind: "email.archive",
      default: "auto",
      override: "approval",
      tier: "forbidden",
      reason: "connector_disabled",
    })
    expect(
      checked.value.tiers.find((row) => row.kind === "email.send")
    ).toEqual({
      kind: "email.send",
      default: null,
      tier: "forbidden",
      reason: "connector_disabled",
    })
  })

  it("rejects every settings read without a valid session cookie", async () => {
    for (const path of [
      "/audit",
      "/audit/chain",
      "/connector-settings",
      "/backup/status",
      "/passkeys",
      "/permissions",
    ]) {
      expect((await call("GET", path)).status, path).toBe(401)
    }
  })

  it("marks only the passkey that opened the session as current", async () => {
    const other = testAuthenticator()
    enrol(other)
    enrol(auth)
    const cookie = await signIn()
    const reply = await call("GET", "/passkeys", { cookie })
    const checked = validateGatePasskeyList(reply.body)
    if (!checked.ok) throw new Error("passkey list is invalid")
    const fingerprint = (id: string) =>
      createHash("sha256").update(id).digest("hex")
    expect(
      checked.value.passkeys.map((p) => [p.fingerprint, p.current])
    ).toEqual(
      expect.arrayContaining([
        [fingerprint(auth.credentialId), true],
        [fingerprint(other.credentialId), false],
      ])
    )
    expect(checked.value.passkeys.filter((p) => p.current)).toHaveLength(1)
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
      current: true,
    })

    const permissions = await call("GET", "/permissions", { cookie })
    const checkedPermissions = validateGatePermissionList(permissions.body)
    expect(checkedPermissions.ok).toBe(true)
    if (!checkedPermissions.ok) throw new Error("permission list is invalid")
    expect(checkedPermissions.value.tiers).toContainEqual({
      kind: "email.archive",
      tier: "auto",
      default: "auto",
    })
    expect(checkedPermissions.value.tiers).toContainEqual({
      kind: "email.send",
      tier: "approval",
      default: "approval",
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

  describe("GET /backup/status", () => {
    let backupDir: string

    beforeEach(() => {
      backupDir = join(
        tmpdir(),
        `eido-phone-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      )
      mkdirSync(backupDir, { recursive: true })
    })

    afterEach(() => {
      rmSync(backupDir, { recursive: true, force: true })
    })

    it("requires a session cookie", async () => {
      const reply = await call("GET", "/backup/status")
      expect(reply.status).toBe(401)
    })

    it("returns never_run when the stamp file does not exist", async () => {
      enrol(auth)
      const cookie = await signIn()
      state = { ...state, backupStampPath: join(backupDir, "nonexistent") }

      const reply = await call("GET", "/backup/status", { cookie })
      expect(reply.status).toBe(200)
      expect(validateGateBackupStatus(reply.body)).toEqual({
        ok: true,
        value: { status: "never_run", lastSuccess: null },
      })
    })

    it("returns fresh when the snapshot is within 36 hours", async () => {
      enrol(auth)
      const cookie = await signIn()
      const stampPath = join(backupDir, "stamp")
      const stampTime = new Date(at.getTime() - 4 * 3600 * 1000)
      writeFileSync(stampPath, `${stampTime.toISOString()}\n`)
      state = { ...state, backupStampPath: stampPath }

      const reply = await call("GET", "/backup/status", { cookie })
      expect(reply.status).toBe(200)
      expect(validateGateBackupStatus(reply.body)).toEqual({
        ok: true,
        value: {
          status: "fresh",
          lastSuccess: stampTime.toISOString(),
        },
      })
    })

    it("returns stale when the snapshot is older than 36 hours", async () => {
      enrol(auth)
      const cookie = await signIn()
      const stampPath = join(backupDir, "stamp")
      const stampTime = new Date(at.getTime() - 40 * 3600 * 1000)
      writeFileSync(stampPath, `${stampTime.toISOString()}\n`)
      state = { ...state, backupStampPath: stampPath }

      const reply = await call("GET", "/backup/status", { cookie })
      expect(reply.status).toBe(200)
      expect(validateGateBackupStatus(reply.body)).toEqual({
        ok: true,
        value: {
          status: "stale",
          lastSuccess: stampTime.toISOString(),
        },
      })
    })
  })

  it("labels executor rows only for matching approved signatures already valid at that row", async () => {
    enrol(auth)
    const cookie = await signIn()
    const id = pendingSend()
    const beforeApproval = append(s.db, {
      actor: "executor",
      action: "execute",
      target: id,
      detailHash: payloadHash({ result: "before-approval" }),
      ts: new Date(START.getTime() - 1000).toISOString(),
    })
    at = new Date(START.getTime() + 2000)
    const preparedReply = await call("POST", `/approvals/${id}/nonce`, {
      cookie,
    })
    const prepared = validateGatePrepareApproval(preparedReply.body)
    if (!prepared.ok)
      throw new Error(
        `${JSON.stringify(preparedReply.body)}: ${prepared.errors.join("; ")}`
      )
    await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: {
        intentId: id,
        decision: "approved",
        nonce: prepared.value.nonce,
        assertion: assertion(
          auth,
          deviceChallenge(prepared.value.payloadHash, id, prepared.value.nonce)
        ),
      },
    })
    const afterApproval = append(s.db, {
      actor: "executor",
      action: "execute",
      target: id,
      detailHash: payloadHash({ result: "after-approval" }),
      ts: new Date(at.getTime() + 1000).toISOString(),
    })

    const otherId = pendingSend()
    const otherPreparedReply = await call(
      "POST",
      `/approvals/${otherId}/nonce`,
      { cookie }
    )
    const otherPrepared = validateGatePrepareApproval(otherPreparedReply.body)
    if (!otherPrepared.ok) throw new Error(otherPrepared.errors.join("; "))
    await call("POST", `/approvals/${otherId}/decision`, {
      cookie,
      body: {
        intentId: otherId,
        decision: "approved",
        nonce: otherPrepared.value.nonce,
        assertion: assertion(
          auth,
          deviceChallenge(
            otherPrepared.value.payloadHash,
            otherId,
            otherPrepared.value.nonce
          )
        ),
      },
    })
    s.db
      .prepare("UPDATE approvals SET bundle_hash = ? WHERE intent_id = ?")
      .run("0".repeat(64), otherId)
    const mismatched = append(s.db, {
      actor: "executor",
      action: "execute",
      target: otherId,
      detailHash: payloadHash({ result: "wrong-bundle" }),
      ts: new Date(at.getTime() + 1000).toISOString(),
    })

    const reply = await call("GET", "/audit", { cookie })
    const parsed = validateGateAuditPage(reply.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("audit page is invalid")
    expect(
      parsed.value.entries.find((entry) => entry.seq === beforeApproval.seq)
    ).toMatchObject({ displayActor: "auto" })
    expect(
      parsed.value.entries.find((entry) => entry.seq === afterApproval.seq)
    ).toMatchObject({ displayActor: "you" })
    expect(
      parsed.value.entries.find((entry) => entry.seq === mismatched.seq)
    ).toMatchObject({ displayActor: "auto" })
  })

  it("does not label a signed rejection's executor row as the owner", async () => {
    enrol(auth)
    const cookie = await signIn()
    const id = pendingSend()
    const preparedReply = await call("POST", `/approvals/${id}/nonce`, {
      cookie,
    })
    const prepared = validateGatePrepareApproval(preparedReply.body)
    if (!prepared.ok) throw new Error(prepared.errors.join("; "))
    await call("POST", `/approvals/${id}/decision`, {
      cookie,
      body: { intentId: id, decision: "rejected" },
    })
    const signedAt = new Date().toISOString()
    s.db
      .prepare(
        "UPDATE approvals SET signature = ?, credential_id = ?, sign_count = 0, nonce = ? WHERE intent_id = ?"
      )
      .run("synthetic-signature", auth.credentialId, prepared.value.nonce, id)
    s.db
      .prepare("UPDATE approval_nonces SET used_at = ? WHERE nonce = ?")
      .run(signedAt, prepared.value.nonce)
    const execution = append(s.db, {
      actor: "executor",
      action: "execute",
      target: id,
      detailHash: payloadHash({ result: "rejected" }),
    })

    const reply = await call("GET", "/audit", { cookie })
    const parsed = validateGateAuditPage(reply.body)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("audit page is invalid")
    expect(
      parsed.value.entries.find((entry) => entry.seq === execution.seq)
    ).toMatchObject({ displayActor: "auto" })
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
    ["POST", "/passkeys/revoke"],
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
    ["POST", "/executions/x/undo"],
  ]

  it.each(gated)(
    "401s %s %s without a session cookie",
    async (method, path) => {
      const reply = await call(method, path)
      expect([reply.status, code(reply)]).toEqual([401, "unauthenticated"])
    }
  )

  it("requires an empty body and configured undo before running it", async () => {
    enrol(auth)
    const cookie = await signIn()
    let calls = 0
    const undo = (): Promise<ExecutionResult> => {
      calls += 1
      return Promise.resolve({ ok: true, upstreamRef: null, result: {} })
    }
    const unknownField = await call("POST", "/executions/x/undo", {
      cookie,
      body: { inverse: {} },
      undo,
    })
    expect([unknownField.status, code(unknownField), calls]).toEqual([
      400,
      "invalid_request",
      0,
    ])

    const unavailable = await call("POST", "/executions/x/undo", {
      cookie,
      body: {},
    })
    expect([unavailable.status, code(unavailable), calls]).toEqual([
      503,
      "unavailable",
      0,
    ])

    const longId = await call("POST", `/executions/${"x".repeat(65)}/undo`, {
      cookie,
      body: {},
      undo,
    })
    expect([longId.status, code(longId), calls]).toEqual([
      400,
      "invalid_request",
      0,
    ])

    const reply = await call("POST", "/executions/x/undo", {
      cookie,
      body: {},
      undo,
    })
    expect(reply.status).toBe(200)
    expect(validateGateUndoResult(reply.body)).toMatchObject({
      ok: true,
      value: { id: "x", undone: true },
    })
    expect(calls).toBe(1)

    const failed = await call("POST", "/executions/y/undo", {
      cookie,
      body: {},
      undo: () => Promise.reject(new Error("secretmarker")),
    })
    expect([failed.status, code(failed)]).toEqual([503, "unavailable"])
    expect(JSON.stringify(failed.body)).not.toContain("secretmarker")
  })

  it.each([
    ["not_found", 404, "not_found"],
    ["undo_not_allowed", 409, "already_decided"],
    ["no_inverse", 409, "already_decided"],
    ["unsafe_inverse", 409, "already_decided"],
    ["invalid_inverse", 409, "already_decided"],
    ["record_mismatch", 409, "already_decided"],
    ["outcome_unresolved", 409, "already_decided"],
    ["upstream_error", 503, "unavailable"],
    ["connector_unavailable", 503, "unavailable"],
    ["connector_misconfigured", 503, "unavailable"],
    ["unknown_writer", 503, "unavailable"],
    ["changed_during_execution", 503, "unavailable"],
  ] as const)(
    "maps executor refusal %s to a bounded response",
    async (executorCode, status, errorCode) => {
      enrol(auth)
      const cookie = await signIn()
      const reply = await call(
        "POST",
        `/executions/undo-${executorCode}/undo`,
        {
          cookie,
          body: {},
          undo: () => Promise.resolve({ ok: false, code: executorCode }),
        }
      )
      expect([reply.status, code(reply)]).toEqual([status, errorCode])
      const message =
        status === 404
          ? "no such execution"
          : status === 409
            ? "this execution cannot be undone"
            : "undo could not be completed"
      expect(reply.body).toEqual({ code: errorCode, message })
    }
  )

  it("does not call undo for a wrong host, bad content type, missing or expired session", async () => {
    enrol(auth)
    let calls = 0
    const undo = (): Promise<ExecutionResult> => {
      calls += 1
      return Promise.resolve({ ok: true, upstreamRef: null, result: {} })
    }
    const cookie = await signIn()
    const wrongHost = await call("POST", "/executions/x/undo", {
      host: "evil.example.invalid",
      cookie,
      body: {},
      undo,
    })
    const badContentType = await call("POST", "/executions/x/undo", {
      cookie,
      body: {},
      contentType: "text/plain",
      undo,
    })
    const missingSession = await call("POST", "/executions/x/undo", {
      body: {},
      undo,
    })
    at = new Date(at.getTime() + 365 * 24 * HOUR)
    const expiredSession = await call("POST", "/executions/x/undo", {
      cookie,
      body: {},
      undo,
    })
    expect([
      wrongHost.status,
      badContentType.status,
      missingSession.status,
      expiredSession.status,
      calls,
    ]).toEqual([421, 415, 401, 401, 0])
  })

  it.each(gated)(
    "401s %s %s with a cookie the gate did not issue",
    async (method, path) => {
      const reply = await call(method, path, {
        cookie: `eido_gate_session=${"A".repeat(43)}`,
      })
      expect(reply.status).toBe(401)
    }
  )

  // The web app's Auth0 sign-in (apps/web) sets its own `__session` cookie. It proves who
  // opened the web app, not who may decide; the gate must still demand its passkey session.
  it.each(gated)(
    "401s %s %s with only the web app's sign-in cookie",
    async (method, path) => {
      const reply = await call(method, path, {
        cookie: `__session=${"A".repeat(200)}`,
      })
      expect([reply.status, code(reply)]).toEqual([401, "unauthenticated"])
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

  describe("injection flag", () => {
    const flag: GateIntentInjection = {
      reasons: ["template-marker", "hidden-characters"],
    }

    it("lists a flagged intent with its reasons and a clean one without the field", async () => {
      const flagged = pendingSend({ injection: flag })
      const clean = pendingSend({ subject: "Clean" })
      const reply = await call("GET", "/approvals", { cookie })
      const parsed = validateGatePendingIntentList(reply.body)
      if (!parsed.ok) throw new Error(parsed.errors.join("; "))
      const byId = new Map(parsed.value.intents.map((i) => [i.id, i]))
      expect(byId.get(flagged)?.injection).toEqual(flag)
      expect(byId.get(clean)).not.toHaveProperty("injection")
    })

    it("puts the reasons on the prepared card and leaves them out of the payload hash", async () => {
      const card = async (id: string) => {
        const reply = await call("POST", `/approvals/${id}/nonce`, { cookie })
        const parsed = validateGatePrepareApproval(reply.body)
        if (!parsed.ok) throw new Error(parsed.errors.join("; "))
        return parsed.value
      }
      const flagged = await card(pendingSend({ injection: flag }))
      const clean = await card(pendingSend())
      expect(flagged.injection).toEqual(flag)
      expect(clean).not.toHaveProperty("injection")
      expect(flagged.payloadHash).toBe(clean.payloadHash)
      expect(flagged.payload).not.toContain("template-marker")
    })

    it("keeps the flag on the card of an edited intent", async () => {
      const original = pendingSend({ injection: flag })
      const reply = await call("POST", `/approvals/${original}/edit`, {
        cookie,
        body: { intent: sample("email.send", { subject: "Edited" }) },
      })
      const parsed = validateGatePrepareApproval(reply.body)
      if (!parsed.ok) throw new Error(parsed.errors.join("; "))
      expect(parsed.value.injection).toEqual(flag)
    })
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
        origin: "reactive",
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
      await signedFileRoots(s.db, {
        roots: [
          {
            id: "notes",
            root: {
              path: "/synthetic/notes",
              dev: "1",
              ino: "2",
              trashDir: "trash",
            },
          },
        ],
      })
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

describe("phoneHandler: passkey enrolment with a code (#202)", () => {
  const MINUTE = 60 * 1000

  function issue(): string {
    const issued = issueEnrolmentCode(s.db, "admin", () => at)
    if (!issued.ok) throw new Error("the code was not issued")
    return issued.code
  }

  async function challengeFor(enrolmentCode: string): Promise<string> {
    const reply = await call("POST", "/passkey/enroll/options", {
      body: { code: enrolmentCode },
    })
    const parsed = validateGateEnrolOptions(reply.body)
    if (!parsed.ok) throw new Error(`no options: ${String(code(reply))}`)
    return parsed.value.challenge
  }

  function credentialIds(): string[] {
    return s.db
      .prepare("SELECT credential_id FROM credentials ORDER BY credential_id")
      .all()
      .map((row) => String(row["credential_id"]))
  }

  function codeUsed(enrolmentCode: string): boolean {
    const hash = createHash("sha256")
      .update(enrolmentCode.replace(/-/g, ""))
      .digest("hex")
    const row = s.db
      .prepare("SELECT used_at FROM enrolment_codes WHERE code_hash = ?")
      .get(hash)
    return row?.["used_at"] !== null
  }

  /** The detail hash of a refused code, computed here from the spec: outcome and code hash. */
  function refusalHash(outcome: string, enrolmentCode: string): string {
    return payloadHash({
      outcome,
      code_sha256: createHash("sha256")
        .update(enrolmentCode.replace(/-/g, ""))
        .digest("hex"),
    })
  }

  function lastAudit(action: string): string | undefined {
    return auditRows(s.db)
      .filter((row) => row.action === action)
      .at(-1)?.detail_hash
  }

  it("stores one credential, consumes the code and signs the phone in", async () => {
    const enrolmentCode = issue()
    const options = await call("POST", "/passkey/enroll/options", {
      body: { code: enrolmentCode },
    })
    expect(options.status).toBe(200)
    expect(options.body).toMatchObject({
      rpId: "eido.example.invalid",
      expiresAt: "2026-10-19T08:10:00.000Z",
    })
    const challenge = await challengeFor(enrolmentCode)
    const reply = await call("POST", "/passkey/enroll", {
      body: {
        code: enrolmentCode,
        registration: registration(auth, challenge),
      },
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ expiresAt: "2026-10-19T20:00:00.000Z" })
    expect(credentialIds()).toEqual([auth.credentialId])
    expect(codeUsed(enrolmentCode)).toBe(true)
    const cookie = (reply.headers?.["set-cookie"] ?? "").split(";")[0] ?? ""
    expect((await call("GET", "/approvals", { cookie })).status).toBe(200)
    expect((await call("GET", "/passkey/status", { cookie })).body).toEqual({
      enrolled: true,
      sessionExpiresAt: "2026-10-19T20:00:00.000Z",
    })
  })

  it("reports no enrolment before the code is used", async () => {
    issue()
    expect((await call("GET", "/passkey/status")).body).toEqual({
      enrolled: false,
      sessionExpiresAt: null,
    })
  })

  it("refuses an expired code at options and at enrolment, and stores nothing", async () => {
    const enrolmentCode = issue()
    const challenge = await challengeFor(enrolmentCode)
    at = new Date(START.getTime() + 10 * MINUTE)
    const options = await call("POST", "/passkey/enroll/options", {
      body: { code: enrolmentCode },
    })
    expect([options.status, code(options)]).toEqual([
      403,
      "verification_failed",
    ])
    const reply = await call("POST", "/passkey/enroll", {
      body: {
        code: enrolmentCode,
        registration: registration(auth, challenge),
      },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(reply.headers?.["set-cookie"]).toBeUndefined()
    expect(credentialIds()).toEqual([])
    expect(lastAudit("enrolment_code.refused")).toBe(
      refusalHash("expired", enrolmentCode)
    )
    expect(loggedText(s.db)).not.toContain(enrolmentCode.replace(/-/g, ""))
  })

  it("refuses a reused code, so a second phone cannot enrol with it", async () => {
    const enrolmentCode = issue()
    const first = await challengeFor(enrolmentCode)
    const second = await challengeFor(enrolmentCode)
    const other = testAuthenticator()
    await call("POST", "/passkey/enroll", {
      body: { code: enrolmentCode, registration: registration(auth, first) },
    })
    const reply = await call("POST", "/passkey/enroll", {
      body: { code: enrolmentCode, registration: registration(other, second) },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(credentialIds()).toEqual([auth.credentialId])
    expect(lastAudit("enrolment_code.refused")).toBe(
      refusalHash("reused", enrolmentCode)
    )
    const options = await call("POST", "/passkey/enroll/options", {
      body: { code: enrolmentCode },
    })
    expect(options.status).toBe(403)
  })

  it("refuses an unknown code and leaves the issued one unused", async () => {
    const enrolmentCode = issue()
    const challenge = await challengeFor(enrolmentCode)
    const unknown = "ABCD-EFGH-JKMN-PQRS"
    const options = await call("POST", "/passkey/enroll/options", {
      body: { code: unknown },
    })
    expect(options.status).toBe(403)
    const reply = await call("POST", "/passkey/enroll", {
      body: { code: unknown, registration: registration(auth, challenge) },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(credentialIds()).toEqual([])
    expect(codeUsed(enrolmentCode)).toBe(false)
    expect(lastAudit("enrolment_code.refused")).toBe(
      refusalHash("unknown", unknown)
    )
    expect(loggedText(s.db)).not.toContain("ABCDEFGHJKMNPQRS")
  })

  it("keeps the code when the registration fails its checks", async () => {
    const enrolmentCode = issue()
    const challenge = await challengeFor(enrolmentCode)
    const bad = await call("POST", "/passkey/enroll", {
      body: {
        code: enrolmentCode,
        registration: registration(auth, challenge, {
          origin: "https://evil.example.invalid",
        }),
      },
    })
    expect([bad.status, code(bad)]).toEqual([403, "verification_failed"])
    expect(codeUsed(enrolmentCode)).toBe(false)
    const retry = await call("POST", "/passkey/enroll", {
      body: {
        code: enrolmentCode,
        registration: registration(auth, await challengeFor(enrolmentCode)),
      },
    })
    expect(retry.status).toBe(200)
  })

  it("keeps a revoked credential revoked, and refuses to enrol it again", async () => {
    enrol(auth)
    expect(revokeCredential(s.db, "admin", auth.credentialId)).toEqual({
      ok: true,
    })
    const revokedAt = s.db
      .prepare("SELECT revoked_at FROM credentials WHERE credential_id = ?")
      .get(auth.credentialId)?.["revoked_at"]
    const enrolmentCode = issue()
    const again = await call("POST", "/passkey/enroll", {
      body: {
        code: enrolmentCode,
        registration: registration(auth, await challengeFor(enrolmentCode)),
      },
    })
    expect(again.status).toBe(403)
    expect(codeUsed(enrolmentCode)).toBe(false)
    const replacement = testAuthenticator()
    const reply = await call("POST", "/passkey/enroll", {
      body: {
        code: enrolmentCode,
        registration: registration(
          replacement,
          await challengeFor(enrolmentCode)
        ),
      },
    })
    expect(reply.status).toBe(200)
    expect(
      s.db
        .prepare("SELECT revoked_at FROM credentials WHERE credential_id = ?")
        .get(auth.credentialId)?.["revoked_at"]
    ).toBe(revokedAt)
    expect(revokedAt).toEqual(expect.any(String))
  })

  it("answers 400 for a body that is not an enrolment request", async () => {
    const options = await call("POST", "/passkey/enroll/options", {
      body: { code: 7 },
    })
    expect([options.status, code(options)]).toEqual([400, "invalid_request"])
    const reply = await call("POST", "/passkey/enroll", {
      body: { code: issue() },
    })
    expect([reply.status, code(reply)]).toEqual([400, "invalid_request"])
    const raw = await call("POST", "/passkey/enroll", {
      raw: { ok: true, text: "{" },
    })
    expect(raw.status).toBe(400)
    const rawOptions = await call("POST", "/passkey/enroll/options", {
      raw: { ok: true, text: "{" },
    })
    expect(rawOptions.status).toBe(400)
  })
})

describe("phoneHandler: connector re-pin (#97)", () => {
  // "files" pins create, rename, move and trash. The server now reports bulk_move instead of
  // trash_file, so the gate disables it for drift.
  const OBSERVED = ["create_file", "rename_file", "move_file", "bulk_move"]
  const reviewed = (version = 2) =>
    manifest(
      "files",
      [
        ...FILE_OPS.filter((o) => o.name !== "trash_file"),
        {
          name: "bulk_move",
          intentKind: "file.move",
          reversibility: "reversible",
          defaultTier: "approval",
        },
      ],
      version
    )
  const REPIN = "/connector-settings/files/repin"
  const DECIDE = `${REPIN}/decision`

  function drift(): string {
    checkDrift(s.db, "files", OBSERVED)
    return manifestHash(manifest("files", FILE_OPS))
  }

  async function files() {
    const cookie = await signIn()
    const settings = await call("GET", "/connector-settings", { cookie })
    const checked = validateGateConnectorSettings(settings.body)
    if (!checked.ok) throw new Error("connector settings are invalid")
    const row = checked.value.connectors.find((c) => c.name === "files")
    if (row === undefined) throw new Error("no files connector")
    return { cookie, row }
  }

  async function prepare(cookie: string) {
    const reply = await call("POST", REPIN, { cookie, body: {} })
    const checked = validateGateRepinPrepared(reply.body)
    if (!checked.ok) throw new Error(`re-pin not prepared: ${reply.status}`)
    return checked.value
  }

  // Built from the spec in docs/gate-signed-control-changes.md, not by the gate's own code.
  const expectedChallenge = (p: {
    id: string
    payloadHash: string
    nonce: string
  }) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          "eido.control.v1",
          "manifest.pin",
          "files",
          p.id,
          p.payloadHash,
          p.nonce,
        ])
      )
      .digest("base64url")

  beforeEach(() => {
    state.reviewedManifest = (name) =>
      name === "files" ? reviewed() : undefined
  })

  it("prepares a challenge over the reviewed manifest and changes nothing until it is signed", async () => {
    const pinnedHash = drift()
    enrol(auth)
    const { cookie } = await files()
    const prepared = await prepare(cookie)
    expect(prepared.payloadHash).toBe(manifestHash(reviewed()))
    expect(prepared.challenge).toBe(expectedChallenge(prepared))
    const { row } = await files()
    expect(row).toMatchObject({ enabled: false, manifestHash: pinnedHash })
    expect(row.drift).toEqual({ added: ["bulk_move"], removed: ["trash_file"] })
  })

  it("keeps the old pin and the connector disabled when the signature is over another challenge", async () => {
    const pinnedHash = drift()
    enrol(auth)
    const { cookie } = await files()
    const prepared = await prepare(cookie)
    const refused = await call("POST", DECIDE, {
      cookie,
      body: {
        id: prepared.id,
        nonce: prepared.nonce,
        assertion: assertion(auth, "A".repeat(43)),
      },
    })
    expect([refused.status, code(refused)]).toEqual([
      403,
      "verification_failed",
    ])
    const { row } = await files()
    expect(row).toMatchObject({ enabled: false, manifestHash: pinnedHash })
    expect(row.drift).toBeDefined()
  })

  it("refuses a request with no assertion", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    const prepared = await prepare(cookie)
    const reply = await call("POST", DECIDE, {
      cookie,
      body: { id: prepared.id, nonce: prepared.nonce },
    })
    expect(reply.status).toBe(400)
    expect((await files()).row.enabled).toBe(false)
  })

  it("pins the reviewed manifest and enables the connector on a valid signature, once", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    const prepared = await prepare(cookie)
    const body = {
      id: prepared.id,
      nonce: prepared.nonce,
      assertion: assertion(auth, prepared.challenge),
    }
    const done = await call("POST", DECIDE, { cookie, body })
    const result = validateGateRepinResult(done.body)
    expect(result.ok && result.value).toEqual({
      connector: "files",
      manifestHash: manifestHash(reviewed()),
    })
    const { row } = await files()
    expect(row).toMatchObject({
      enabled: true,
      manifestHash: manifestHash(reviewed()),
    })
    expect(row).not.toHaveProperty("drift")
    const pinned = auditRows(s.db).filter(
      (r) => r.action === "connector.pinned" && r.target === "files"
    )
    expect(pinned).toHaveLength(2)
    expect(JSON.stringify(auditRows(s.db))).not.toContain("bulk_move")
    const replay = await call("POST", DECIDE, { cookie, body })
    expect(replay.status).toBe(409)
  })

  it("refuses a manifest that changed after the owner prepared it", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    const prepared = await prepare(cookie)
    const changed = reviewed()
    changed.description = "swapped after preparation"
    state.reviewedManifest = () => changed
    const reply = await call("POST", DECIDE, {
      cookie,
      body: {
        id: prepared.id,
        nonce: prepared.nonce,
        assertion: assertion(auth, prepared.challenge),
      },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect((await files()).row.enabled).toBe(false)
  })

  it.each([
    ["no session", "POST", "/connector-settings/files/repin", 401],
    [
      "no session on decision",
      "POST",
      "/connector-settings/files/repin/decision",
      401,
    ],
  ])("%s", async (_name, method, path, status) => {
    drift()
    expect((await call(method, path, { body: {} })).status).toBe(status)
  })

  it("refuses a connector that is not disabled for drift", async () => {
    enrol(auth)
    const cookie = await signIn()
    const reply = await call("POST", "/connector-settings/mail/repin", {
      cookie,
      body: {},
    })
    expect([reply.status, code(reply)]).toEqual([409, "unavailable"])
  })

  it("answers 404 for a connector that is not pinned", async () => {
    enrol(auth)
    const cookie = await signIn()
    const reply = await call("POST", "/connector-settings/nope/repin", {
      cookie,
      body: {},
    })
    expect(reply.status).toBe(404)
  })

  it("refuses when no reviewed manifest is placed", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    state.reviewedManifest = () => undefined
    expect((await call("POST", REPIN, { cookie, body: {} })).status).toBe(409)
  })

  it("refuses a reviewed manifest whose tools differ from what the server reports", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    state.reviewedManifest = () => manifest("files", FILE_OPS, 2)
    const reply = await call("POST", REPIN, { cookie, body: {} })
    expect(reply.status).toBe(409)
    expect(JSON.stringify(reply.body)).toContain("does not match")
  })

  it("refuses a reviewed manifest that does not raise the version", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    state.reviewedManifest = () => reviewed(1)
    expect((await call("POST", REPIN, { cookie, body: {} })).status).toBe(422)
  })

  it("refuses a reviewed manifest that is not valid JSON or is for another connector", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    state.reviewedManifest = () => null
    expect((await call("POST", REPIN, { cookie, body: {} })).status).toBe(422)
    state.reviewedManifest = () => ({ ...reviewed(), name: "mail" })
    expect((await call("POST", REPIN, { cookie, body: {} })).status).toBe(422)
  })

  it("treats a throwing manifest reader as no manifest", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    state.reviewedManifest = () => {
      throw new Error("unreadable")
    }
    expect((await call("POST", REPIN, { cookie, body: {} })).status).toBe(409)
  })

  it("refuses a non-empty prepare body", async () => {
    drift()
    enrol(auth)
    const { cookie } = await files()
    const reply = await call("POST", REPIN, {
      cookie,
      body: { manifest: reviewed() },
    })
    expect(reply.status).toBe(400)
  })
})
