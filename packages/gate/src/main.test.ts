import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  BRIDGE_PASSWORD_KEY,
  MAX_MESSAGE_BYTES,
} from "./internal/bridge/bridge"
import { PROTON_CONNECTOR } from "./internal/bridge/config"
import { rawMessage, startFakeBridge } from "./internal/bridge/fake-bridge"
import { createTestCertificate } from "./internal/bridge/test-certificate"
import type { FakeBridge } from "./internal/bridge/fake-bridge"
import {
  GateRequestError,
  createIntentClient,
  createProtonMailClient,
} from "./internal/client"
import { runningGate } from "./internal/runtime"
import {
  MAIL_OPS,
  assertion,
  deviceChallenge,
  loggedText,
  manifest,
  sample,
  signedPin,
  socketAddress,
  testAuthenticator,
  WEBAUTHN,
} from "./internal/test-fixtures"
import { reloadPolicy } from "./internal/runtime"
import { validateGatePrepareApproval } from "@eido/schemas"
import { FileVault } from "./internal/vault/file-vault"
import { vapidPublicKey } from "./internal/push-crypto"
import {
  CONTROL_DB_FILE,
  GATE_LOG_FILE,
  gateConfig,
  runGate as startGate,
} from "./main"
import type { GateConfig, RunningGate } from "./main"

let dir: string
const openGates = new Set<RunningGate>()
const startingGates = new Set<Promise<RunningGate>>()

async function runGate(config: GateConfig): Promise<RunningGate> {
  const started = startGate(config).then((gate) => {
    let closing: Promise<void> | undefined
    const tracked: RunningGate = {
      ...gate,
      close: () => {
        closing ??= gate.close().finally(() => {
          openGates.delete(tracked)
        })
        return closing
      },
    }
    openGates.add(tracked)
    return tracked
  })
  startingGates.add(started)
  try {
    return await started
  } finally {
    startingGates.delete(started)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-main-"))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.allSettled([...startingGates])
  try {
    await Promise.all([...openGates].map((gate) => gate.close()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function config(): GateConfig {
  return {
    dataDir: join(dir, "gate"),
    socketPath: socketAddress(dir, "gate.sock"),
    controlSocketPath: socketAddress(dir, "control.sock"),
    webAuthn: WEBAUTHN,
  }
}

type Answer = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body)
    const req = request(
      { host: "127.0.0.1", port, method, path, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8")
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw === "" ? undefined : JSON.parse(raw),
          })
        })
      }
    )
    req.on("error", reject)
    req.end(text)
  })
}

