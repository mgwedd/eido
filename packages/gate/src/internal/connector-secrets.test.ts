import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  validateGateConnectorHealth,
  validateGateControlPrepared,
  validateGateLoginOptions,
} from "@eido/schemas"
import type { GateControlPrepared, StackSettingsWrite } from "@eido/schemas"
import { BRIDGE_PASSWORD_KEY } from "./bridge/bridge"
import { createTestCertificate } from "./bridge/test-certificate"
import { reconcileBridgePin } from "./connector-secrets"
import type { GateRequest, Handler, Reply } from "./http"
import { PHONE_ROUTES, phoneHandler } from "./phone-routes"
import type { PhoneState } from "./phone-routes"
import { SupervisorUnavailableError } from "./supervisor-client"
import type { SupervisorClient } from "./supervisor-client"
import {
  assertion,
  auditRows,
  controlAuthorization,
  loggedText,
  MAIL_OPS,
  manifest,
  setup,
  testAuthenticator,
  WEBAUTHN,
} from "./test-fixtures"
import type { Setup, TestAuthenticator } from "./test-fixtures"
import { InMemoryVault } from "./vault/vault"
import type { VaultKey } from "./vault/vault"

const HOST = "gate.example.invalid"
const START = new Date("2026-11-06T08:00:00.000Z")

// Synthetic credentials only. Built from parts, so no line holds a credential-shaped URL.
const PASSWORD = "test-bridge-pass-61c4"
const SIMPLEFIN_HOST = "bridge.simplefin.org"
const CLAIM_URL = `https://${SIMPLEFIN_HOST}/simplefin/claim/test-claim-661`
const SETUP_TOKEN = Buffer.from(CLAIM_URL).toString("base64")
const ACCESS_USERINFO = ["test-user-661", "test-simplefin-pass-661"].join(":")
const ACCESS_URL = `https://${ACCESS_USERINFO}@${SIMPLEFIN_HOST}/simplefin`
const SIMPLEFIN_KEY: VaultKey = {
  connector: "simplefin",
  kind: "api_key",
  client: "read",
}

let s: Setup
let state: PhoneState
let vault: InMemoryVault
let auth: TestAuthenticator
let handler: Handler
let current: ReturnType<typeof createTestCertificate>
let next: ReturnType<typeof createTestCertificate>
let writes: StackSettingsWrite[]
let claims: string[]
let claimAnswer: () => Response

beforeAll(() => {
  current = createTestCertificate()
  next = createTestCertificate()
})
afterAll(() => {
  current.cleanup()
  next.cleanup()
})

function supervisor(): SupervisorClient {
  const refuse = () => Promise.reject(new Error("not used here"))
  return {
    doctor: refuse,
    jobs: refuse,
    start: refuse,
    stop: refuse,
    restart: refuse,
    models: refuse,
    useModel: refuse,
    fetchModel: refuse,
    loginItem: refuse,
    setLoginItem: refuse,
    settings: () => Promise.resolve({ sha256: "a".repeat(64), settings: {} }),
    writeSettings: (write) => {
      writes.push(write)
      return Promise.resolve({ sha256: "b".repeat(64), settings: {} })
    },
  }
}

beforeEach(() => {
  s = setup([
    manifest("proton-mail", MAIL_OPS),
    manifest("simplefin", MAIL_OPS),
  ])
  vault = new InMemoryVault()
  auth = testAuthenticator()
  writes = []
  claims = []
  claimAnswer = () => new Response(ACCESS_URL, { status: 200 })
  state = {
    db: s.db,
    policy: s.policy,
    webAuthn: WEBAUTHN,
    vault,
    // The pin points at `current`'s fingerprint but at `next`'s file, as after the owner
    // re-exports a regenerated Bridge certificate to the configured path.
    bridge: {
      certificateSha256: current.sha256,
      certificatePath: next.certPath,
    },
    supervisor: supervisor(),
    probes: { "proton-mail": () => Promise.resolve("ok") },
    fetch: (input) => {
      claims.push(input instanceof Request ? input.url : input.toString())
      return Promise.resolve(claimAnswer())
    },
  }
  handler = phoneHandler({
    gate: () => state,
    allowedHosts: [HOST],
    basePath: "",
    now: () => START,
  })
  s.db
    .prepare(
      "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
    )
    .run(auth.credentialId, auth.publicKey, START.toISOString())
})
afterEach(() => s.cleanup())

