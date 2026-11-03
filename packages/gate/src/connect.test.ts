import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { request } from "node:http"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectorManifest } from "@eido/schemas"
import { connect, GMAIL_CLIENT_ID_ENV, openInBrowser } from "./connect"
import type { ConnectIo } from "./connect"
import { CONTROL_SOCKET_ENV } from "./enrol-code"
import { BRIDGE_PASSWORD_KEY } from "./internal/bridge/bridge"
import type { ConnectorProbe } from "./internal/connector-connect"
import { egressProbe } from "./internal/egress"
import { gmailProbe as gateGmailProbe } from "./internal/gmail-transport"
import { close, createGateServer, listen } from "./internal/http"
import { controlHandler } from "./internal/routes"
import {
  loggedText,
  MAIL_OPS,
  manifest,
  setup,
  socketAddress,
} from "./internal/test-fixtures"
import type { Setup } from "./internal/test-fixtures"
import { FileVault } from "./internal/vault/file-vault"
import { InMemoryVault } from "./internal/vault/vault"
import type { VaultKey } from "./internal/vault/vault"
import {
  allProbes,
  DRIVE_CLIENT_ID_ENV,
  GMAIL_READ_CLIENT_ID_ENV,
  READ_CONNECTORS,
} from "./main"

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify"
const CLIENT_ID = "test-client.apps.example.invalid"
const CLIENT_SECRET = "test-client-secret-7f3a"
const REFRESH_TOKEN = "test-refresh-token-91c2"
const AUTH_CODE = "test-auth-code-55d0"
const BRIDGE_PASSWORD = "test-bridge-password-0b8e"
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly"
const DRIVE_CLIENT_ID = "test-drive-client.apps.example.invalid"
const DRIVE_SECRET = "test-drive-client-secret-2e6b"
const DRIVE_REFRESH = "test-drive-refresh-token-c4a8"
const DRIVE_ACCESS = "test-drive-access-token-19f7"
const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly"
const GMAIL_READ_CLIENT_ID = "test-gmail-read-client.apps.example.invalid"
const GMAIL_READ_SECRET = "test-gmail-read-secret-8d31"
const GMAIL_READ_REFRESH = "test-gmail-read-refresh-6a0e"
const GMAIL_READ_ACCESS = "test-gmail-read-access-f2b9"
const GMAIL_WRITE_ACCESS = "test-gmail-write-access-3c57"
const GMAIL_PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
const DRIVE_START_PAGE_TOKEN =
  "https://www.googleapis.com/drive/v3/changes/startPageToken"

const key = (kind: VaultKey["kind"]): VaultKey => ({
  connector: "gmail",
  kind,
  client: "write",
})
const REFRESH_KEY = key("refresh_token")
const SECRET_KEY = key("api_key")
const ACCESS_KEY = key("access_token")

let dir: string
let s: Setup
let server: Server
let socket: string
let vault: InMemoryVault
let probes: Record<string, ConnectorProbe>
let out: string[]
let err: string[]
let answers: Array<string | undefined>
let questions: string[]
let callbacks: Array<Promise<number>>

/** Sends one GET to the loopback listener, as the browser would after the redirect. */
function browserGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        agent: false,
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      }
    )
      .on("error", reject)
      .end()
  })
}

/** A browser that completes the Google sign-in: it redirects back with `answer` added. */
const signIn =
  (answer: (state: string) => Record<string, string>) => (url: string) => {
    const auth = new URL(url).searchParams
    const redirect = auth.get("redirect_uri") ?? ""
    const query = new URLSearchParams(answer(auth.get("state") ?? ""))
    callbacks.push(browserGet(`${redirect}?${query.toString()}`))
  }

function io(openBrowser: (url: string) => void = () => undefined): ConnectIo {
  return {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    prompt: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift())
    },
    openBrowser,
  }
}

/** A Google token endpoint that grants REFRESH_TOKEN for AUTH_CODE and records each body. */
function tokenEndpoint(
  grant: Record<string, unknown> = {
    access_token: "test-access-token",
    refresh_token: REFRESH_TOKEN,
    scope: GMAIL_MODIFY,
  }
) {
  const bodies: Array<Record<string, string>> = []
  const send = vi.fn<typeof fetch>((input, init) => {
    expect(input).toBe(TOKEN_ENDPOINT)
    const body = init?.body
    if (!(body instanceof URLSearchParams))
      throw new Error("the exchange body is not form-encoded")
    bodies.push(Object.fromEntries(body))
    return Promise.resolve(Response.json(grant))
  })
  return { send, bodies }
}