describe("gateConfig", () => {
  it("reads the sockets, data dir and relying party from the environment", () => {
    expect(
      gateConfig({
        EIDO_GATE_DATA_DIR: "/d",
        EIDO_GATE_SOCKET: "/d/gate.sock",
        EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
        EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
        EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
      })
    ).toEqual({
      dataDir: "/d",
      socketPath: "/d/gate.sock",
      controlSocketPath: "/d/control.sock",
      webAuthn: WEBAUTHN,
    })
  })

  const BASE = {
    EIDO_GATE_DATA_DIR: "/d",
    EIDO_GATE_SOCKET: "/d/gate.sock",
    EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
  }

  it("reads the phone listener when its port is set", () => {
    expect(
      gateConfig({
        ...BASE,
        EIDO_GATE_PHONE_PORT: "8443",
        EIDO_GATE_PHONE_HOST: "::1",
        EIDO_GATE_PHONE_BASE_PATH: "/api/gate",
        EIDO_GATE_PHONE_ALLOWED_HOSTS:
          " mac.example.invalid , ,other.example.invalid",
      }).phone
    ).toEqual({
      host: "::1",
      port: 8443,
      basePath: "/api/gate",
      allowedHosts: ["mac.example.invalid", "other.example.invalid"],
    })
  })

  it("defaults the phone listener to 127.0.0.1, no base path and no extra hosts", () => {
    expect(gateConfig({ ...BASE, EIDO_GATE_PHONE_PORT: "0" }).phone).toEqual({
      host: "127.0.0.1",
      port: 0,
      basePath: "",
      allowedHosts: [],
    })
  })

  it.each(["0.0.0.0", "192.168.1.10", "localhost", "::"])(
    "refuses to bind the phone listener to %s",
    (host) => {
      expect(() =>
        gateConfig({
          ...BASE,
          EIDO_GATE_PHONE_PORT: "0",
          EIDO_GATE_PHONE_HOST: host,
        })
      ).toThrow("the phone listener binds to 127.0.0.1 or ::1 only")
    }
  )

  it.each(["http", "-1", "65536", "80.5"])(
    "refuses the phone port %j",
    (port) => {
      expect(() => gateConfig({ ...BASE, EIDO_GATE_PHONE_PORT: port })).toThrow(
        "EIDO_GATE_PHONE_PORT must be a port number"
      )
    }
  )

  it("refuses a base path with a trailing slash", () => {
    expect(() =>
      gateConfig({
        ...BASE,
        EIDO_GATE_PHONE_PORT: "0",
        EIDO_GATE_PHONE_BASE_PATH: "/api/gate/",
      })
    ).toThrow("the base path must look like /api/gate")
  })

  it("names every missing or empty variable", () => {
    expect(() =>
      gateConfig({ EIDO_GATE_DATA_DIR: "/d", EIDO_GATE_SOCKET: "" })
    ).toThrow(
      "the gate needs EIDO_GATE_SOCKET, EIDO_GATE_CONTROL_SOCKET, EIDO_WEBAUTHN_RP_ID, EIDO_WEBAUTHN_ORIGIN"
    )
  })
})

describe("Web Push configuration", () => {
  const BASE = {
    EIDO_GATE_DATA_DIR: "/d",
    EIDO_GATE_SOCKET: "/d/gate.sock",
    EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
  }

  it("requires a vault and validates configured windows", () => {
    expect(() =>
      gateConfig({
        ...BASE,
        EIDO_PUSH_VAPID_SUBJECT: "mailto:ops@example.invalid",
      })
    ).toThrow("Web Push needs EIDO_GATE_VAULT_FILE")
    expect(() =>
      gateConfig({
        ...BASE,
        EIDO_PUSH_VAPID_SUBJECT: "mailto:ops@example.invalid",
        EIDO_GATE_VAULT_FILE: "/tmp/vault",
        EIDO_PUSH_WINDOW_MS: "0",
      })
    ).toThrow("EIDO_PUSH_WINDOW_MS")
    expect(
      gateConfig({
        ...BASE,
        EIDO_PUSH_VAPID_SUBJECT: "mailto:ops@example.invalid",
        EIDO_GATE_VAULT_FILE: "/tmp/vault",
        EIDO_DEV_VAULT: "1",
        EIDO_PUSH_WINDOW_MS: "30000",
        EIDO_APPROVAL_NUDGE_THRESHOLD: "3",
        EIDO_APPROVAL_NUDGE_WINDOW_MS: "90000",
      }).push
    ).toEqual({
      vaultPath: "/tmp/vault",
      devVault: true,
      subject: "mailto:ops@example.invalid",
      windowMs: 30000,
      nudgeThreshold: 3,
      nudgeWindowMs: 90000,
    })
  })

  it("creates and reuses its VAPID secret inside the gate vault", async () => {
    const vaultPath = join(dir, "vapid-vault.json")
    const c: GateConfig = {
      ...config(),
      push: {
        vaultPath,
        devVault: true,
        subject: "mailto:ops@example.invalid",
        windowMs: 60_000,
        nudgeThreshold: 5,
        nudgeWindowMs: 120_000,
      },
    }
    const key = {
      connector: "eido-web-push",
      kind: "api_key",
      client: "write",
    } as const
    const gate = await runGate(c)
    const vault = new FileVault({ path: vaultPath, devFlag: true })
    const first = await vault.get(key)
    expect(typeof first).toBe("string")
    expect(vapidPublicKey(first ?? "")).toMatch(/^[A-Za-z0-9_-]+$/)
    await gate.close()
    const again = await runGate(c)
    expect(await vault.get(key)).toBe(first)
    await again.close()
  })

  it("refuses an invalid VAPID subject before the phone listener starts", async () => {
    const c: GateConfig = {
      ...config(),
      push: {
        vaultPath: join(dir, "bad-vapid-vault.json"),
        devVault: true,
        subject: "invalid-subject",
        windowMs: 60_000,
        nudgeThreshold: 5,
        nudgeWindowMs: 120_000,
      },
    }
    await expect(runGate(c)).rejects.toThrow("Invalid VAPID subject")
  })
})