function call(
  path: string,
  options: { cookie?: string; body?: unknown } = {}
): Promise<Reply> {
  const request: GateRequest = {
    method: "POST",
    path,
    query: new URLSearchParams(),
    headers: {
      host: HOST,
      contentType: "application/json",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: () =>
      Promise.resolve({
        ok: true,
        text: options.body === undefined ? "" : JSON.stringify(options.body),
      }),
  }
  return Promise.resolve(handler(request))
}

const code = (reply: Reply): unknown =>
  typeof reply.body === "object" && reply.body !== null && "code" in reply.body
    ? reply.body.code
    : undefined

async function signIn(): Promise<string> {
  const options = validateGateLoginOptions(
    (await call("/auth/login/options")).body
  )
  if (!options.ok) throw new Error("login options do not match the schema")
  const reply = await call("/auth/login", {
    body: { assertion: assertion(auth, options.value.challenge) },
  })
  const cookie = reply.headers?.["set-cookie"]
  if (cookie === undefined) throw new Error("login refused")
  return cookie.split(";")[0] ?? ""
}

async function stepUp(cookie: string): Promise<void> {
  const options = validateGateLoginOptions(
    (await call("/auth/step-up/options", { cookie })).body
  )
  if (!options.ok) throw new Error("step-up options do not match the schema")
  const reply = await call("/auth/step-up", {
    cookie,
    body: {
      assertion: assertion(auth, options.value.challenge, { signCount: 1 }),
    },
  })
  expect(reply.status).toBe(200)
}

async function prepare(
  path: string,
  cookie: string,
  body: unknown = {}
): Promise<GateControlPrepared> {
  const reply = await call(path, { cookie, body })
  expect(reply.status).toBe(200)
  const parsed = validateGateControlPrepared(reply.body)
  if (!parsed.ok) throw new Error("the ceremony does not match the schema")
  return parsed.value
}

const tierOf = (path: string) =>
  PHONE_ROUTES.find((route) => route.path === path)?.tier

describe("connector secret routes (#661)", () => {
  it("are signed, prepared with a session, and remove is elevated", async () => {
    expect(
      [
        "/admin/secrets/bridge",
        "/admin/secrets/bridge-pin",
        "/admin/secrets/simplefin",
        "/admin/secrets/bridge/prepare",
        "/admin/secrets/bridge-pin/prepare",
        "/admin/secrets/simplefin/prepare",
        "/admin/connectors/:id/remove",
      ].map(tierOf)
    ).toEqual([
      "signed",
      "signed",
      "signed",
      "session",
      "session",
      "session",
      "elevated",
    ])
    const anonymous = await call("/admin/secrets/bridge", { body: {} })
    expect([anonymous.status, code(anonymous)]).toEqual([
      401,
      "unauthenticated",
    ])
    const cookie = await signIn()
    const unelevated = await call("/admin/connectors/simplefin/remove", {
      cookie,
    })
    expect([unelevated.status, code(unelevated)]).toEqual([
      403,
      "step_up_required",
    ])
  })

  it("seals the Bridge password once the passkey signs, checks the connector, and never echoes it", async () => {
    const cookie = await signIn()
    const ceremony = await prepare("/admin/secrets/bridge/prepare", cookie, {
      certificateSha256: current.sha256,
    })
    expect(JSON.parse(ceremony.payload)).toEqual({
      action: "connector.secret.set",
      connector: "proton-mail",
      certificateSha256: current.sha256,
    })
    const reply = await call("/admin/secrets/bridge", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        certificateSha256: current.sha256,
        password: PASSWORD,
      },
    })
    expect(reply.status).toBe(201)
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(PASSWORD)
    const health = validateGateConnectorHealth(reply.body)
    if (!health.ok) throw new Error("the reply does not match the schema")
    expect(health.value.connectors.map(({ name }) => name)).toEqual([
      "proton-mail",
    ])
    expect(JSON.stringify(reply.body)).not.toContain(PASSWORD)
    expect(loggedText(s.db)).not.toContain(PASSWORD)
    expect(auditRows(s.db).map(({ action }) => action)).toEqual(
      expect.arrayContaining(["connector.secret.set", "connector.connected"])
    )
  })

  it("seals nothing for a forged, unsigned or other-pin request", async () => {
    const cookie = await signIn()
    const ceremony = await prepare("/admin/secrets/bridge/prepare", cookie, {
      certificateSha256: current.sha256,
    })
    const signed = controlAuthorization(s.db, ceremony).request
    if (typeof signed !== "object" || signed === null)
      throw new Error("no approval")
    const forged = await call("/admin/secrets/bridge", {
      cookie,
      body: {
        approval: { ...signed, nonce: "A".repeat(43) },
        certificateSha256: current.sha256,
        password: PASSWORD,
      },
    })
    expect([forged.status, code(forged)]).toEqual([403, "verification_failed"])
    const unsigned = await call("/admin/secrets/bridge", {
      cookie,
      body: { certificateSha256: current.sha256, password: PASSWORD },
    })
    expect(unsigned.status).toBe(400)
    // The signature binds the pin: the same assertion for another pin is refused.
    const otherPin = await call("/admin/secrets/bridge", {
      cookie,
      body: {
        approval: signed,
        certificateSha256: next.sha256,
        password: PASSWORD,
      },
    })
    expect([otherPin.status, code(otherPin)]).toEqual([409, "pin_mismatch"])
    const prepareOther = await call("/admin/secrets/bridge/prepare", {
      cookie,
      body: { certificateSha256: next.sha256 },
    })
    expect(code(prepareOther)).toBe("pin_mismatch")
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBeUndefined()
    expect(loggedText(s.db)).not.toContain(PASSWORD)
  })

  it("changes the pin: deletes the stored password and writes the new pin to the stack settings", async () => {
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const cookie = await signIn()
    const ceremony = await prepare(
      "/admin/secrets/bridge-pin/prepare",
      cookie,
      {
        certificateSha256: next.sha256,
      }
    )
    const reply = await call("/admin/secrets/bridge-pin", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        certificateSha256: next.sha256,
      },
    })
    expect([reply.status, reply.body]).toEqual([
      200,
      { certificateSha256: next.sha256 },
    ])
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBeUndefined()
    expect(writes).toEqual([
      {
        expectedSha256: "a".repeat(64),
        set: { EIDO_BRIDGE_CERT_SHA256: next.sha256 },
      },
    ])
    // The gate restarting with the new pin keeps the (now empty) slot; no second delete is due.
    expect(await reconcileBridgePin(s.db, vault, next.sha256)).toBe("kept")
  })

  it("refuses a pin the certificate file does not match, before anything is signed", async () => {
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const cookie = await signIn()
    const reply = await call("/admin/secrets/bridge-pin/prepare", {
      cookie,
      body: { certificateSha256: "0".repeat(64) },
    })
    expect([reply.status, code(reply)]).toEqual([409, "certificate_mismatch"])
    const same = await call("/admin/secrets/bridge-pin/prepare", {
      cookie,
      body: { certificateSha256: current.sha256 },
    })
    expect([same.status, code(same)]).toEqual([400, "invalid_request"])
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(PASSWORD)
    expect(writes).toEqual([])
  })

  it("claims the SimpleFIN access URL only after the signature, and seals it", async () => {
    const cookie = await signIn()
    const ceremony = await prepare("/admin/secrets/simplefin/prepare", cookie)
    const unsigned = await call("/admin/secrets/simplefin", {
      cookie,
      body: {
        approval: { id: ceremony.id, nonce: ceremony.nonce, assertion: {} },
        setupToken: SETUP_TOKEN,
      },
    })
    expect(unsigned.status).toBe(400)
    expect(claims).toEqual([])
    const reply = await call("/admin/secrets/simplefin", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        setupToken: SETUP_TOKEN,
      },
    })
    expect(reply.status).toBe(201)
    expect(claims).toEqual([CLAIM_URL])
    expect(await vault.get(SIMPLEFIN_KEY)).toBe(ACCESS_URL)
    for (const secret of [SETUP_TOKEN, ACCESS_URL, ACCESS_USERINFO]) {
      expect(JSON.stringify(reply.body)).not.toContain(secret)
      expect(loggedText(s.db)).not.toContain(secret)
    }
  })

  it("reports a refused claim and stores nothing", async () => {
    claimAnswer = () => new Response("", { status: 403 })
    const cookie = await signIn()
    const ceremony = await prepare("/admin/secrets/simplefin/prepare", cookie)
    const reply = await call("/admin/secrets/simplefin", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        setupToken: SETUP_TOKEN,
      },
    })
    expect([reply.status, code(reply)]).toEqual([502, "claim_failed"])
    expect(await vault.get(SIMPLEFIN_KEY)).toBeUndefined()
  })

  it("remove deletes only the connector's vault entries", async () => {
    await vault.set(SIMPLEFIN_KEY, ACCESS_URL)
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const before = s.db
      .prepare("SELECT name, enabled FROM connectors ORDER BY name")
      .all()
    const cookie = await signIn()
    await stepUp(cookie)
    const reply = await call("/admin/connectors/simplefin/remove", { cookie })
    expect([reply.status, reply.body]).toEqual([
      200,
      { connector: "simplefin" },
    ])
    expect(await vault.get(SIMPLEFIN_KEY)).toBeUndefined()
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(PASSWORD)
    expect(
      s.db.prepare("SELECT name, enabled FROM connectors ORDER BY name").all()
    ).toEqual(before)
    expect(auditRows(s.db).map(({ action }) => action)).toContain(
      "connector.secrets.removed"
    )
  })
})

