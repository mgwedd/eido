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
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BRIDGE_PASSWORD_KEY } from "./internal/bridge/bridge"
import { rawMessage, startFakeBridge } from "./internal/bridge/fake-bridge"
import type { FakeBridge } from "./internal/bridge/fake-bridge"
import {
  GateRequestError,
  createIntentClient,
  createProtonMailClient,
} from "./internal/client"
import { runningGate } from "./internal/runtime"
import {
  assertion,
  loggedText,
  testAuthenticator,
  WEBAUTHN,
} from "./internal/test-fixtures"
import { FileVault } from "./internal/vault/file-vault"
import { CONTROL_DB_FILE, GATE_LOG_FILE, gateConfig, runGate } from "./main"
import type { GateConfig } from "./main"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-main-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function config(): GateConfig {
  return {
    dataDir: join(dir, "gate"),
    socketPath: join(dir, "gate.sock"),
    controlSocketPath: join(dir, "control.sock"),
    webAuthn: WEBAUTHN,
  }
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
      const admin = await send(phone.port, "GET", "/api/gate/audit/chain", json)
      expect(admin.status).toBe(404)
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
    await gate.close()
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
  }

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
        allowSelfSigned: false,
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

describe("runGate with Bridge", () => {
  const USER = "assistant@example.invalid"
  const PASSWORD = "synthetic-bridge-password-5d20"
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

  async function bridged(
    vaultPassword: string,
    devVault = true
  ): Promise<GateConfig> {
    fake = await startFakeBridge({
      username: USER,
      password: PASSWORD,
      mailboxes: {
        INBOX: {
          uidValidity: 1700000001,
          uidNext: 5,
          messages: [{ uid: 4, raw: message, flags: [] }],
        },
        Drafts: { uidValidity: 1700000002, uidNext: 1, messages: [] },
        Trash: { uidValidity: 1700000003, uidNext: 1, messages: [] },
      },
    })
    const vaultPath = join(dir, "vault", "dev.json")
    await new FileVault({ path: vaultPath, devFlag: true }).set(
      BRIDGE_PASSWORD_KEY,
      vaultPassword
    )
    return {
      ...config(),
      bridge: {
        config: {
          host: "127.0.0.1",
          imapPort: fake.imapPort,
          smtpPort: fake.smtpPort,
          tls: "none",
          allowSelfSigned: false,
          username: USER,
          searchFolders: ["INBOX"],
        },
        vaultPath,
        devVault,
      },
    }
  }

  it("serves the mail reads to core over the data-plane socket", async () => {
    const c = await bridged(PASSWORD)
    const gate = await runGate(c)
    try {
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
      expect(page.map((entry) => entry.uid)).toEqual([4])
      expect(Buffer.from(page[0]?.raw ?? []).equals(message)).toBe(true)
      await expect(mail.folderState("Nope")).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      })
    } finally {
      await gate.close()
    }
  })

  it("raises auth_failed to core and keeps the password out of the log and audit", async () => {
    const wrong = "synthetic-wrong-password-77b1"
    const c = await bridged(wrong)
    const gate = await runGate(c)
    let caught: unknown
    try {
      const mail = createProtonMailClient({ socketPath: c.socketPath })
      caught = await mail.listFolders().catch((error: unknown) => error)
      expect(caught).toBeInstanceOf(GateRequestError)
      expect(caught).toMatchObject({ status: 502, code: "auth_failed" })
      await expect(mail.listFolders()).rejects.toMatchObject({
        code: "auth_failed",
      })
      expect(
        fake?.imapCommands.filter((command) => command.startsWith("LOGIN"))
      ).toHaveLength(1)
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
    const c = await bridged(PASSWORD, false)
    await expect(runGate(c)).rejects.toThrow(
      "FileVault is for development only"
    )
    expect(() => runningGate()).toThrow("the gate is not started")
  })
})
