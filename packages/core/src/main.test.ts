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
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest"
import type { CoreApi } from "./api/index"
import { ingestBatch } from "./index/ingest"
import { startStubModelServer } from "./inference/stub-server"
import { openIndex } from "./index/schema"
import { openDataDb } from "./ledger/db"
import { createProfileStore } from "./profile/store"
import { createGmailClient } from "./connectors/gmail/client"
import {
  createFakeGmail,
  rfc822,
} from "./connectors/gmail/fake-gmail.test-support"
import { createParser } from "./parsers/index"
import { scheduleIngestedDigests } from "./digest/ingest"
import { textPdf } from "./parsers/fixtures.test-support"
import {
  DATA_DB_FILE,
  DATA_PLANE_LOG_FILE,
  SCRUBBED_FLAG,
  coreApiConfig,
  createGmailSyncRuntime,
  dataPlaneConfig,
  dataPlaneEnv,
  forwardTo,
  holdUntilStopped,
  launchPlan,
  outsideAllowlist,
  runDataPlane,
  serveDataPlane,
  startConversationDigestTimer,
  CONVERSATION_DIGEST_SWEEP_INTERVAL_MS,
  DEFAULT_CORE_PORT,
} from "./main"
import type { DataPlaneConfig } from "./main"

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
    EIDO_GMAIL_PROXY_URL: "http://127.0.0.1:7801",
    GMAIL_REFRESH_TOKEN: "synthetic",
    __CF_USER_TEXT_ENCODING: "0x0:0:0",
    HOME: "/home/someone",
  }

  it("keeps only the allowlisted, non-empty variables", () => {
    expect(dataPlaneEnv(parent)).toEqual({
      EIDO_DATA_DIR: "/d",
      EIDO_GATE_SOCKET: "/d/gate.sock",
      EIDO_LLAMA_HOST: "127.0.0.1",
      EIDO_GMAIL_PROXY_URL: "http://127.0.0.1:7801",
    })
  })

  it("names the variables outside the allowlist, ignoring what the OS adds", () => {
    expect(outsideAllowlist(parent)).toEqual(["GMAIL_REFRESH_TOKEN", "HOME"])
  })
})

describe("DEFAULT_CORE_PORT", () => {
  it("is 8789, not 8787 which another app on the host uses", () => {
    expect(DEFAULT_CORE_PORT).toBe(8789)
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
        port: 8789,
        basePath: "",
        allowedHosts: [],
        conversationDigestIdleTtlMinutes: 60,
        digest: { sectionTokens: 2000 },
      },
    })
  })

  it("names every missing or empty variable", () => {
    expect(() => dataPlaneConfig({ EIDO_GATE_SOCKET: "" })).toThrow(
      "the data plane needs EIDO_DATA_DIR, EIDO_GATE_SOCKET"
    )
  })
})