describe("connector secret refusals (#661)", () => {
  it("answers 503 without Bridge, a vault or the supervisor, and stores nothing", async () => {
    const cookie = await signIn()
    const { bridge: _bridge, ...noBridge } = state
    state = noBridge
    for (const path of [
      "/admin/secrets/bridge/prepare",
      "/admin/secrets/bridge-pin/prepare",
    ]) {
      const reply = await call(path, {
        cookie,
        body: { certificateSha256: next.sha256 },
      })
      expect([path, reply.status, code(reply)]).toEqual([
        path,
        503,
        "unavailable",
      ])
    }
    state = { ...state, bridge: _bridge, supervisor: undefined }
    const pin = await call("/admin/secrets/bridge-pin/prepare", {
      cookie,
      body: { certificateSha256: next.sha256 },
    })
    expect([pin.status, code(pin)]).toEqual([503, "supervisor_unavailable"])
    const ceremony = await prepare("/admin/secrets/simplefin/prepare", cookie)
    state = { ...state, supervisor: supervisor(), vault: undefined }
    const simplefin = await call("/admin/secrets/simplefin", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        setupToken: SETUP_TOKEN,
      },
    })
    expect([simplefin.status, code(simplefin)]).toEqual([503, "unavailable"])
    expect(claims).toEqual([])
    await stepUp(cookie)
    const remove = await call("/admin/connectors/simplefin/remove", { cookie })
    expect([remove.status, code(remove)]).toEqual([503, "unavailable"])
  })

  it("refuses a forged pin change and keeps the password", async () => {
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const cookie = await signIn()
    const ceremony = await prepare(
      "/admin/secrets/bridge-pin/prepare",
      cookie,
      {
        certificateSha256: next.sha256,
      }
    )
    const signed = controlAuthorization(s.db, ceremony).request
    if (typeof signed !== "object" || signed === null)
      throw new Error("no approval")
    const reply = await call("/admin/secrets/bridge-pin", {
      cookie,
      body: {
        approval: { ...signed, nonce: "A".repeat(43) },
        certificateSha256: next.sha256,
      },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(PASSWORD)
    expect(writes).toEqual([])
  })

  it("reports a supervisor that cannot write the new pin, after the password is gone", async () => {
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    state = {
      ...state,
      supervisor: {
        ...supervisor(),
        settings: () => Promise.reject(new SupervisorUnavailableError("down")),
      },
    }
    const cookie = await signIn()
    const ceremony = await prepare(
      "/admin/secrets/bridge-pin/prepare",
      cookie,
      {
        certificateSha256: next.sha256,
      }
    )
    const reply = await call("/admin/secrets/bridge-pin", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        certificateSha256: next.sha256,
      },
    })
    expect([reply.status, code(reply)]).toEqual([503, "supervisor_unavailable"])
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBeUndefined()
  })

  it("refuses a setup token that is not a SimpleFIN claim URL, without calling out", async () => {
    const cookie = await signIn()
    const ceremony = await prepare("/admin/secrets/simplefin/prepare", cookie)
    const reply = await call("/admin/secrets/simplefin", {
      cookie,
      body: {
        approval: controlAuthorization(s.db, ceremony).request,
        setupToken: "not-base64-at-all",
      },
    })
    expect([reply.status, code(reply)]).toEqual([400, "invalid_request"])
    expect(claims).toEqual([])
  })

  it("refuses a forged SimpleFIN approval without claiming", async () => {
    const cookie = await signIn()
    const ceremony = await prepare("/admin/secrets/simplefin/prepare", cookie)
    const signed = controlAuthorization(s.db, ceremony).request
    if (typeof signed !== "object" || signed === null)
      throw new Error("no approval")
    const reply = await call("/admin/secrets/simplefin", {
      cookie,
      body: {
        approval: { ...signed, nonce: "A".repeat(43) },
        setupToken: SETUP_TOKEN,
      },
    })
    expect([reply.status, code(reply)]).toEqual([403, "verification_failed"])
    expect(claims).toEqual([])
  })

  it("remove refuses a malformed name, and clears the Bridge pin record for proton-mail", async () => {
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    await reconcileBridgePin(s.db, vault, current.sha256)
    const cookie = await signIn()
    await stepUp(cookie)
    const bad = await call("/admin/connectors/Bad_Name/remove", { cookie })
    expect([bad.status, code(bad)]).toEqual([400, "invalid_request"])
    const reply = await call("/admin/connectors/proton-mail/remove", { cookie })
    expect(reply.status).toBe(200)
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBeUndefined()
    expect(s.db.prepare("SELECT * FROM bridge_password_pin").all()).toEqual([])
  })
})

describe("reconcileBridgePin (#661)", () => {
  it("records the first pin, keeps the password for it, and deletes it when the pin changes", async () => {
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    expect(await reconcileBridgePin(s.db, vault, current.sha256)).toBe("kept")
    expect(await reconcileBridgePin(s.db, vault, current.sha256)).toBe("kept")
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(PASSWORD)
    expect(await reconcileBridgePin(s.db, vault, next.sha256)).toBe("deleted")
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBeUndefined()
    expect(auditRows(s.db).map(({ action }) => action)).toContain(
      "connector.secret.deleted"
    )
  })
})