describe("runGate", () => {
  it("opens the control DB, serves both sockets, logs to its own file and stops cleanly", async () => {
    const c = config()
    const gate = await runGate(c)
    expect(existsSync(join(c.dataDir, CONTROL_DB_FILE))).toBe(true)
    if (process.platform !== "win32") {
      expect(statSync(c.socketPath).mode & 0o777).toBe(0o660)
      expect(statSync(c.controlSocketPath).mode & 0o777).toBe(0o600)
    }
    expect(
      await createIntentClient({ socketPath: c.socketPath }).listPending()
    ).toEqual([])
    await gate.close()
    expect(() => runningGate()).toThrow("the gate is not started")
    const events = readFileSync(join(c.dataDir, GATE_LOG_FILE), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        return typeof parsed === "object" &&
          parsed !== null &&
          "event" in parsed
          ? parsed.event
          : undefined
      })
    expect(events).toEqual(["started", "request", "stopped"])
  })

  it("stops the gate again when a socket cannot be opened", async () => {
    const c = { ...config(), controlSocketPath: join(dir, "missing", "c.sock") }
    await expect(runGate(c)).rejects.toThrow()
    expect(() => runningGate()).toThrow("the gate is not started")
    const again = await runGate(config())
    await again.close()
  })

  it("serves the phone listener on loopback TCP, by Host, below its base path", async () => {
    const c: GateConfig = {
      ...config(),
      phone: {
        host: "127.0.0.1",
        port: 0,
        basePath: "/api/gate",
        allowedHosts: ["mac.example.invalid"],
      },
    }
    const gate = await runGate(c)
    try {
      const phone = gate.phone
      if (phone === undefined)
        throw new Error("the phone listener did not start")
      const listen = `127.0.0.1:${String(phone.port)}`
      expect(phone.allowedHosts).toEqual([listen, "mac.example.invalid"])
      const auth = testAuthenticator()
      runningGate()
        .db.prepare(
          "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
        )
        .run(auth.credentialId, auth.publicKey, new Date().toISOString())
      const json = {
        host: "mac.example.invalid",
        "content-type": "application/json",
      }

      const misdirected = await send(
        phone.port,
        "GET",
        "/api/gate/passkey/status",
        {
          host: "evil.example.invalid",
        }
      )
      expect(misdirected.status).toBe(421)
      const audit = await send(phone.port, "GET", "/api/gate/audit/chain", json)
      expect(audit.status).toBe(401)
      const gated = await send(phone.port, "GET", "/api/gate/approvals", json)
      expect(gated.status).toBe(401)

      const options = await send(
        phone.port,
        "POST",
        "/api/gate/auth/login/options",
        json
      )
      const challenge =
        typeof options.body === "object" &&
        options.body !== null &&
        "challenge" in options.body
          ? String(options.body.challenge)
          : ""
      const login = await send(
        phone.port,
        "POST",
        "/api/gate/auth/login",
        json,
        {
          assertion: assertion(auth, challenge),
        }
      )
      expect(login.status).toBe(200)
      const setCookie = login.headers["set-cookie"]?.[0] ?? ""
      expect(setCookie).toContain(
        "; Path=/api/gate; HttpOnly; Secure; SameSite=Strict"
      )
      expect(login.headers["cache-control"]).toBe("no-store")

      const listed = await send(phone.port, "GET", "/api/gate/approvals", {
        host: listen,
        cookie: setCookie.split(";")[0] ?? "",
      })
      expect(listed).toMatchObject({ status: 200, body: { intents: [] } })
    } finally {
      await gate.close()
    }
  })

  it("has no TCP listener when the phone port is not set", async () => {
    const gate = await runGate(config())
    expect(gate.phone).toBeUndefined()
  })
})

