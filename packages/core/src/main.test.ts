import { execFile } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http"
import type { ServerResponse } from "node:http"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { GateUnavailableError } from "@eido/gate"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, test } from "vitest"
import type { CoreApi } from "./api/index"
import { ingestBatch } from "./index/ingest"
import { openIndex } from "./index/schema"
import { openDataDb } from "./ledger/db"
import { createProfileStore } from "./profile/store"
import {
  DATA_DB_FILE,
  DATA_PLANE_LOG_FILE,
  SCRUBBED_FLAG,
  coreApiConfig,
  dataPlaneConfig,
  dataPlaneEnv,
  forwardTo,
  holdUntilStopped,
  launchPlan,
  outsideAllowlist,
  runDataPlane,
  serveDataPlane,
} from "./main"

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-core-main-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("the data plane's environment", () => {
  const parent = {
    EIDO_DATA_DIR: "/d",
    EIDO_GATE_SOCKET: "/d/gate.sock",
    EIDO_LLAMA_HOST: "127.0.0.1",
    EIDO_LLAMA_PORT: "",
    GMAIL_REFRESH_TOKEN: "synthetic",
    __CF_USER_TEXT_ENCODING: "0x0:0:0",
    HOME: "/home/someone",
  }

  it("keeps only the allowlisted, non-empty variables", () => {
    expect(dataPlaneEnv(parent)).toEqual({
      EIDO_DATA_DIR: "/d",
      EIDO_GATE_SOCKET: "/d/gate.sock",
      EIDO_LLAMA_HOST: "127.0.0.1",
    })
  })

  it("names the variables outside the allowlist, ignoring what the OS adds", () => {
    expect(outsideAllowlist(parent)).toEqual(["GMAIL_REFRESH_TOKEN", "HOME"])
  })
})

describe("dataPlaneConfig", () => {
  it("puts eido-data.db and the log in the data dir", () => {
    expect(
      dataPlaneConfig({ EIDO_DATA_DIR: "/d", EIDO_GATE_SOCKET: "/s/gate.sock" })
    ).toEqual({
      dataDir: "/d",
      dbPath: join("/d", "eido-data.db"),
      logPath: join("/d", "data-plane.log"),
      gateSocket: "/s/gate.sock",
      api: {
        host: "127.0.0.1",
        port: 8787,
        basePath: "",
        allowedHosts: [],
      },
    })
  })

  it("names every missing or empty variable", () => {
    expect(() => dataPlaneConfig({ EIDO_GATE_SOCKET: "" })).toThrow(
      "the data plane needs EIDO_DATA_DIR, EIDO_GATE_SOCKET"
    )
  })
})

describe("coreApiConfig", () => {
  test("reads the bind address, port, base path and extra hosts", () => {
    expect(
      coreApiConfig({
        EIDO_CORE_HOST: "::1",
        EIDO_CORE_PORT: "0",
        EIDO_CORE_BASE_PATH: "/api/core",
        EIDO_CORE_ALLOWED_HOSTS: " eido.example.invalid , ,127.0.0.1:9000",
      })
    ).toEqual({
      host: "::1",
      port: 0,
      basePath: "/api/core",
      allowedHosts: ["eido.example.invalid", "127.0.0.1:9000"],
    })
  })

  test.each(["0.0.0.0", "192.168.1.20", "localhost", "::"])(
    "refuses to bind %s",
    (host) => {
      expect(() => coreApiConfig({ EIDO_CORE_HOST: host })).toThrow(
        "core's API binds to 127.0.0.1 or ::1 only"
      )
    }
  )

  test.each(["eighty", "-1", "65536", "1.5"])("refuses the port %j", (port) => {
    expect(() => coreApiConfig({ EIDO_CORE_PORT: port })).toThrow(
      "EIDO_CORE_PORT must be a port number"
    )
  })

  test("refuses a malformed base path", () => {
    expect(() => coreApiConfig({ EIDO_CORE_BASE_PATH: "api/core/" })).toThrow(
      "the base path must look like /api/core"
    )
  })
})