describe("conversation digest timer", () => {
  it("runs the sweep on its interval and stops when closed", async () => {
    vi.useFakeTimers()
    const sweep = vi.fn(() => Promise.resolve())
    try {
      const stop = startConversationDigestTimer(sweep)
      await vi.advanceTimersByTimeAsync(CONVERSATION_DIGEST_SWEEP_INTERVAL_MS)
      expect(sweep).toHaveBeenCalledTimes(1)
      stop()
      await vi.advanceTimersByTimeAsync(CONVERSATION_DIGEST_SWEEP_INTERVAL_MS)
      expect(sweep).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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
      conversationDigestIdleTtlMinutes: 60,
      digest: { sectionTokens: 2000 },
    })
  })

  test("builds a local model URL from the allowlisted llama host and port", () => {
    expect(
      coreApiConfig({ EIDO_LLAMA_HOST: "::1", EIDO_LLAMA_PORT: "8080" })
    ).toMatchObject({ modelBaseUrl: "http://[::1]:8080" })
  })

  test("reads the pinned model's chat template kwargs as a JSON object", () => {
    expect(
      coreApiConfig({
        EIDO_LLAMA_CHAT_TEMPLATE_KWARGS: '{"enable_thinking": false}',
      }).chatTemplateKwargs
    ).toEqual({ enable_thinking: false })
  })

  test("leaves chat template kwargs out when unset or empty", () => {
    expect(coreApiConfig({})).not.toHaveProperty("chatTemplateKwargs")
    expect(
      coreApiConfig({ EIDO_LLAMA_CHAT_TEMPLATE_KWARGS: "" })
    ).not.toHaveProperty("chatTemplateKwargs")
  })

  test.each(["not json", "[1]", '"x"', "null", "3"])(
    "stops startup when the chat template kwargs are %s, not a JSON object",
    (value) => {
      expect(() =>
        coreApiConfig({ EIDO_LLAMA_CHAT_TEMPLATE_KWARGS: value })
      ).toThrow("EIDO_LLAMA_CHAT_TEMPLATE_KWARGS must be a JSON object")
    }
  )

  test("accepts only a loopback Gmail egress proxy URL", () => {
    expect(
      coreApiConfig({ EIDO_GMAIL_PROXY_URL: "http://127.0.0.1:7801/" })
        .gmailProxyUrl
    ).toBe("http://127.0.0.1:7801")
    expect(() =>
      coreApiConfig({ EIDO_GMAIL_PROXY_URL: "https://proxy.example.com" })
    ).toThrow("EIDO_GMAIL_PROXY_URL must be a loopback HTTP URL")
  })

  test("reads a positive conversation digest TTL, defaulting to 60 minutes", () => {
    expect(
      coreApiConfig({
        EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES: "25",
      }).conversationDigestIdleTtlMinutes
    ).toBe(25)
    expect(() =>
      coreApiConfig({ EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES: "0" })
    ).toThrow(
      "EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES must be a positive integer"
    )
  })

  test("reads the positive digest section token budget", () => {
    expect(
      coreApiConfig({ EIDO_DIGEST_SECTION_TOKENS: "1800" }).digest.sectionTokens
    ).toBe(1800)
    expect(() => coreApiConfig({ EIDO_DIGEST_SECTION_TOKENS: "0" })).toThrow(
      "EIDO_DIGEST_SECTION_TOKENS must be a positive integer"
    )
  })

  test("requires a paired loopback model host and valid port", () => {
    expect(() => coreApiConfig({ EIDO_LLAMA_HOST: "127.0.0.1" })).toThrow(
      "EIDO_LLAMA_HOST and EIDO_LLAMA_PORT must be configured together"
    )
    expect(() =>
      coreApiConfig({
        EIDO_LLAMA_HOST: "192.168.1.20",
        EIDO_LLAMA_PORT: "8080",
      })
    ).toThrow("inference is local")
    expect(() =>
      coreApiConfig({ EIDO_LLAMA_HOST: "127.0.0.1", EIDO_LLAMA_PORT: "0" })
    ).toThrow("EIDO_LLAMA_PORT must be between 1 and 65535")
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

  it("uses one model-backed digest service and drains its build before closing the database", async () => {
    const model = await startStubModelServer({
      contextTokens: 8192,
      modelMetadataFailures: 1,
      replies: [
        {
          deltas: [
            JSON.stringify({
              lines: [
                {
                  text: "Stored summary",
                  cites: ["msg-runtime@example.invalid"],
                },
              ],
            }),
          ],
        },
      ],
    })
    const env = {
      EIDO_DATA_DIR: join(dir, "digest-data"),
      EIDO_GATE_SOCKET: join(dir, "missing.sock"),
      EIDO_LLAMA_HOST: "127.0.0.1",
      EIDO_LLAMA_PORT: new URL(model.url).port,
    }
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const entityId = "entity-digest-test"
    plane.db
      .prepare(
        "INSERT INTO entities (id, kind, name, tag, created_at) VALUES (?, 'personal', ?, 'ME', ?)"
      )
      .run(entityId, "Digest Test", "2030-01-01T00:00:00.000Z")
    const document = {
      sha256: "b".repeat(64),
      source: "gmail",
      sourceRef: "gm-runtime",
      mime: "message/rfc822",
      entityId,
      body: "The stored message has a checkable source id.",
      headers: {
        threadId: "thread-runtime",
        messageId: "msg-runtime@example.invalid",
      },
    }
    ingestBatch(plane.db, {
      connector: "gmail",
      stream: "INBOX",
      documents: [document],
      nextCursor: "c1",
    })
    plane.scheduleIngestedDocuments([document])
    plane.scheduleIngestedDocuments([document])

    await plane.close()

    expect(
      model.requests.filter((request) => request.path === "/v1/models")
    ).toHaveLength(2)
    expect(model.completions()).toHaveLength(1)
    expect(plane.db.isOpen).toBe(false)
    expect(
      readFileSync(config.logPath, "utf8").includes("digest_schedule_failed")
    ).toBe(true)
    const db = openDataDb(config.dbPath)
    expect(
      db.prepare("SELECT model_id, lines_json FROM digests").get()
    ).toEqual({
      model_id: "local",
      lines_json: JSON.stringify([
        {
          text: "Stored summary",
          cites: [
            {
              messageId: "msg-runtime@example.invalid",
              injectionSuspected: false,
              reasons: [],
            },
          ],
        },
      ]),
    })
    db.close()
    await model.close()
  })

  it("logs failed digest scheduling and still closes when no local model is configured", async () => {
    const env = {
      EIDO_DATA_DIR: join(dir, "digest-without-model"),
      EIDO_GATE_SOCKET: join(dir, "missing.sock"),
    }
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const entityId = "entity-no-model"
    plane.db
      .prepare(
        "INSERT INTO entities (id, kind, name, tag, created_at) VALUES (?, 'personal', ?, 'ME', ?)"
      )
      .run(entityId, "No Model", "2030-01-01T00:00:00.000Z")
    const document = {
      sha256: "c".repeat(64),
      source: "gmail",
      sourceRef: "gm-no-model",
      mime: "message/rfc822",
      entityId,
      body: "A stored message without model configuration.",
      headers: {
        threadId: "thread-no-model",
        messageId: "no-model@example.invalid",
      },
    }
    ingestBatch(plane.db, {
      connector: "gmail",
      stream: "INBOX",
      documents: [document],
      nextCursor: "c1",
    })
    plane.scheduleIngestedDocuments([document])

    await plane.close()

    expect(plane.db.isOpen).toBe(false)
    expect(readFileSync(config.logPath, "utf8")).toContain(
      '"event":"digest_schedule_failed"'
    )
  })
})

describe("Gmail sync runtime", () => {
  it("fails data-plane startup clearly when Gmail has no parser data directory", () => {
    const dbPath = join(dir, "must-not-open.db")
    const config: DataPlaneConfig = {
      dataDir: "",
      dbPath,
      logPath: join(dir, "data-plane.log"),
      gateSocket: join(dir, "gate.sock"),
      api: {
        host: "127.0.0.1",
        port: 8789,
        basePath: "",
        allowedHosts: [],
        gmailProxyUrl: "http://127.0.0.1:7801",
        conversationDigestIdleTtlMinutes: 60,
        digest: { sectionTokens: 2000 },
      },
    }
    expect(() => runDataPlane(config, {})).toThrow(
      "Gmail sync requires EIDO_DATA_DIR to configure its parser"
    )
    expect(existsSync(dbPath)).toBe(false)
  })

  it("passes its data-dir parser into Gmail sync and indexes PDF text", async () => {
    const db = openDataDb(":memory:")
    const profile = createProfileStore(db, {
      audit: () => Promise.resolve(),
    })
    const entity = await profile.createEntity({
      kind: "personal",
      name: "Test Personal",
      tag: "ME",
    })
    await profile.setDefaultEntityId(entity.id)
    const gmail = createFakeGmail()
    gmail.add({
      id: "gm-runtime",
      threadId: "th-runtime",
      labelIds: ["INBOX"],
      raw: rfc822({
        messageId: "runtime@mail.example.invalid",
        subject: "Attached report",
        body: "See attached.",
        attachment: {
          filename: "report.pdf",
          mime: "application/pdf",
          content: textPdf([["Report page one"], ["Report page two"]]),
        },
      }),
    })
    const parser = createParser({ dataDir: join(dir, "parser-data") })
    const scheduleDigest = vi.fn()
    const sync = createGmailSyncRuntime({
      db,
      gate: { getConnectorHealth: () => Promise.resolve([]) },
      profile,
      client: createGmailClient(gmail.transport),
      parser,
      onIngested: (documents) =>
        scheduleIngestedDigests(db, { scheduleDigest }, documents),
      log: () => undefined,
    })

    await sync()
    const attachment = db
      .prepare(
        "SELECT t.body FROM document_text t JOIN documents d ON d.sha256 = t.sha256 WHERE t.attachment_of = ? AND d.source_ref = ?"
      )
      .get("gm-runtime", "gm-runtime#0")
    expect(attachment?.["body"]).toBe("Report page one\nReport page two")
    const storedPages = db
      .prepare(
        "SELECT page, text FROM document_pages WHERE sha256 = (SELECT sha256 FROM documents WHERE source_ref = ?) ORDER BY page"
      )
      .all("gm-runtime#0")
    expect(storedPages).toEqual([
      { page: 1, text: "Report page one" },
      { page: 2, text: "Report page two" },
    ])
    expect(scheduleDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document",
        pages: [
          { page: 1, text: "Report page one" },
          { page: 2, text: "Report page two" },
        ],
      })
    )
    expect(scheduleDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "thread",
        threadId: JSON.stringify(["gmail", entity.id, "th-runtime"]),
      })
    )
    db.close()
  }, 60_000)

  it("fails clearly when configured without a parser", () => {
    const db = openDataDb(":memory:")
    const profile = createProfileStore(db, {
      audit: () => Promise.resolve(),
    })
    expect(() =>
      createGmailSyncRuntime({
        db,
        gate: { getConnectorHealth: () => Promise.resolve([]) },
        profile,
        client: createGmailClient(createFakeGmail().transport),
        log: () => undefined,
      })
    ).toThrow("Gmail sync requires a configured sandboxed document parser")
    db.close()
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
  it("retries idle conversation sweeps after queue and summary failures without overlapping builds", async () => {
    const model = await startStubModelServer({
      contextTokens: 8192,
      replies: [
        { deltas: ["invalid summary"] },
        { deltas: [JSON.stringify({ summary: "Please track repairs." })] },
      ],
    })
    const env = servedEnv({
      EIDO_LLAMA_HOST: "127.0.0.1",
      EIDO_LLAMA_PORT: new URL(model.url).port,
    })
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const queue = vi
      .spyOn(plane, "getInferenceQueue")
      .mockRejectedValueOnce(new Error("model temporarily unavailable"))
    const log = vi.spyOn(plane, "log")
    const timers = vi.spyOn(globalThis, "setInterval")
    const api = await serveDataPlane(plane, config.api)
    try {
      const tick = timers.mock.calls.at(-1)?.[0]
      if (typeof tick !== "function") throw new Error("missing digest timer")
      const store = plane.conversation
      if (store === undefined) throw new Error("missing conversation store")
      store.appendTurn("idle", {
        id: "old-turn",
        role: "user",
        text: "Please track repairs.",
        at: "2020-01-01T00:00:00.000Z",
        sources: [],
      })
      plane.db
        .prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", "idle")
      tick()
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith("conversation_digest_sweep_failed", {
          count: "unknown",
        })
      )
      tick()
      tick()
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith("conversation_digest_sweep_failed", {
          count: "1",
        })
      )
      expect(model.completions()).toHaveLength(1)
      expect(store.getConversationDigest("idle")).toBeUndefined()
      tick()
      await vi.waitFor(() =>
        expect(store.getConversationDigest("idle")?.text).toContain(
          "Please track repairs."
        )
      )
      expect(model.completions()).toHaveLength(2)
      delete plane.conversation
      tick()
      expect(queue).toHaveBeenCalledTimes(3)
    } finally {
      timers.mockRestore()
      await api.close()
      await plane.close()
      await model.close()
    }
  })

  it("does not schedule a conversation sweep without a configured local model", async () => {
    const env = servedEnv()
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const queue = vi.spyOn(plane, "getInferenceQueue")
    const timers = vi.spyOn(globalThis, "setInterval")
    const api = await serveDataPlane(plane, config.api)
    try {
      const tick = timers.mock.calls.at(-1)?.[0]
      if (typeof tick !== "function") throw new Error("missing digest timer")
      tick()
      expect(queue).not.toHaveBeenCalled()
    } finally {
      timers.mockRestore()
      await api.close()
      await plane.close()
    }
  })

  it("keeps non-ask routes available when the local model is unavailable", async () => {
    const env = servedEnv({
      EIDO_LLAMA_HOST: "127.0.0.1",
      EIDO_LLAMA_PORT: "1",
    })
    const config = dataPlaneConfig(env)
    const plane = runDataPlane(config, env)
    const api = await serveDataPlane(plane, config.api)
    try {
      expect((await getJson(api.port, "/profile")).status).toBe(200)
      const response = await fetch(`http://127.0.0.1:${String(api.port)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "anything?" }),
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: { code: "busy", message: "ask is temporarily unavailable" },
      })
    } finally {
      await api.close()
      await plane.close()
    }
  })

  it.each([
    [
      "sends the configured chat template kwargs on every /apply-template",
      '{"enable_thinking": false}',
    ],
    ["sends no chat_template_kwargs when none are configured", undefined],
  ])("%s", async (_name, kwargs) => {
    const model = await startStubModelServer({
      contextTokens: 8192,
      replies: [],
    })
    const env = servedEnv({
      EIDO_LLAMA_HOST: "127.0.0.1",
      EIDO_LLAMA_PORT: new URL(model.url).port,
      ...(kwargs === undefined
        ? {}
        : { EIDO_LLAMA_CHAT_TEMPLATE_KWARGS: kwargs }),
    })
    const plane = runDataPlane(dataPlaneConfig(env), env)
    try {
      await plane.getInferenceQueue()
      const bodies = model.requests
        .filter((request) => request.path === "/apply-template")
        .map((request) => JSON.parse(request.body) as Record<string, unknown>)
      expect(bodies.length).toBeGreaterThan(0)
      for (const body of bodies) {
        if (kwargs === undefined)
          expect(body).not.toHaveProperty("chat_template_kwargs")
        else
          expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
      }
    } finally {
      await plane.close()
      await model.close()
    }
  })

  it("serves POST /ask through the configured data plane and local model client", async () => {
    const model = await startStubModelServer({
      contextTokens: 8192,
      replies: [
        { deltas: [JSON.stringify({ terms: ["invoice"], wants: "find" })] },
        { deltas: ["The invoice was paid [M1]."] },
        { deltas: [JSON.stringify({ terms: ["invoice"], wants: "find" })] },
        { deltas: ["It was paid on January 4 [M1]."] },
      ],
    })
    const port = new URL(model.url).port
    const env = servedEnv({
      EIDO_LLAMA_HOST: "127.0.0.1",
      EIDO_LLAMA_PORT: port,
    })
    const config = dataPlaneConfig(env)
    let plane = runDataPlane(config, env)
    plane.db
      .prepare(
        "INSERT INTO entities (id, kind, name, tag, created_at) VALUES (?, 'personal', ?, 'ME', ?)"
      )
      .run("entity-test", "Test Personal", "2030-01-01T00:00:00.000Z")
    plane.db
      .prepare("INSERT INTO default_entity (id, entity_id) VALUES (1, ?)")
      .run("entity-test")
    ingestBatch(plane.db, {
      connector: "gmail",
      stream: "INBOX",
      documents: [
        {
          sha256: "a".repeat(64),
          source: "gmail",
          sourceRef: "gm-1",
          mime: "message/rfc822",
          entityId: "entity-test",
          title: "Invoice",
          body: "The invoice was paid on 2030-01-04.",
          occurredAt: "2030-01-04T00:00:00.000Z",
        },
      ],
      nextCursor: "{}",
    })
    let api: CoreApi | undefined
    try {
      api = await serveDataPlane(plane, config.api)
      const response = await fetch(`http://127.0.0.1:${String(api.port)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "When was the invoice paid?" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: "answered",
        answer: "The invoice was paid [M1].",
        citations: [{ tag: "M1", sourceRef: "gm-1" }],
        coverage: {
          searched: 1,
          matched: 1,
          readInFull: 1,
          label: "read 1 of 1 matching messages in full",
        },
      })
      const followup = await fetch(`http://127.0.0.1:${String(api.port)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "What day was it?" }),
      })
      expect(await followup.json()).toMatchObject({
        status: "answered",
        answer: "It was paid on January 4 [M1].",
      })
      const followupPrompt =
        model
          .completions()[3]
          ?.turns.map((turn) => turn.content)
          .join("\n") ?? ""
      expect(followupPrompt).toContain("When was the invoice paid?")
      expect(followupPrompt.match(/Question: What day was it\?/g)).toHaveLength(
        1
      )
      const compact = await fetch(`http://127.0.0.1:${String(api.port)}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "/compact" }),
      })
      expect(await compact.json()).toMatchObject({
        status: "answered",
        answer: "Nothing to compact yet",
      })
      expect(plane.conversation?.sourceTags("ask")).toEqual([
        { tag: "M1", sourceRef: "gm-1" },
      ])
      await api.close()
      api = undefined
      await plane.close()
      plane = runDataPlane(config, env)
      expect(plane.conversation?.getTurns("ask")).toHaveLength(4)
      expect(plane.conversation?.sourceTags("ask")).toEqual([
        { tag: "M1", sourceRef: "gm-1" },
      ])
      expect(
        plane.conversation?.searchConversations("invoice", { kind: "raw" })
      ).toHaveLength(2)
    } finally {
      await api?.close()
      await plane.close()
      await model.close()
    }
  })

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