describe("gateConfig with Bridge", () => {
  const BASE = {
    EIDO_GATE_DATA_DIR: "/d",
    EIDO_GATE_SOCKET: "/d/gate.sock",
    EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
    EIDO_BRIDGE_HOST: "127.0.0.1",
    EIDO_BRIDGE_IMAP_PORT: "1143",
    EIDO_BRIDGE_SMTP_PORT: "1025",
    EIDO_BRIDGE_USERNAME: "assistant@example.invalid",
    EIDO_BRIDGE_CERT_PATH: "",
    EIDO_BRIDGE_CERT_SHA256: "",
  }
  let certificate: ReturnType<typeof createTestCertificate>
  beforeAll(() => {
    certificate = createTestCertificate()
    BASE.EIDO_BRIDGE_CERT_PATH = certificate.certPath
    BASE.EIDO_BRIDGE_CERT_SHA256 = certificate.sha256
  })
  afterAll(() => certificate.cleanup())

  it("reads Bridge and its development vault, with no password in the config", () => {
    const config = gateConfig({
      ...BASE,
      EIDO_GATE_VAULT_FILE: "/vault/dev.json",
      EIDO_DEV_VAULT: "1",
    })
    expect(config.bridge).toEqual({
      config: {
        host: "127.0.0.1",
        imapPort: 1143,
        smtpPort: 1025,
        tls: "starttls",
        certificatePem: certificate.cert,
        certificateSha256: certificate.sha256,
        username: "assistant@example.invalid",
        searchFolders: ["INBOX"],
      },
      vaultPath: "/vault/dev.json",
      devVault: true,
    })
  })

  it("leaves the development flag off unless it is exactly 1", () => {
    const config = gateConfig({
      ...BASE,
      EIDO_GATE_VAULT_FILE: "/v.json",
      EIDO_DEV_VAULT: "true",
    })
    expect(config.bridge?.devVault).toBe(false)
  })

  it("refuses Bridge without a vault file", () => {
    expect(() => gateConfig(BASE)).toThrow("Bridge needs EIDO_GATE_VAULT_FILE")
  })

  it("has no Bridge when its host is not set", () => {
    expect(gateConfig({ ...BASE, EIDO_BRIDGE_HOST: "" }).bridge).toBeUndefined()
  })
})

describe("gateConfig with Gmail", () => {
  const BASE = {
    EIDO_GATE_DATA_DIR: "/d",
    EIDO_GATE_SOCKET: "/d/gate.sock",
    EIDO_GATE_CONTROL_SOCKET: "/d/control.sock",
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
  }

  it("enables the Gmail transport with a public client ID and vault path", () => {
    expect(
      gateConfig({
        ...BASE,
        EIDO_GMAIL_CLIENT_ID: "test-client-id",
        EIDO_GATE_VAULT_FILE: "/vault/dev.json",
        EIDO_DEV_VAULT: "1",
      }).gmail
    ).toEqual({
      clientId: "test-client-id",
      vaultPath: "/vault/dev.json",
      devVault: true,
    })
  })

  it("requires a vault file when Gmail is enabled", () => {
    expect(() =>
      gateConfig({ ...BASE, EIDO_GMAIL_CLIENT_ID: "test-client-id" })
    ).toThrow("Gmail needs EIDO_GATE_VAULT_FILE")
  })
})