describe("runDataPlane", () => {
  it("opens eido-data.db, logs variable names only, and reaches the gate through the client", async () => {
    const env = {
      EIDO_DATA_DIR: join(dir, "data"),
      EIDO_GATE_SOCKET: join(dir, "missing.sock"),
    }
    const plane = runDataPlane(dataPlaneConfig(env), env)
    const tables = plane.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row["name"]))
    expect(tables).toContain("documents")
    expect(tables).toContain("obligations")
    await expect(plane.gate.listPending()).rejects.toBeInstanceOf(
      GateUnavailableError
    )
    await plane.close()
    expect(plane.db.isOpen).toBe(false)

    const lines = readFileSync(
      join(env.EIDO_DATA_DIR, DATA_PLANE_LOG_FILE),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
    expect(lines).toMatchObject([
      {
        event: "started",
        db: join(env.EIDO_DATA_DIR, DATA_DB_FILE),
        gateSocket: env.EIDO_GATE_SOCKET,
        env: "EIDO_DATA_DIR,EIDO_GATE_SOCKET",
      },
      { event: "stopped" },
    ])
  })
})

describe("eido-data.db at startup", () => {
  const env = (): { EIDO_DATA_DIR: string; EIDO_GATE_SOCKET: string } => ({
    EIDO_DATA_DIR: join(dir, "data"),
    EIDO_GATE_SOCKET: join(dir, "missing.sock"),
  })
  const quietAudit = { audit: () => Promise.resolve() }

  /** A file at the index schema holding one document stored before the ledger, with no entity. */
  async function fileWithUnassignedDocument(
    setDefault: boolean
  ): Promise<string> {
    const config = dataPlaneConfig(env())
    mkdirSync(config.dataDir, { recursive: true })
    const db = openIndex(config.dbPath)
    const profile = createProfileStore(db, quietAudit)
    const entity = await profile.createEntity({
      kind: "personal",
      name: "Test Personal",
      tag: "ME",
    })
    if (setDefault) await profile.setDefaultEntityId(entity.id)
    ingestBatch(db, {
      connector: "gmail",
      stream: "INBOX",
      documents: [
        {
          sha256: "a".repeat(64),
          source: "gmail",
          sourceRef: "gm-1",
          mime: "message/rfc822",
          body: "lorem",
        },
      ],
      nextCursor: "{}",
    })
    db.close()
    return entity.id
  }

  const entityOfDocument = (db: DatabaseSync): unknown =>
    db.prepare("SELECT entity_id FROM documents").get()?.["entity_id"]
  const hasLedger = (db: DatabaseSync): boolean =>
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_schema'"
      )
      .get() !== undefined

  it("backfills documents stored without an entity with the default entity", async () => {
    const entityId = await fileWithUnassignedDocument(true)
    const plane = runDataPlane(dataPlaneConfig(env()), env())
    expect(hasLedger(plane.db)).toBe(true)
    expect(entityOfDocument(plane.db)).toBe(entityId)
    await plane.close()
  })

  it("with no default entity it keeps the index schema, logs ledger_pending, and applies the ledger on the next start once a default is set", async () => {
    const entityId = await fileWithUnassignedDocument(false)
    const first = runDataPlane(dataPlaneConfig(env()), env())
    expect(hasLedger(first.db)).toBe(false)
    expect(entityOfDocument(first.db)).toBeNull()
    await first.close()
    const log = readFileSync(
      join(env().EIDO_DATA_DIR, DATA_PLANE_LOG_FILE),
      "utf8"
    )
    expect(log).toContain(
      '"event":"ledger_pending","reason":"default_entity_required"'
    )

    const db = openIndex(dataPlaneConfig(env()).dbPath)
    await createProfileStore(db, quietAudit).setDefaultEntityId(entityId)
    db.close()
    const second = runDataPlane(dataPlaneConfig(env()), env())
    expect(hasLedger(second.db)).toBe(true)
    expect(entityOfDocument(second.db)).toBe(entityId)
    await second.close()
  })
  it("does not swallow other ledger failures", async () => {
    const defaultEntityId = await fileWithUnassignedDocument(true)
    const db = openDataDb(dataPlaneConfig(env()).dbPath, { defaultEntityId })
    db.prepare("UPDATE ledger_schema SET version = 99").run()
    db.close()
    expect(() => runDataPlane(dataPlaneConfig(env()), env())).toThrow(
      "ledger schema version 99 is newer than supported"
    )
  })
})