const env = (extra: Record<string, string> = {}) => ({
  [CONTROL_SOCKET_ENV]: socket,
  [GMAIL_CLIENT_ID_ENV]: CLIENT_ID,
  ...extra,
})

/** Everything the CLI and the gate wrote where a person or a log could read it. */
const visible = () => [...out, ...err, loggedText(s.db)].join("\n")

/** The gate's Gmail probe here passes only when the vault holds the refresh token just granted. */
const gmailProbe: ConnectorProbe = async () =>
  (await vault.get(REFRESH_KEY)) === REFRESH_TOKEN ? "ok" : "auth_failed"

/** The Gmail manifest: the compose client's writes plus the profile read both clients' probes make. */
function gmailManifest(): ConnectorManifest {
  const host = "gmail.googleapis.com"
  const pinned = manifest("gmail", MAIL_OPS)
  pinned.egress.hosts.push({
    host,
    methods: ["GET"],
    pathPrefixes: ["/gmail/v1/users/me"],
  })
  pinned.operations.push({
    name: "profile",
    effect: "read",
    reversibility: "reversible",
    defaultTier: "auto",
    sensitivity: "normal",
    untrustedOutput: true,
    authScopes: ["write"],
    routes: [
      { host, method: "GET", pathPattern: "/gmail/v1/users/me/profile" },
    ],
  })
  return pinned
}

/** A pinned Drive manifest whose one read is the gate's health probe route. */
function driveManifest(): ConnectorManifest {
  const host = "www.googleapis.com"
  const pinned = manifest("drive", [])
  pinned.egress.hosts = [
    { host, methods: ["GET"], pathPrefixes: ["/drive/v3"] },
  ]
  pinned.operations = [
    {
      name: "start_page_token",
      effect: "read",
      reversibility: "reversible",
      defaultTier: "auto",
      sensitivity: "normal",
      untrustedOutput: true,
      authScopes: ["write"],
      routes: [
        {
          host,
          method: "GET",
          pathPattern: "/drive/v3/changes/startPageToken",
        },
      ],
    },
  ]
  return pinned
}

/**
 * A fake Google for Drive: the token endpoint grants DRIVE_REFRESH for AUTH_CODE and, on a
 * refresh of DRIVE_REFRESH, issues DRIVE_ACCESS, or answers `invalid_grant` once the grant is
 * revoked. The Drive API accepts DRIVE_ACCESS only. `seen` records each request as the gate sent
 * it, in order.
 */
function fakeDriveGoogle(
  options: { revoked?: boolean; grant?: Record<string, unknown> } = {}
) {
  const seen: Array<{ url: string; form?: Record<string, string> }> = []
  const send = vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url === TOKEN_ENDPOINT) {
      const body = init?.body
      if (!(body instanceof URLSearchParams))
        throw new Error("the token request is not form-encoded")
      const form = Object.fromEntries(body)
      seen.push({ url, form })
      if (form["grant_type"] === "authorization_code")
        return Promise.resolve(
          Response.json(
            options.grant ?? {
              access_token: "test-drive-exchange-access-token",
              refresh_token: DRIVE_REFRESH,
              scope: DRIVE_READONLY,
            }
          )
        )
      if (options.revoked === true)
        return Promise.resolve(
          Response.json({ error: "invalid_grant" }, { status: 400 })
        )
      return Promise.resolve(
        form["refresh_token"] === DRIVE_REFRESH &&
          form["client_secret"] === DRIVE_SECRET
          ? Response.json({ access_token: DRIVE_ACCESS })
          : Response.json({ error: "invalid_client" }, { status: 401 })
      )
    }
    seen.push({ url })
    const authorization = new Headers(init?.headers).get("authorization")
    return Promise.resolve(
      authorization === `Bearer ${DRIVE_ACCESS}`
        ? Response.json({ startPageToken: "42" })
        : new Response(null, { status: 401 })
    )
  })
  return { send, seen }
}

/** The gate's real Drive probe, as runGate registers it, over the test vault and fake Google. */
function driveProbe(send: typeof fetch): ConnectorProbe {
  const probeUrl =
    READ_CONNECTORS.find((read) => read.connector === "drive")?.probeUrl ?? ""
  return egressProbe(
    { db: s.db, vault, clientIds: { drive: DRIVE_CLIENT_ID }, fetch: send },
    "drive",
    probeUrl
  )
}