describe("runGate with Gmail", () => {
  it("routes an auto mark read through the pinned Gmail connector and stores its inverse", async () => {
    const c = {
      ...config(),
      gmail: {
        vaultPath: join(dir, "vault", "dev.json"),
        devVault: true,
        clientId: "test-client-id",
      },
    }
    await new FileVault({ path: c.gmail.vaultPath, devFlag: true }).set(
      { connector: "gmail", kind: "access_token", client: "write" },
      "test-access-token"
    )
    const calls: string[] = []
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer test-access-token"
      )
      calls.push(`${init.method} ${input}`)
      return Promise.resolve(
        init.method === "GET"
          ? Response.json({ labelIds: ["INBOX", "UNREAD"] })
          : new Response(null, { status: 204 })
      )
    })
    const gate = await runGate(c)
    try {
      const gmail = manifest("gmail", [MAIL_OPS[3]!])
      gmail.egress.hosts = [
        {
          host: "gmail.googleapis.com",
          methods: ["GET", "POST"],
          pathPrefixes: ["/gmail/v1/users/me"],
        },
      ]
      gmail.operations[0]!.routes = [
        {
          host: "gmail.googleapis.com",
          method: "POST",
          pathPattern: "/gmail/v1/users/me/messages/batchModify",
        },
      ]
      gmail.operations.push({
        name: "get_message",
        effect: "read",
        reversibility: "reversible",
        defaultTier: "auto",
        sensitivity: "normal",
        untrustedOutput: true,
        authScopes: ["write"],
        routes: [
          {
            host: "gmail.googleapis.com",
            method: "GET",
            pathPattern: "/gmail/v1/users/me/messages/{id}",
          },
        ],
      })
      signedPin(runningGate().db, gmail)
      reloadPolicy()
      const proposal = await createIntentClient({
        socketPath: c.socketPath,
      }).propose({
        intent: sample("email.markRead"),
        origin: "reactive",
      })
      expect(proposal).toMatchObject({ tier: "auto", state: "executed" })
      expect(calls).toEqual([
        "GET https://gmail.googleapis.com/gmail/v1/users/me/messages/msg-1?format=minimal",
        "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
      ])
      expect(
        runningGate()
          .db.prepare("SELECT inverse_op FROM executions WHERE intent_id=?")
          .get(proposal.id)?.["inverse_op"]
      ).toBe(
        '{"args":{"messageIds":["msg-1"],"read":false},"connector":"gmail","kind":"email.markRead"}'
      )
    } finally {
      await gate.close()
    }
  })
})

