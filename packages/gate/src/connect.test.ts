import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { request } from "node:http"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connect, GMAIL_CLIENT_ID_ENV, openInBrowser } from "./connect"
import type { ConnectIo } from "./connect"
import { CONTROL_SOCKET_ENV } from "./enrol-code"
import { BRIDGE_PASSWORD_KEY } from "./internal/bridge/bridge"
import type { ConnectorProbe } from "./internal/connector-connect"
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

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify"
const CLIENT_ID = "test-client.apps.example.invalid"
const CLIENT_SECRET = "test-client-secret-7f3a"
const REFRESH_TOKEN = "test-refresh-token-91c2"
const AUTH_CODE = "test-auth-code-55d0"
const BRIDGE_PASSWORD = "test-bridge-password-0b8e"

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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "eido-connect-"))
  socket = socketAddress(dir, "control.sock")
  s = setup([
    manifest("gmail", MAIL_OPS),
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
  it.each([[[]], [["drive"]], [["gmail", "extra"]]])(
    "prints usage for %j",
    async (args) => {
      expect(await connect(args, env(), io(), { vault })).toBe(2)
      expect(err).toEqual([
        "usage: pnpm --filter @eido/gate connect <gmail|proton-mail|proton-calendar>",
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