const driveKey = (kind: VaultKey["kind"]): VaultKey => ({
  connector: "drive",
  kind,
  client: "read",
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "eido-connect-"))
  socket = socketAddress(dir, "control.sock")
  s = setup([
    gmailManifest(),
    driveManifest(),
    manifest("proton-mail", MAIL_OPS),
    manifest("proton-calendar", MAIL_OPS),
  ])
  vault = new InMemoryVault()
  probes = {
    gmail: gmailProbe,
    "proton-mail": async () =>
      (await vault.get(BRIDGE_PASSWORD_KEY)) === BRIDGE_PASSWORD
        ? "ok"
        : "auth_failed",
  }
  out = []
  err = []
  answers = []
  questions = []
  callbacks = []
  server = createGateServer(
    "control",
    controlHandler(
      () => ({ db: s.db, policy: s.policy, probes }),
      () => new Date("2026-11-02T09:00:00.000Z")
    ),
    () => undefined
  )
  await listen(server, socket, 0o600)
})

afterEach(async () => {
  await Promise.allSettled(callbacks)
  if (server.listening) await close(server)
  s.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

describe("connect gmail", () => {
  it("signs in with PKCE, stores the refresh token and the secret, and ends healthy", async () => {
    answers = [CLIENT_SECRET]
    const google = tokenEndpoint()
    let challenge = ""
    const status = await connect(
      ["gmail"],
      env(),
      io((url) => {
        challenge = new URL(url).searchParams.get("code_challenge") ?? ""
        signIn((state) => ({ state, code: AUTH_CODE }))(url)
      }),
      { vault, fetch: google.send }
    )
    expect(status).toBe(0)
    expect(questions).toEqual(["Google OAuth client secret (not shown): "])
    expect(await vault.get(REFRESH_KEY)).toBe(REFRESH_TOKEN)
    expect(await vault.get(SECRET_KEY)).toBe(CLIENT_SECRET)
    const [exchange] = google.bodies
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      code: AUTH_CODE,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
    // The verifier sent is the one whose S256 hash went out as the challenge.
    const verifier = exchange?.["code_verifier"] ?? ""
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      challenge
    )
    expect(out.at(-1)).toBe("gmail: healthy")
    expect(visible()).not.toContain(REFRESH_TOKEN)
    expect(visible()).not.toContain(CLIENT_SECRET)
    expect(visible()).not.toContain(AUTH_CODE)
    expect(visible()).not.toContain(verifier)
  })

  it("reconnects over the old grant without asking for the stored secret again", async () => {
    await vault.set(SECRET_KEY, CLIENT_SECRET)
    await vault.set(REFRESH_KEY, "test-revoked-refresh-token")
    await vault.set(ACCESS_KEY, "test-stale-access-token")
    s.db
      .prepare(
        "UPDATE connectors SET enabled = 0, health = 'open', last_error = 'auth_failed' WHERE name = 'gmail'"
      )
      .run()
    const status = await connect(
      ["gmail"],
      env(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: tokenEndpoint().send }
    )
    expect(status).toBe(0)
    expect(questions).toEqual([])
    expect(await vault.get(REFRESH_KEY)).toBe(REFRESH_TOKEN)
    expect(await vault.get(ACCESS_KEY)).toBeUndefined()
    expect(
      s.db.prepare("SELECT enabled FROM connectors WHERE name = 'gmail'").get()
    ).toEqual({ enabled: 1 })
  })

  it("refuses a callback with another state and stores nothing", async () => {
    answers = [CLIENT_SECRET]
    const google = tokenEndpoint()
    const status = await connect(
      ["gmail"],
      env(),
      io(signIn(() => ({ state: "forged-state", code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "The sign-in answer did not match this request, so it was refused. Nothing was stored.",
    ])
    expect(google.send).not.toHaveBeenCalled()
    expect(await vault.get(REFRESH_KEY)).toBeUndefined()
    expect(await vault.get(SECRET_KEY)).toBeUndefined()
  })

  it("stores nothing when Google sends back an error", async () => {
    answers = [CLIENT_SECRET]
    const google = tokenEndpoint()
    const status = await connect(
      ["gmail"],
      env(),
      io(signIn((state) => ({ state, error: "access_denied" }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "Google did not grant access (access_denied). Nothing was stored.",
    ])
    expect(google.send).not.toHaveBeenCalled()
    expect(await vault.get(REFRESH_KEY)).toBeUndefined()
    expect(await vault.get(SECRET_KEY)).toBeUndefined()
  })

  it("stores nothing when the token endpoint grants no Gmail scope", async () => {
    answers = [CLIENT_SECRET]
    const status = await connect(
      ["gmail"],
      env(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      {
        vault,
        fetch: tokenEndpoint({ refresh_token: REFRESH_TOKEN, scope: "openid" })
          .send,
      }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "The Gmail permission was not granted; tick it on the consent screen. Nothing was stored.",
    ])
    expect(await vault.get(REFRESH_KEY)).toBeUndefined()
  })

  it("gives up when no sign-in arrives in time", async () => {
    answers = [CLIENT_SECRET]
    const opened: string[] = []
    const status = await connect(
      ["gmail"],
      env(),
      io((url) => opened.push(url)),
      { vault, fetch: tokenEndpoint().send, signInTimeoutMs: 30 }
    )
    expect(status).toBe(1)
    expect(opened).toHaveLength(1)
    expect(out).toContain(opened[0])
    expect(err).toEqual(["No sign-in arrived in time. Nothing was stored."])
    expect(await vault.get(REFRESH_KEY)).toBeUndefined()
  })

  it("stops before signing in when no client secret is given", async () => {
    answers = [""]
    const opened: string[] = []
    const status = await connect(
      ["gmail"],
      env(),
      io((url) => opened.push(url)),
      { vault }
    )
    expect(status).toBe(1)
    expect(opened).toEqual([])
    expect(err).toEqual(["No client secret was given. Nothing was stored."])
  })

  it("needs the gate's Gmail client id", async () => {
    const status = await connect(
      ["gmail"],
      { [CONTROL_SOCKET_ENV]: socket },
      io(),
      { vault }
    )
    expect(status).toBe(2)
    expect(err).toEqual([
      "EIDO_GMAIL_CLIENT_ID is not set; use the gate's Gmail client id",
    ])
  })

  it("prints the refusal and the way out when the gate's check fails on the new grant", async () => {
    answers = [CLIENT_SECRET]
    probes = { gmail: () => Promise.resolve("auth_failed") }
    const status = await connect(
      ["gmail"],
      env(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: tokenEndpoint().send }
    )
    expect(status).toBe(1)
    expect(out.slice(-2)).toEqual([
      "gmail: open (auth_failed)",
      "The credential was refused. Run connect again.",
    ])
  })
})

describe("connect drive", () => {
  const driveEnv = () => env({ [DRIVE_CLIENT_ID_ENV]: DRIVE_CLIENT_ID })

  it("signs in for drive.readonly, stores the read grant, and the gate's probe finds it healthy", async () => {
    answers = [DRIVE_SECRET]
    const google = fakeDriveGoogle()
    probes = { drive: driveProbe(google.send) }
    let auth = new URLSearchParams()
    const status = await connect(
      ["drive"],
      driveEnv(),
      io((url) => {
        auth = new URL(url).searchParams
        signIn((state) => ({ state, code: AUTH_CODE }))(url)
      }),
      { vault, fetch: google.send }
    )
    expect(status).toBe(0)
    expect(auth.get("scope")).toBe(DRIVE_READONLY)
    expect(auth.get("client_id")).toBe(DRIVE_CLIENT_ID)
    expect(await vault.get(driveKey("refresh_token"))).toBe(DRIVE_REFRESH)
    expect(await vault.get(driveKey("api_key"))).toBe(DRIVE_SECRET)
    expect(
      await vault.get({
        connector: "drive",
        kind: "refresh_token",
        client: "write",
      })
    ).toBeUndefined()
    const [exchange, refresh, read] = google.seen
    expect(exchange?.form).toMatchObject({
      grant_type: "authorization_code",
      code: AUTH_CODE,
      client_id: DRIVE_CLIENT_ID,
      client_secret: DRIVE_SECRET,
    })
    const verifier = exchange?.form?.["code_verifier"] ?? ""
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      auth.get("code_challenge")
    )
    // The probe refreshed from the stored grant, then made its one pinned read.
    expect(refresh?.form).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: DRIVE_REFRESH,
      client_id: DRIVE_CLIENT_ID,
    })
    expect(read).toEqual({ url: DRIVE_START_PAGE_TOKEN })
    expect(google.seen).toHaveLength(3)
    expect(out.slice(-2)).toEqual([
      "Stored the Drive credential in the gate vault.",
      "drive: healthy",
    ])
    for (const secret of [
      DRIVE_SECRET,
      DRIVE_REFRESH,
      DRIVE_ACCESS,
      AUTH_CODE,
      verifier,
    ])
      expect(visible()).not.toContain(secret)
  })

  it("reports auth_failed and disables Drive when Google has revoked the new grant", async () => {
    answers = [DRIVE_SECRET]
    const google = fakeDriveGoogle({ revoked: true })
    probes = { drive: driveProbe(google.send) }
    const status = await connect(
      ["drive"],
      driveEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(out.slice(-2)).toEqual([
      "drive: open (auth_failed)",
      "The credential was refused. Run connect again.",
    ])
    expect(
      s.db
        .prepare(
          "SELECT enabled, last_error FROM connectors WHERE name = 'drive'"
        )
        .get()
    ).toEqual({ enabled: 0, last_error: "auth_failed" })
    // No Drive read went out: the refresh was refused first.
    expect(google.seen.map((entry) => entry.url)).toEqual([
      TOKEN_ENDPOINT,
      TOKEN_ENDPOINT,
    ])
    for (const secret of [DRIVE_SECRET, DRIVE_REFRESH, AUTH_CODE])
      expect(visible()).not.toContain(secret)
  })

  it("reconnects a disabled Drive over the old grant and drops the cached access token", async () => {
    await vault.set(driveKey("api_key"), DRIVE_SECRET)
    await vault.set(driveKey("refresh_token"), "test-revoked-drive-refresh")
    await vault.set(driveKey("access_token"), "test-stale-drive-access")
    s.db
      .prepare(
        "UPDATE connectors SET enabled = 0, health = 'open', last_error = 'auth_failed' WHERE name = 'drive'"
      )
      .run()
    const google = fakeDriveGoogle()
    probes = { drive: driveProbe(google.send) }
    const status = await connect(
      ["drive"],
      driveEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(0)
    expect(questions).toEqual([])
    expect(await vault.get(driveKey("refresh_token"))).toBe(DRIVE_REFRESH)
    // The probe's fresh token replaced the stale one, which no read used.
    expect(await vault.get(driveKey("access_token"))).toBe(DRIVE_ACCESS)
    expect(google.seen.map((entry) => entry.url)).toEqual([
      TOKEN_ENDPOINT,
      TOKEN_ENDPOINT,
      DRIVE_START_PAGE_TOKEN,
    ])
  })

  it("refuses a callback with another state and stores nothing", async () => {
    answers = [DRIVE_SECRET]
    const google = fakeDriveGoogle()
    const status = await connect(
      ["drive"],
      driveEnv(),
      io(signIn(() => ({ state: "forged-state", code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "The sign-in answer did not match this request, so it was refused. Nothing was stored.",
    ])
    expect(google.send).not.toHaveBeenCalled()
    expect(await vault.get(driveKey("refresh_token"))).toBeUndefined()
    expect(await vault.get(driveKey("api_key"))).toBeUndefined()
  })

  it("stores nothing when Google refuses the authorization code", async () => {
    answers = [DRIVE_SECRET]
    const refuse = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ error: "invalid_grant" }, { status: 400 })
      )
    )
    const status = await connect(
      ["drive"],
      driveEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: refuse }
    )
    expect(status).toBe(1)
    expect(refuse).toHaveBeenCalledTimes(1)
    expect(err).toEqual([
      "Google refused the authorization code (invalid_grant). Nothing was stored.",
    ])
    expect(await vault.get(driveKey("refresh_token"))).toBeUndefined()
    expect(await vault.get(driveKey("api_key"))).toBeUndefined()
  })

  it("stores nothing when the Drive scope was not granted", async () => {
    answers = [DRIVE_SECRET]
    const google = fakeDriveGoogle({
      grant: { refresh_token: DRIVE_REFRESH, scope: GMAIL_MODIFY },
    })
    const status = await connect(
      ["drive"],
      driveEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "The Drive permission was not granted; tick it on the consent screen. Nothing was stored.",
    ])
    expect(await vault.get(driveKey("refresh_token"))).toBeUndefined()
  })

  it("needs the gate's Drive client id", async () => {
    const status = await connect(["drive"], env(), io(), { vault })
    expect(status).toBe(2)
    expect(err).toEqual([
      "EIDO_DRIVE_CLIENT_ID is not set; use the gate's Drive client id",
    ])
  })
})

describe("connect gmail-read", () => {
  const readKey = (kind: VaultKey["kind"]): VaultKey => ({
    connector: "gmail",
    kind,
    client: "read",
  })
  const readEnv = () =>
    env({ [GMAIL_READ_CLIENT_ID_ENV]: GMAIL_READ_CLIENT_ID })

  /**
   * A fake Google for both Gmail clients. The token endpoint grants GMAIL_READ_REFRESH for
   * AUTH_CODE, and refreshes each client's own refresh token, with its own client id and secret,
   * to that client's access token; anything else is `invalid_grant`. The profile read accepts
   * either access token. `profileReads` records the token each profile read carried.
   */
  function fakeGmailGoogle(options: { grant?: Record<string, unknown> } = {}) {
    const profileReads: string[] = []
    const send = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url === TOKEN_ENDPOINT) {
        const body = init?.body
        if (!(body instanceof URLSearchParams))
          throw new Error("the token request is not form-encoded")
        const form = Object.fromEntries(body)
        if (form["grant_type"] === "authorization_code")
          return Promise.resolve(
            Response.json(
              options.grant ?? {
                access_token: "test-gmail-exchange-access",
                refresh_token: GMAIL_READ_REFRESH,
                scope: GMAIL_READONLY,
              }
            )
          )
        const clients: Array<[string, string, string, string]> = [
          [REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET, GMAIL_WRITE_ACCESS],
          [
            GMAIL_READ_REFRESH,
            GMAIL_READ_CLIENT_ID,
            GMAIL_READ_SECRET,
            GMAIL_READ_ACCESS,
          ],
        ]
        const match = clients.find(
          ([refresh, id, secret]) =>
            form["refresh_token"] === refresh &&
            form["client_id"] === id &&
            form["client_secret"] === secret
        )
        return Promise.resolve(
          match === undefined
            ? Response.json({ error: "invalid_grant" }, { status: 400 })
            : Response.json({ access_token: match[3] })
        )
      }
      expect(url).toBe(GMAIL_PROFILE)
      const authorization = new Headers(init?.headers).get("authorization")
      profileReads.push(authorization ?? "")
      return Promise.resolve(
        authorization === `Bearer ${GMAIL_WRITE_ACCESS}` ||
          authorization === `Bearer ${GMAIL_READ_ACCESS}`
          ? Response.json({ emailAddress: "owner@example.invalid" })
          : new Response(null, { status: 401 })
      )
    })
    return { send, profileReads }
  }

  /** The gate's Gmail check, as runGate builds it with both clients configured. */
  function bothClientsProbe(send: typeof fetch): ConnectorProbe {
    const probeUrl =
      READ_CONNECTORS.find((read) => read.connector === "gmail")?.probeUrl ?? ""
    return allProbes([
      gateGmailProbe({ db: s.db, vault, clientId: CLIENT_ID, fetch: send }),
      egressProbe(
        {
          db: s.db,
          vault,
          clientIds: { gmail: GMAIL_READ_CLIENT_ID },
          fetch: send,
        },
        "gmail",
        probeUrl
      ),
    ])
  }

  /** The compose client's grant, as `connect gmail` leaves it. */
  async function storeWriteGrant(refresh: string): Promise<void> {
    await vault.set(SECRET_KEY, CLIENT_SECRET)
    await vault.set(REFRESH_KEY, refresh)
  }

  it("signs in for gmail.readonly, stores the read grant, and Gmail is healthy with both clients", async () => {
    await storeWriteGrant(REFRESH_TOKEN)
    answers = [GMAIL_READ_SECRET]
    const google = fakeGmailGoogle()
    probes = { gmail: bothClientsProbe(google.send) }
    let auth = new URLSearchParams()
    const status = await connect(
      ["gmail-read"],
      readEnv(),
      io((url) => {
        auth = new URL(url).searchParams
        signIn((state) => ({ state, code: AUTH_CODE }))(url)
      }),
      { vault, fetch: google.send }
    )
    expect(status).toBe(0)
    expect(auth.get("scope")).toBe(GMAIL_READONLY)
    expect(auth.get("client_id")).toBe(GMAIL_READ_CLIENT_ID)
    expect(await vault.get(readKey("refresh_token"))).toBe(GMAIL_READ_REFRESH)
    expect(await vault.get(readKey("api_key"))).toBe(GMAIL_READ_SECRET)
    // The compose client's grant is left as it was.
    expect(await vault.get(REFRESH_KEY)).toBe(REFRESH_TOKEN)
    expect(await vault.get(SECRET_KEY)).toBe(CLIENT_SECRET)
    // Each client made its own profile read.
    expect(google.profileReads).toEqual([
      `Bearer ${GMAIL_WRITE_ACCESS}`,
      `Bearer ${GMAIL_READ_ACCESS}`,
    ])
    expect(out.slice(-2)).toEqual([
      "Stored the Gmail read credential in the gate vault.",
      "gmail: healthy",
    ])
    const exchange = google.send.mock.calls
      .map(([, init]) => init?.body)
      .find(
        (body): body is URLSearchParams =>
          body instanceof URLSearchParams &&
          body.get("grant_type") === "authorization_code"
      )
    const verifier = exchange?.get("code_verifier") ?? ""
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      auth.get("code_challenge")
    )
    for (const secret of [
      GMAIL_READ_SECRET,
      GMAIL_READ_REFRESH,
      GMAIL_READ_ACCESS,
      GMAIL_WRITE_ACCESS,
      CLIENT_SECRET,
      REFRESH_TOKEN,
      AUTH_CODE,
      verifier,
    ])
      expect(visible()).not.toContain(secret)
  })

  it("is not healthy when the compose client's grant has been revoked, though the read grant works", async () => {
    await storeWriteGrant("test-revoked-write-refresh")
    answers = [GMAIL_READ_SECRET]
    const google = fakeGmailGoogle()
    probes = { gmail: bothClientsProbe(google.send) }
    const status = await connect(
      ["gmail-read"],
      readEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(await vault.get(readKey("refresh_token"))).toBe(GMAIL_READ_REFRESH)
    expect(out.slice(-2)).toEqual([
      "gmail: open (auth_failed)",
      "The credential was refused. Run connect again.",
    ])
    expect(google.profileReads).toEqual([])
  })

  it("is not healthy when Google revokes the new read grant, though the compose client works", async () => {
    await storeWriteGrant(REFRESH_TOKEN)
    answers = [GMAIL_READ_SECRET]
    const google = fakeGmailGoogle({
      grant: {
        refresh_token: "test-gmail-read-refresh-already-revoked",
        scope: GMAIL_READONLY,
      },
    })
    probes = { gmail: bothClientsProbe(google.send) }
    const status = await connect(
      ["gmail-read"],
      readEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(out.at(-2)).toBe("gmail: open (auth_failed)")
    expect(google.profileReads).toEqual([`Bearer ${GMAIL_WRITE_ACCESS}`])
    expect(
      s.db
        .prepare(
          "SELECT enabled, last_error FROM connectors WHERE name = 'gmail'"
        )
        .get()
    ).toEqual({ enabled: 0, last_error: "auth_failed" })
  })

  it("refuses a callback with another state and stores nothing", async () => {
    await storeWriteGrant(REFRESH_TOKEN)
    answers = [GMAIL_READ_SECRET]
    const google = fakeGmailGoogle()
    const status = await connect(
      ["gmail-read"],
      readEnv(),
      io(signIn(() => ({ state: "forged-state", code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "The sign-in answer did not match this request, so it was refused. Nothing was stored.",
    ])
    expect(google.send).not.toHaveBeenCalled()
    expect(await vault.get(readKey("refresh_token"))).toBeUndefined()
    expect(await vault.get(readKey("api_key"))).toBeUndefined()
  })

  it("stores nothing when the read scope was not granted", async () => {
    answers = [GMAIL_READ_SECRET]
    const google = fakeGmailGoogle({
      grant: { refresh_token: GMAIL_READ_REFRESH, scope: GMAIL_MODIFY },
    })
    const status = await connect(
      ["gmail-read"],
      readEnv(),
      io(signIn((state) => ({ state, code: AUTH_CODE }))),
      { vault, fetch: google.send }
    )
    expect(status).toBe(1)
    expect(err).toEqual([
      "The Gmail permission was not granted; tick it on the consent screen. Nothing was stored.",
    ])
    expect(await vault.get(readKey("refresh_token"))).toBeUndefined()
    expect(await vault.get(readKey("api_key"))).toBeUndefined()
  })

  it("needs the gate's Gmail read client id", async () => {
    const status = await connect(["gmail-read"], env(), io(), { vault })
    expect(status).toBe(2)
    expect(err).toEqual([
      "EIDO_GMAIL_READ_CLIENT_ID is not set; use the gate's Gmail client id",
    ])
  })
})

describe("connect proton", () => {
  it("stores the Bridge password and ends healthy", async () => {
    answers = [BRIDGE_PASSWORD]
    const status = await connect(["proton-mail"], env(), io(), { vault })
    expect(status).toBe(0)
    expect(questions).toEqual([
      "Bridge password, from the Bridge app (not shown): ",
    ])
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(BRIDGE_PASSWORD)
    expect(out).toEqual([
      "Stored the Bridge password in the gate vault.",
      "proton-mail: healthy",
    ])
    expect(visible()).not.toContain(BRIDGE_PASSWORD)
  })

  it("stores nothing when no password is given", async () => {
    answers = [undefined]
    const status = await connect(["proton-mail"], env(), io(), { vault })
    expect(status).toBe(1)
    expect(err).toEqual(["No password was given. Nothing was stored."])
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBeUndefined()
  })

  it("reports a degraded check with its reason", async () => {
    answers = [BRIDGE_PASSWORD]
    probes = { "proton-mail": () => Promise.resolve("handshake_failed") }
    const status = await connect(["proton-mail"], env(), io(), { vault })
    expect(status).toBe(1)
    expect(out.at(-1)).toBe("proton-mail: degraded (handshake_failed)")
  })

  it("says the password is stored when the gate cannot check the connector", async () => {
    answers = [BRIDGE_PASSWORD]
    const status = await connect(["proton-calendar"], env(), io(), { vault })
    expect(status).toBe(1)
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(BRIDGE_PASSWORD)
    expect(err).toHaveLength(1)
    expect(err[0]).toMatch(
      /^The credential is stored, but the gate could not check proton-calendar: /
    )
  })

  it("says the password is stored when the gate drops the check", async () => {
    answers = [BRIDGE_PASSWORD]
    probes = {
      "proton-mail": () => {
        server.closeAllConnections()
        return Promise.resolve("ok")
      },
    }
    const status = await connect(["proton-mail"], env(), io(), { vault })
    expect(status).toBe(1)
    expect(await vault.get(BRIDGE_PASSWORD_KEY)).toBe(BRIDGE_PASSWORD)
    expect(err).toEqual([
      "The credential is stored, but the gate did not answer the check of proton-mail.",
    ])
  })

  it("writes the vault the environment selects, as the gate does", async () => {
    const file = join(dir, "vault.json")
    answers = [BRIDGE_PASSWORD]
    probes = { "proton-mail": () => Promise.resolve("ok") }
    const status = await connect(
      ["proton-mail"],
      env({ EIDO_DEV_VAULT: "1", EIDO_GATE_VAULT_FILE: file }),
      io()
    )
    expect(status).toBe(0)
    expect(
      await new FileVault({ path: file, devFlag: true }).get(
        BRIDGE_PASSWORD_KEY
      )
    ).toBe(BRIDGE_PASSWORD)
  })
})

describe("connect refusals", () => {
  it.each([[[]], [["dropbox"]], [["gmail", "extra"]]])(
    "prints usage for %j",
    async (args) => {
      expect(await connect(args, env(), io(), { vault })).toBe(2)
      expect(err).toEqual([
        "usage: pnpm --filter @eido/gate connect <gmail|gmail-read|drive|proton-mail|proton-calendar>",
      ])
    }
  )

  it("needs the control socket", async () => {
    expect(await connect(["proton-mail"], {}, io(), { vault })).toBe(2)
    expect(err).toEqual(["EIDO_GATE_CONTROL_SOCKET is not set"])
  })

  it("needs a vault configuration", async () => {
    expect(await connect(["proton-mail"], env(), io())).toBe(2)
    expect(err).toEqual([
      "connect needs EIDO_GATE_KEYCHAIN_PATH, or EIDO_DEV_VAULT=1 with EIDO_GATE_VAULT_FILE, as the gate has",
    ])
  })

  it("reports a vault configuration the gate would refuse", async () => {
    expect(
      await connect(
        ["proton-mail"],
        env({ EIDO_GATE_VAULT_FILE: join(dir, "vault.json") }),
        io()
      )
    ).toBe(2)
    expect(err).toEqual(["EIDO_GATE_VAULT_FILE requires EIDO_DEV_VAULT=1"])
  })

  it("asks for nothing when the gate is not running", async () => {
    await close(server)
    answers = [BRIDGE_PASSWORD]
    expect(await connect(["proton-mail"], env(), io(), { vault })).toBe(1)
    expect(questions).toEqual([])
    expect(err).toEqual([
      `The gate is not reachable at ${socket}. Start it first.`,
    ])
  })

  it("asks for nothing when the gate cannot read connector health", async () => {
    s.db.exec("DROP TABLE connectors")
    answers = [BRIDGE_PASSWORD]
    expect(await connect(["proton-mail"], env(), io(), { vault })).toBe(1)
    expect(questions).toEqual([])
    expect(err).toHaveLength(1)
    expect(err[0]).toMatch(/^The gate could not read connector health: /)
  })

  it("asks for nothing when the connector is not pinned", async () => {
    s.db.prepare("DELETE FROM connectors WHERE name = 'gmail'").run()
    expect(await connect(["gmail"], env(), io(), { vault })).toBe(1)
    expect(questions).toEqual([])
    expect(err).toEqual([
      "gmail is not pinned in the gate. Pin its reviewed manifest first.",
    ])
  })
})

describe("openInBrowser", () => {
  it("runs open with the URL as one argument on a Mac", () => {
    const run = vi.fn()
    openInBrowser(
      "https://accounts.google.com/o/oauth2/v2/auth?a=1",
      "darwin",
      run
    )
    expect(run).toHaveBeenCalledWith(
      "open",
      ["https://accounts.google.com/o/oauth2/v2/auth?a=1"],
      expect.any(Function)
    )
  })

  it("leaves the printed URL as the way in elsewhere", () => {
    const run = vi.fn()
    openInBrowser("https://accounts.google.com/", "linux", run)
    expect(run).not.toHaveBeenCalled()
  })
})