describe("runGate with Bridge", () => {
  const USER = "assistant@example.invalid"
  const BRIDGE_SECRET = "synthetic-bridge-secret-5d20"
  const message = rawMessage({
    messageId: "<one@example.invalid>",
    subject: "One",
    body: "lorem ipsum",
  })
  let fake: FakeBridge | undefined
  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  function pinProton(): void {
    const operations = MAIL_OPS.filter((op) =>
      [
        "email.draft",
        "email.send",
        "email.reply",
        "email.forward",
        "email.trash",
      ].includes(op.intentKind ?? "")
    )
    signedPin(runningGate().db, {
      ...manifest(PROTON_CONNECTOR, operations),
      auth: { type: "password", scopes: ["write"] },
      egress: { hosts: [] },
    })
    reloadPolicy()
  }

  async function bridged(
    vaultEntry: string,
    devVault = true,
    oversize = false
  ): Promise<GateConfig> {
    fake = await startFakeBridge({
      username: USER,
      password: BRIDGE_SECRET,
      mailboxes: {
        INBOX: {
          uidValidity: 1700000001,
          uidNext: oversize ? 6 : 5,
          messages: [
            { uid: 4, raw: message, flags: [] },
            ...(oversize
              ? [
                  {
                    uid: 5,
                    raw: Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61),
                    flags: [],
                  },
                ]
              : []),
          ],
        },
        Drafts: { uidValidity: 1700000002, uidNext: 1, messages: [] },
        Trash: { uidValidity: 1700000003, uidNext: 1, messages: [] },
      },
    })
    const vaultPath = join(dir, "vault", "dev.json")
    await new FileVault({ path: vaultPath, devFlag: true }).set(
      BRIDGE_PASSWORD_KEY,
      vaultEntry
    )
    return {
      ...config(),
      bridge: {
        config: {
          host: "127.0.0.1",
          imapPort: fake.imapPort,
          smtpPort: fake.smtpPort,
          tls: "none",
          username: USER,
          searchFolders: ["INBOX"],
        },
        vaultPath,
        devVault,
      },
    }
  }

  it("serves the mail reads to core over the data-plane socket", async () => {
    const c = await bridged(BRIDGE_SECRET)
    const gate = await runGate(c)
    try {
      pinProton()
      const mail = createProtonMailClient({ socketPath: c.socketPath })
      expect((await mail.listFolders()).sort()).toEqual([
        "Drafts",
        "INBOX",
        "Trash",
      ])
      expect(await mail.folderState("INBOX")).toEqual({
        uidValidity: "1700000001",
        uidNext: 5,
      })
      const page = await mail.fetchRaw("INBOX", 1, 10)
      expect(page.messages.map((entry) => entry.uid)).toEqual([4])
      expect(page.skipped).toEqual([])
      expect(Buffer.from(page.messages[0]?.raw ?? []).equals(message)).toBe(
        true
      )
      await expect(mail.folderState("Nope")).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      })
    } finally {
      await gate.close()
    }
  })

  it("closes a due Proton breaker only after the gate observes a successful Bridge read", async () => {
    const c = await bridged(BRIDGE_SECRET)
    const gate = await runGate(c)
    try {
      pinProton()
      runningGate()
        .db.prepare(
          `UPDATE connectors SET health = 'open', consecutive_failures = 3,
           next_attempt_at = ?, last_error = 'handshake_failed' WHERE name = ?`
        )
        .run(new Date(Date.now() - 1).toISOString(), PROTON_CONNECTOR)

      const mail = createProtonMailClient({ socketPath: c.socketPath })
      expect(await mail.listFolders()).toContain("INBOX")
      expect(
        runningGate()
          .db.prepare(
            "SELECT health, consecutive_failures, next_attempt_at FROM connectors WHERE name = ?"
          )
          .get(PROTON_CONNECTOR)
      ).toMatchObject({
        health: "healthy",
        consecutive_failures: 0,
        next_attempt_at: null,
      })
      expect(
        fake?.imapCommands.filter((command) => command.startsWith("LOGIN"))
      ).toHaveLength(1)
    } finally {
      await gate.close()
    }
  })

  it("reopens a failed Proton probe and does not retry before its next attempt", async () => {
    const c = await bridged(BRIDGE_SECRET)
    const gate = await runGate(c)
    try {
      pinProton()
      runningGate()
        .db.prepare(
          `UPDATE connectors SET health = 'open', consecutive_failures = 3,
           next_attempt_at = ?, last_error = 'handshake_failed' WHERE name = ?`
        )
        .run(new Date(Date.now() - 1).toISOString(), PROTON_CONNECTOR)
      await fake?.close()
      fake = undefined

      const mail = createProtonMailClient({ socketPath: c.socketPath })
      await expect(mail.listFolders()).rejects.toMatchObject({
        code: "handshake_failed",
      })
      const health = runningGate()
        .db.prepare(
          "SELECT health, consecutive_failures, last_error, next_attempt_at FROM connectors WHERE name = ?"
        )
        .get(PROTON_CONNECTOR)
      expect(health).toMatchObject({
        health: "open",
        consecutive_failures: 4,
        last_error: "handshake_failed",
      })
      expect(Date.parse(String(health?.["next_attempt_at"]))).toBeGreaterThan(
        Date.now()
      )
      await expect(mail.listFolders()).rejects.toMatchObject({
        status: 503,
        code: "unavailable",
      })
    } finally {
      await gate.close()
    }
  })

  it("isolates three real Bridge handshake failures and recovers on one due read", async () => {
    const c = await bridged(BRIDGE_SECRET)
    const gate = await runGate(c)
    try {
      pinProton()
      signedPin(runningGate().db, manifest("gmail", MAIL_OPS))
      const imapPort = fake?.imapPort
      const smtpPort = fake?.smtpPort
      if (imapPort === undefined || smtpPort === undefined)
        throw new Error("fake Bridge did not start")
      await fake?.close()
      fake = undefined

      const mail = createProtonMailClient({ socketPath: c.socketPath })
      for (const attempt of [1, 2, 3]) {
        await expect(mail.listFolders()).rejects.toMatchObject({
          code: "handshake_failed",
        })
        if (attempt < 3) {
          runningGate()
            .db.prepare(
              "UPDATE connectors SET next_attempt_at = ? WHERE name = ?"
            )
            .run(new Date(0).toISOString(), PROTON_CONNECTOR)
        }
      }
      expect(
        runningGate()
          .db.prepare(
            "SELECT health, consecutive_failures FROM connectors WHERE name = ?"
          )
          .get(PROTON_CONNECTOR)
      ).toMatchObject({ health: "open", consecutive_failures: 3 })
      expect(
        runningGate()
          .db.prepare(
            "SELECT health, consecutive_failures FROM connectors WHERE name = 'gmail'"
          )
          .get()
      ).toMatchObject({ health: "healthy", consecutive_failures: 0 })

      fake = await startFakeBridge({
        host: "127.0.0.1",
        imapPort,
        smtpPort,
        username: USER,
        password: BRIDGE_SECRET,
      })
      runningGate()
        .db.prepare("UPDATE connectors SET next_attempt_at = ? WHERE name = ?")
        .run(new Date(0).toISOString(), PROTON_CONNECTOR)
      expect(await mail.listFolders()).toContain("INBOX")
      expect(
        runningGate()
          .db.prepare(
            "SELECT health, consecutive_failures, next_attempt_at FROM connectors WHERE name = ?"
          )
          .get(PROTON_CONNECTOR)
      ).toMatchObject({
        health: "healthy",
        consecutive_failures: 0,
        next_attempt_at: null,
      })
    } finally {
      await gate.close()
    }
  })

  it("passes an oversized UID through the client without returning its bytes", async () => {
    const c = await bridged(BRIDGE_SECRET, true, true)
    const gate = await runGate(c)
    try {
      pinProton()
      const mail = createProtonMailClient({ socketPath: c.socketPath })
      const page = await mail.fetchRaw("INBOX", 1, 10)
      expect(page.messages.map((entry) => entry.uid)).toEqual([4])
      expect(page.skipped).toEqual([5])
    } finally {
      await gate.close()
    }
  })

  it("executes an auto-tier draft through the running gate", async () => {
    const c = await bridged(BRIDGE_SECRET)
    const gate = await runGate(c)
    try {
      pinProton()
      const client = createIntentClient({ socketPath: c.socketPath })
      const proposal = await client.propose({
        intent: sample("email.draft", {
          to: ["guest@example.invalid"],
          subject: "Agenda",
          body: "Synthetic agenda",
        }),
        origin: "reactive",
      })
      expect(proposal).toMatchObject({ tier: "auto", state: "executed" })
      expect(fake?.mailboxes.get("Drafts")?.messages).toHaveLength(1)
      expect(fake?.sent).toEqual([])
      expect(await client.history(proposal.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actor: "executor", to: "executed" }),
        ])
      )
    } finally {
      await gate.close()
    }
  })

  it("sends a signed approval through the running gate and records execute", async () => {
    const c = await bridged(BRIDGE_SECRET)
    c.phone = {
      host: "127.0.0.1",
      port: 0,
      basePath: "",
      allowedHosts: [],
    }
    const gate = await runGate(c)
    try {
      pinProton()
      const phone = gate.phone
      if (phone === undefined) throw new Error("phone listener did not start")
      const host = `127.0.0.1:${String(phone.port)}`
      const headers = { host, "content-type": "application/json" }
      const auth = testAuthenticator()
      runningGate()
        .db.prepare(
          "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
        )
        .run(auth.credentialId, auth.publicKey, new Date().toISOString())
      const loginOptions = await send(
        phone.port,
        "POST",
        "/auth/login/options",
        headers
      )
      const challenge =
        typeof loginOptions.body === "object" &&
        loginOptions.body !== null &&
        "challenge" in loginOptions.body
          ? String(loginOptions.body.challenge)
          : ""
      const login = await send(phone.port, "POST", "/auth/login", headers, {
        assertion: assertion(auth, challenge),
      })
      expect(login.status).toBe(200)
      const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0] ?? ""
      const client = createIntentClient({ socketPath: c.socketPath })
      const proposal = await client.propose({
        intent: sample("email.send", {
          to: ["guest@example.invalid"],
          subject: "Agenda",
          body: "Synthetic agenda",
        }),
        origin: "reactive",
      })
      expect(proposal).toMatchObject({ tier: "approval", state: "pending" })
      const prepared = await send(
        phone.port,
        "POST",
        `/approvals/${proposal.id}/nonce`,
        { ...headers, cookie }
      )
      const checked = validateGatePrepareApproval(prepared.body)
      if (!checked.ok) throw new Error(checked.errors.join("; "))
      const decision = await send(
        phone.port,
        "POST",
        `/approvals/${proposal.id}/decision`,
        { ...headers, cookie },
        {
          intentId: proposal.id,
          decision: "approved",
          nonce: checked.value.nonce,
          assertion: assertion(
            auth,
            deviceChallenge(
              checked.value.payloadHash,
              proposal.id,
              checked.value.nonce
            )
          ),
        }
      )
      expect(decision.status).toBe(200)
      expect(fake?.sent).toEqual([
        expect.objectContaining({
          from: USER,
          to: ["guest@example.invalid"],
        }),
      ])
      expect(await client.status(proposal.id)).toMatchObject({
        state: "executed",
      })
      expect(
        runningGate()
          .db.prepare(
            "SELECT action FROM audit_log WHERE target=? ORDER BY seq"
          )
          .all(proposal.id)
          .map((row) => row["action"])
      ).toContain("execute")
    } finally {
      await gate.close()
    }
  })

  it("records a failed Proton write when Bridge is not configured", async () => {
    const c = config()
    const gate = await runGate(c)
    try {
      pinProton()
      const client = createIntentClient({ socketPath: c.socketPath })
      const proposal = await client.propose({
        intent: sample("email.draft"),
        origin: "reactive",
      })
      expect(proposal).toMatchObject({ tier: "auto", state: "failed" })
      expect(await client.status(proposal.id)).toMatchObject({
        state: "failed",
      })
      expect(
        runningGate()
          .db.prepare(
            "SELECT action FROM audit_log WHERE target=? ORDER BY seq"
          )
          .all(proposal.id)
          .map((row) => row["action"])
      ).toContain("execute.failed.upstream_error")
    } finally {
      await gate.close()
    }
  })

  it("raises auth_failed to core and keeps the password out of the log and audit", async () => {
    const wrong = "synthetic-wrong-secret-77b1"
    const c = await bridged(wrong)
    const gate = await runGate(c)
    let caught: unknown
    try {
      pinProton()
      const mail = createProtonMailClient({ socketPath: c.socketPath })
      caught = await mail.listFolders().catch((error: unknown) => error)
      expect(caught).toBeInstanceOf(GateRequestError)
      expect(caught).toMatchObject({ status: 502, code: "auth_failed" })
      await expect(mail.listFolders()).rejects.toMatchObject({
        status: 503,
        code: "unavailable",
      })
      expect(
        fake?.imapCommands.filter((command) => command.startsWith("LOGIN"))
      ).toHaveLength(1)
      expect(
        runningGate()
          .db.prepare("SELECT enabled FROM connectors WHERE name = ?")
          .get(PROTON_CONNECTOR)?.["enabled"]
      ).toBe(0)
      expect(loggedText(runningGate().db)).not.toContain(wrong)
    } finally {
      await gate.close()
    }
    const logged = readFileSync(join(c.dataDir, GATE_LOG_FILE), "utf8")
    expect(logged).toContain('"mail":"bridge"')
    expect(logged).not.toContain(wrong)
    expect(JSON.stringify(caught)).not.toContain(wrong)
    expect(caught instanceof Error ? caught.message : "").not.toContain(wrong)
  })

  it("does not start when the development vault flag is off", async () => {
    const c = await bridged(BRIDGE_SECRET, false)
    await expect(runGate(c)).rejects.toThrow(
      "FileVault is for development only"
    )
    expect(() => runningGate()).toThrow("the gate is not started")
  })
})