describe("launchPlan", () => {
  const argv = ["/usr/bin/node", "/eido/core/src/main.ts"]
  const execArgv = ["--import", "./src/ts-hooks.ts"]

  it("re-runs once with only the allowlisted variables when the environment holds more", () => {
    expect(
      launchPlan(argv, execArgv, {
        EIDO_DATA_DIR: "/d",
        GMAIL_REFRESH_TOKEN: "synthetic",
      })
    ).toEqual({
      kind: "reexec",
      args: [
        "--import",
        "./src/ts-hooks.ts",
        "/eido/core/src/main.ts",
        SCRUBBED_FLAG,
      ],
      env: { EIDO_DATA_DIR: "/d" },
    })
  })

  it("runs in place when the environment is already the allowlist", () => {
    expect(
      launchPlan(argv, execArgv, {
        EIDO_DATA_DIR: "/d",
        __CF_USER_TEXT_ENCODING: "0x0:0:0",
      })
    ).toEqual({ kind: "run" })
  })

  it("never re-runs a process that was already re-run", () => {
    expect(
      launchPlan([...argv, SCRUBBED_FLAG], execArgv, { HOME: "/home/someone" })
    ).toEqual({ kind: "run" })
  })
})

/** GET `path` on the API with its listen address as Host; resolves status and parsed body. */
async function getJson(
  port: number,
  path: string
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`)
  return { status: response.status, body: await response.json() }
}

function servedEnv(extra: Record<string, string> = {}) {
  return {
    EIDO_DATA_DIR: join(dir, "data"),
    EIDO_GATE_SOCKET: join(dir, "missing.sock"),
    EIDO_CORE_PORT: "0",
    ...extra,
  }
}

describe("serveDataPlane", () => {
  it("serves GET /profile over HTTP from eido-data.db on disk and logs where it listens", async () => {
    const env = servedEnv()
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    plane.db
      .prepare(
        `INSERT INTO profile (id, display_name, timezone, working_hours_json, signature, updated_at)
         VALUES (1, 'Test Owner', 'Europe/Zurich', '{}', '', '2030-01-01T00:00:00.000Z')`
      )
      .run()
    const api = await serveDataPlane(plane, config.api)
    try {
      expect(await getJson(api.port, "/profile")).toEqual({
        status: 200,
        body: {
          profile: {
            displayName: "Test Owner",
            timezone: "Europe/Zurich",
            workingHours: {},
            signature: "",
            addresses: [],
            updatedAt: "2030-01-01T00:00:00.000Z",
          },
        },
      })
    } finally {
      await api.close()
      await plane.close()
    }
    const listening = readFileSync(config.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
      .find((entry) => field(entry, "event") === "listening")
    expect(listening).toMatchObject({
      host: "127.0.0.1",
      port: String(api.port),
      basePath: "",
      allowedHosts: `127.0.0.1:${String(api.port)}`,
    })
  })

  it.each([
    ["/api/core", "/api/core/profile", "/profile"],
    ["", "/profile", "/api/core/profile"],
  ])(
    "with the base path %j serves %s and not %s",
    async (base, served, missing) => {
      const env = servedEnv({ EIDO_CORE_BASE_PATH: base })
      const config = dataPlaneConfig(env)
      const plane = runDataPlane(config, env)
      const api = await serveDataPlane(plane, config.api)
      try {
        expect(await getJson(api.port, served)).toEqual({
          status: 200,
          body: {},
        })
        expect(await getJson(api.port, missing)).toMatchObject({
          status: 404,
          body: { error: { code: "not_found" } },
        })
      } finally {
        await api.close()
        await plane.close()
      }
    }
  )

  it("answers 421 misdirected_request to a Host outside allowedHosts", async () => {
    const env = servedEnv({ EIDO_CORE_ALLOWED_HOSTS: "eido.example.invalid" })
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const api = await serveDataPlane(plane, config.api)
    const status = (host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: api.port,
            path: "/profile",
            headers: { host },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on("data", (chunk: Buffer) => chunks.push(chunk))
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              })
            )
          }
        )
        req.on("error", reject)
        req.end()
      })
    try {
      const refused = await status("rebound.example.invalid")
      expect(refused.status).toBe(421)
      expect(field(field(JSON.parse(refused.body), "error"), "code")).toBe(
        "misdirected_request"
      )
      expect((await status("eido.example.invalid")).status).toBe(200)
    } finally {
      await api.close()
      await plane.close()
    }
  })
})

describe("starting the data plane", () => {
  const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url))
  const HOOKS = fileURLToPath(new URL("./ts-hooks.ts", import.meta.url))

  it.each(["0.0.0.0", "192.168.1.20", "::"])(
    "fails at startup when asked to bind %s, before opening anything",
    async (host) => {
      const env = servedEnv({ EIDO_CORE_HOST: host })
      const exit = await new Promise<{ code: number | null; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["--disable-warning=ExperimentalWarning", "--import", HOOKS, MAIN],
            { env, timeout: 10_000 },
            (error, _stdout, stderr) =>
              resolve({
                code: error === null ? 0 : Number(error.code ?? -1),
                stderr,
              })
          )
        }
      )
      expect(exit.code).not.toBe(0)
      expect(exit.stderr).toContain("core's API binds to 127.0.0.1 or ::1 only")
      expect(existsSync(join(env.EIDO_DATA_DIR, DATA_DB_FILE))).toBe(false)
    },
    15_000
  )
})

describe("holdUntilStopped", () => {
  it("stops the API, then closes the data plane, on the first stop signal only", async () => {
    const env = servedEnv()
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const api = await serveDataPlane(plane, config.api)
    const signals = new EventEmitter()
    const stopped = holdUntilStopped(plane, api, signals)
    expect((await getJson(api.port, "/profile")).status).toBe(200)
    expect(plane.db.isOpen).toBe(true)
    signals.emit("SIGTERM")
    await stopped
    expect(plane.db.isOpen).toBe(false)
    await expect(
      fetch(`http://127.0.0.1:${String(api.port)}/profile`)
    ).rejects.toThrow()
    expect(() => signals.emit("SIGINT")).not.toThrow()
    const events = readFileSync(config.logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => field(JSON.parse(line), "event"))
    expect(events).toEqual(["started", "listening", "stopped"])
  })
  it("lets a write whose audit is in flight finish before it closes eido-data.db", async () => {
    // A gate that holds POST /audit until the test answers it.
    const socketPath = join(dir, "gate.sock")
    let answer: (response: ServerResponse) => void = () => undefined
    const held = new Promise<ServerResponse>((resolve) => {
      answer = resolve
    })
    const gate = createHttpServer((request, response) => {
      request.resume()
      answer(response)
    })
    await new Promise<void>((resolve) => gate.listen(socketPath, resolve))
    try {
      const env = servedEnv({ EIDO_GATE_SOCKET: socketPath })
      const config = dataPlaneConfig(env)
      const plane = runDataPlane(config, env)
      const api = await serveDataPlane(plane, config.api)
      const signals = new EventEmitter()
      const stopped = holdUntilStopped(plane, api, signals)
      const write = fetch(`http://127.0.0.1:${String(api.port)}/entities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "personal", name: "N", tag: "n" }),
      }).catch(() => undefined)
      const audit = await held
      signals.emit("SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(plane.db.isOpen).toBe(true)
      audit.writeHead(201, { "content-type": "application/json" })
      audit.end(JSON.stringify({ seq: 1 }))
      await stopped
      await write
      expect(plane.db.isOpen).toBe(false)
      const reopened = new DatabaseSync(config.dbPath)
      expect(
        reopened
          .prepare("SELECT name FROM entities")
          .all()
          .map((r) => r["name"])
      ).toEqual(["N"])
      reopened.close()
    } finally {
      gate.closeAllConnections()
      await new Promise<void>((resolve) => gate.close(() => resolve()))
    }
  })

  it("still closes the data plane when closing the API fails", async () => {
    const env = servedEnv()
    const plane = runDataPlane(dataPlaneConfig(env), env)
    const failure = new Error("close failed")
    const api: CoreApi = {
      host: "127.0.0.1",
      port: 1,
      allowedHosts: [],
      close: () => Promise.reject(failure),
    }
    const signals = new EventEmitter()
    const stopped = holdUntilStopped(plane, api, signals)
    signals.emit("SIGINT")
    await expect(stopped).rejects.toBe(failure)
    expect(plane.db.isOpen).toBe(false)
  })
})

describe("forwardTo", () => {
  it("passes stop signals to the re-run process and exits with its code", () => {
    const killed: string[] = []
    const exits: number[] = []
    const child = Object.assign(new EventEmitter(), {
      kill: (signal: string) => killed.push(signal),
    })
    const parent = Object.assign(new EventEmitter(), {
      exit: (code: number) => exits.push(code),
    })
    forwardTo(child, parent)
    parent.emit("SIGINT")
    parent.emit("SIGTERM")
    expect(killed).toEqual(["SIGINT", "SIGTERM"])
    child.emit("exit", 3)
    expect(exits).toEqual([3])
  })

  it("exits with 1 when the re-run process was killed by a signal", () => {
    const exits: number[] = []
    const child = Object.assign(new EventEmitter(), { kill: () => true })
    forwardTo(
      child,
      Object.assign(new EventEmitter(), {
        exit: (code: number) => exits.push(code),
      })
    )
    child.emit("exit", null)
    expect(exits).toEqual([1])
  })
})
