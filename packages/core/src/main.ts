import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { createAuditClient, createIntentClient } from "@eido/gate"
import type { IntentClient } from "@eido/gate"
import { ask } from "./ask/ask"
import type { AskDeps } from "./ask/types"
import { coverageLabel } from "./ask/answer"
import type { AskFigure } from "@eido/schemas"
import { basePath, listenCoreApi, loopbackHost } from "./api/listen"
import type { CoreApi, LoopbackHost } from "./api/listen"
import { openIndex } from "./index/schema"
import { openDataDb } from "./ledger/db"
import {
  connectModelClient,
  loopbackBaseUrl,
  readContextTokens,
  readModelId,
  createInferenceQueue,
} from "./inference/index"
import { LedgerError } from "./ledger/errors"
import { createObligationStateStore } from "./ledger/obligation-state"
import type { ObligationStateStore } from "./ledger/obligation-state"
import { createConversationStore } from "./conversation/store"
import type { ConversationStore } from "./conversation/store"
import { openConversationIndex } from "./conversation/search-index"
import {
  compactConversation,
  dispatchCommand,
  runDigestSweep,
} from "./conversation/index"
import { DEFAULT_DIGEST_IDLE_TTL_MINUTES } from "./conversation/digest"
import { createProfileStore, readDefaultEntityId } from "./profile/store"
import type { ProfileStore } from "./profile/store"
import type { InferenceQueue } from "./inference/queue"
import { createDigestService } from "./digest/service"
import type { DigestService } from "./digest/service"
import { scheduleIngestedDigests } from "./digest/ingest"
import type { IndexedDocument } from "./index/ingest"
import { DEFAULT_SECTION_TOKENS } from "./digest/types"
import { createParser } from "./parsers/index"
import type { Parser } from "./parsers/index"
import {
  createGmailClient,
  createGmailEgressTransport,
  GMAIL_DEFAULTS,
  resolveGmailConfig,
  syncGmailWithHealth,
} from "./connectors/gmail/index"
import type { GmailClient } from "./connectors/gmail/client"
import type { GmailConfig } from "./connectors/gmail/config"
import type { ConnectorHealthReader } from "./connectors/health-aware-sync"
import { syncReplyObligations } from "./obligations/replies"
import type { RepliesConfig } from "./obligations/replies"

// The data-plane process (ADR 0003). It owns eido-data.db, serves core's API on loopback, and
// reaches the gate only through the intent and audit clients on the gate's data-plane socket.
// Its environment is built from an allowlist, so no token, Keychain or OAuth variable and no
// path to the gate's control DB or control socket can be inherited: started with anything else
// in its environment, it re-runs itself with only the allowlisted variables. Start it with `pnpm --filter @eido/core start`.

/**
 * The only variables the data plane may see: data dir, gate socket, llama-server address, and
 * where core's API listens (loopback host, port, base path, extra Host headers to answer).
 */
export const DATA_PLANE_ENV = [
  "EIDO_DATA_DIR",
  "EIDO_GATE_SOCKET",
  "EIDO_LLAMA_HOST",
  "EIDO_LLAMA_PORT",
  "EIDO_LLAMA_CHAT_TEMPLATE_KWARGS",
  "EIDO_CORE_HOST",
  "EIDO_CORE_PORT",
  "EIDO_CORE_BASE_PATH",
  "EIDO_CORE_ALLOWED_HOSTS",
  "EIDO_GMAIL_PROXY_URL",
  "EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES",
  "EIDO_DIGEST_SECTION_TOKENS",
  "EIDO_REPLIES_CONFIG",
] as const

/**
 * Names the OS adds to every new process whatever environment it is given (macOS sets the text
 * encoding). They carry no credential; the allowlist check ignores them, or the re-exec would
 * never settle.
 */
export const OS_ADDED_ENV = ["__CF_USER_TEXT_ENCODING"] as const

/** Passed to the re-run process, which then never re-runs again. */
export const SCRUBBED_FLAG = "--env-scrubbed"

export const DATA_DB_FILE = "eido-data.db"
export const DATA_PLANE_LOG_FILE = "data-plane.log"

/** Where core's API listens unless EIDO_CORE_HOST and EIDO_CORE_PORT say otherwise. */
export const DEFAULT_CORE_HOST = "127.0.0.1"
export const DEFAULT_CORE_PORT = 8789
export const ASK_CONTEXT_BUDGET_TOKENS = 3000
export const ASK_REPLY_TOKENS = 512
export const GMAIL_SYNC_INTERVAL_MS = 5 * 60_000
export const CONVERSATION_DIGEST_SWEEP_INTERVAL_MS = 60_000

type Env = Readonly<Record<string, string | undefined>>

/** Start the periodic idle conversation compaction job and return its stop function. */
export function startConversationDigestTimer(
  sweep: () => Promise<void>
): () => void {
  const timer = setInterval(
    () => void sweep(),
    CONVERSATION_DIGEST_SWEEP_INTERVAL_MS
  )
  timer.unref()
  return () => clearInterval(timer)
}

/** The allowlisted, non-empty variables of `env`. */
export function dataPlaneEnv(env: Env): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const name of DATA_PLANE_ENV) {
    const value = env[name]
    if (value !== undefined && value !== "") picked[name] = value
  }
  return picked
}

/** Names in `env` outside the allowlist, sorted. Names only: values are never read. */
export function outsideAllowlist(env: Env): string[] {
  const allowed: readonly string[] = [...DATA_PLANE_ENV, ...OS_ADDED_ENV]
  return Object.keys(env)
    .filter((name) => !allowed.includes(name))
    .sort()
}

export type CoreApiConfig = {
  host: LoopbackHost
  port: number
  /** Empty, or the prefix routes are served under (`/api/core` when serve forwards it). */
  basePath: string
  /** Host headers answered besides the listen address, such as the one serve forwards. */
  allowedHosts: string[]
  /** Present only when a local llama-server host and port are configured. */
  modelBaseUrl?: string
  /**
   * The pinned model's chat template kwargs (`EIDO_LLAMA_CHAT_TEMPLATE_KWARGS`, a JSON object),
   * sent as `chat_template_kwargs` on every `/apply-template` call, as the eval does for its
   * candidate. Absent when unset, which leaves request bodies unchanged.
   */
  chatTemplateKwargs?: Record<string, unknown>
  /** Gate egress proxy URL. Gmail sync is disabled when this is not configured. */
  gmailProxyUrl?: string
  conversationDigestIdleTtlMinutes: number
  digest: { sectionTokens: number }
  replies?: Omit<RepliesConfig, "db">
}

export type DataPlaneConfig = {
  dataDir: string
  dbPath: string
  logPath: string
  gateSocket: string
  api: CoreApiConfig
}

function portOf(value: string, name = "EIDO_CORE_PORT"): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error(
      `${name} must be a port number, not ${JSON.stringify(value)}`
    )
  }
  return port
}

/** Core's API settings. A bind address other than 127.0.0.1 or ::1 throws: core has no auth. */
export function coreApiConfig(env: Env): CoreApiConfig {
  const modelHost = env["EIDO_LLAMA_HOST"]
  const modelPort = env["EIDO_LLAMA_PORT"]
  if (
    (modelHost === undefined || modelHost === "") !==
    (modelPort === undefined || modelPort === "")
  ) {
    throw new Error(
      "EIDO_LLAMA_HOST and EIDO_LLAMA_PORT must be configured together"
    )
  }
  const modelBaseUrl =
    modelHost && modelPort
      ? (() => {
          const port = portOf(modelPort, "EIDO_LLAMA_PORT")
          if (port === 0)
            throw new Error("EIDO_LLAMA_PORT must be between 1 and 65535")
          const host = modelHost.includes(":") ? `[${modelHost}]` : modelHost
          return loopbackBaseUrl(`http://${host}:${String(port)}`)
        })()
      : undefined
  const chatTemplateKwargs = chatTemplateKwargsOf(
    env["EIDO_LLAMA_CHAT_TEMPLATE_KWARGS"]
  )
  const gmailProxyUrl = env["EIDO_GMAIL_PROXY_URL"]
  const configuredGmailProxyUrl =
    gmailProxyUrl === undefined || gmailProxyUrl === ""
      ? undefined
      : (() => {
          try {
            return loopbackBaseUrl(gmailProxyUrl)
          } catch {
            throw new Error("EIDO_GMAIL_PROXY_URL must be a loopback HTTP URL")
          }
        })()
  return {
    host: loopbackHost(env["EIDO_CORE_HOST"] || DEFAULT_CORE_HOST),
    port: portOf(env["EIDO_CORE_PORT"] || String(DEFAULT_CORE_PORT)),
    basePath: basePath(env["EIDO_CORE_BASE_PATH"] ?? ""),
    allowedHosts: (env["EIDO_CORE_ALLOWED_HOSTS"] ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== ""),
    conversationDigestIdleTtlMinutes: positiveInteger(
      env["EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES"] ??
        String(DEFAULT_DIGEST_IDLE_TTL_MINUTES),
      "EIDO_CONVERSATION_DIGEST_IDLE_TTL_MINUTES"
    ),
    digest: {
      sectionTokens: positiveInteger(
        env["EIDO_DIGEST_SECTION_TOKENS"] ?? String(DEFAULT_SECTION_TOKENS),
        "EIDO_DIGEST_SECTION_TOKENS"
      ),
    },
    ...(env["EIDO_REPLIES_CONFIG"] === undefined ||
    env["EIDO_REPLIES_CONFIG"] === ""
      ? {}
      : { replies: parseRepliesConfig(env["EIDO_REPLIES_CONFIG"]) }),
    ...(modelBaseUrl === undefined ? {} : { modelBaseUrl }),
    ...(chatTemplateKwargs === undefined ? {} : { chatTemplateKwargs }),
    ...(configuredGmailProxyUrl === undefined
      ? {}
      : { gmailProxyUrl: configuredGmailProxyUrl }),
  }
}

function chatTemplateKwargsOf(
  value: string | undefined
): Record<string, unknown> | undefined {
  if (value === undefined || value === "") return undefined
  const invalid = new Error(
    'EIDO_LLAMA_CHAT_TEMPLATE_KWARGS must be a JSON object, such as {"enable_thinking": false}'
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalid
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw invalid
  return parsed as Record<string, unknown>
}

function parseRepliesConfig(raw: string): Omit<RepliesConfig, "db"> {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("EIDO_REPLIES_CONFIG must be a JSON object")
  const read = (key: string): unknown => Reflect.get(parsed, key)
  const me = read("me")
  const repliesOwed = read("repliesOwed") ?? { afterDays: 2 }
  const waitingOn = read("waitingOn") ?? { afterDays: 5 }
  const excludeSenders = read("excludeSenders") ?? []
  const ownerEntityId = read("ownerEntityId")
  const days = (value: unknown): value is { afterDays: number } =>
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger(Reflect.get(value, "afterDays")) &&
    Number(Reflect.get(value, "afterDays")) >= 0 &&
    Number(Reflect.get(value, "afterDays")) <= 3650
  if (
    !Array.isArray(me) ||
    !me.every(
      (address) => typeof address === "string" && address.includes("@")
    ) ||
    me.length === 0 ||
    !days(repliesOwed) ||
    !days(waitingOn) ||
    !Array.isArray(excludeSenders) ||
    !excludeSenders.every((pattern) => typeof pattern === "string") ||
    (ownerEntityId !== undefined && typeof ownerEntityId !== "string")
  ) {
    throw new Error(
      "EIDO_REPLIES_CONFIG requires me, repliesOwed.afterDays, waitingOn.afterDays, and excludeSenders"
    )
  }
  for (const pattern of excludeSenders) {
    try {
      new RegExp(pattern, "i")
    } catch {
      throw new Error(
        "EIDO_REPLIES_CONFIG excludeSenders contains an invalid regular expression"
      )
    }
  }
  return {
    me,
    ...(ownerEntityId === undefined ? {} : { ownerEntityId }),
    repliesOwed,
    waitingOn,
    excludeSenders,
  }
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function dataPlaneConfig(env: Env): DataPlaneConfig {
  const dataDir = env["EIDO_DATA_DIR"] ?? ""
  const gateSocket = env["EIDO_GATE_SOCKET"] ?? ""
  const missing = [
    ...(dataDir === "" ? ["EIDO_DATA_DIR"] : []),
    ...(gateSocket === "" ? ["EIDO_GATE_SOCKET"] : []),
  ]
  if (missing.length > 0) {
    throw new Error(`the data plane needs ${missing.join(", ")}`)
  }
  return {
    dataDir,
    dbPath: join(dataDir, DATA_DB_FILE),
    logPath: join(dataDir, DATA_PLANE_LOG_FILE),
    gateSocket,
    api: coreApiConfig(env),
  }
}

export type DataPlane = {
  db: DatabaseSync
  conversation?: ConversationStore
  conversationIndex: DatabaseSync
  gate: IntentClient
  /** The owner profile and entities; each entity or assignment change is audited by the gate. */
  profile: ProfileStore
  /** Local obligation state changes (#104); each is audited by the gate. */
  obligations: ObligationStateStore
  log: (event: string, fields?: Readonly<Record<string, string>>) => void
  /** Waits for the profile store's queued calls to settle, then closes eido-data.db. */
  close: () => Promise<void>
  stopGmailSync: () => void
  getInferenceQueue: () => Promise<InferenceQueue>
  getModelContextTokens: () => number
  /** Schedule digests for documents committed by a connector batch. */
  scheduleIngestedDocuments: (documents: readonly IndexedDocument[]) => void
  /** Schedule deterministic reply lifecycle detection after a committed sync batch. */
  scheduleReplyObligations: () => void
}

type GmailSyncRuntime = {
  db: DatabaseSync
  gate: ConnectorHealthReader
  profile: ProfileStore
  client: GmailClient
  parser?: Parser
  config?: GmailConfig
  onIngested?: (documents: readonly IndexedDocument[]) => void
  onBatchCommitted?: () => void
  log: DataPlane["log"]
}

/** A Gmail runtime must always have a sandboxed document parser. */
export function createGmailSyncRuntime(
  input: Omit<GmailSyncRuntime, "config"> & { config?: GmailConfig }
): () => Promise<void> {
  if (input.parser === undefined) {
    throw new Error(
      "Gmail sync requires a configured sandboxed document parser"
    )
  }
  const config = resolveGmailConfig(input.config ?? GMAIL_DEFAULTS)
  let running: Promise<void> | undefined
  return async () => {
    if (running !== undefined) return running
    running = (async () => {
      try {
        const account = await input.client.getProfile()
        if (account.emailAddress === undefined || account.emailAddress === "") {
          throw new Error("Gmail profile did not provide an account address")
        }
        await syncGmailWithHealth(
          input.gate,
          input.db,
          input.client,
          config,
          { accountRef: account.emailAddress, entities: input.profile },
          {
            parser: input.parser,
            onIngested: input.onIngested,
            onBatchCommitted: input.onBatchCommitted,
          }
        )
      } catch (error) {
        input.log("gmail_sync_failed", {
          reason: error instanceof Error ? error.message : "unknown error",
        })
      } finally {
        running = undefined
      }
    })()
    return running
  }
}

function gmailParser(dataDir: string | undefined): Parser {
  if (dataDir === undefined || dataDir === "") {
    throw new Error("Gmail sync requires EIDO_DATA_DIR to configure its parser")
  }
  return createParser({ dataDir })
}

function createModelQueueProvider(
  modelBaseUrl: string | undefined,
  chatTemplateKwargs?: Readonly<Record<string, unknown>>
): {
  getQueue: () => Promise<InferenceQueue>
  getModelId: () => Promise<string>
  getContextTokens: () => number
} {
  let queuePromise: Promise<InferenceQueue> | undefined
  let modelIdPromise: Promise<string> | undefined
  let modelContextTokens = 0
  const getQueue = async (): Promise<InferenceQueue> => {
    if (modelBaseUrl === undefined)
      throw new Error("local model is not configured")
    if (queuePromise === undefined) {
      queuePromise = (async () => {
        try {
          const contextTokens = await readContextTokens(modelBaseUrl)
          const client = await connectModelClient({
            baseUrl: modelBaseUrl,
            contextTokens,
            maxReplyTokens: ASK_REPLY_TOKENS,
            ...(chatTemplateKwargs === undefined ? {} : { chatTemplateKwargs }),
          })
          modelContextTokens = contextTokens
          return createInferenceQueue(client)
        } catch (error) {
          queuePromise = undefined
          throw error
        }
      })()
    }
    return queuePromise
  }
  const getModelId = async (): Promise<string> => {
    if (modelBaseUrl === undefined)
      throw new Error("local model is not configured")
    if (modelIdPromise === undefined) {
      modelIdPromise = readModelId(modelBaseUrl).catch((error: unknown) => {
        modelIdPromise = undefined
        throw error
      })
    }
    return modelIdPromise
  }
  return { getQueue, getModelId, getContextTokens: () => modelContextTokens }
}

/**
 * Opens eido-data.db with the ledger schema (`openDataDb`), passing the default entity stored in
 * the file so documents stored before the ledger get it. When such documents exist and no default
 * entity is set, the ledger cannot be applied yet: the file is opened at the index schema alone and
 * `ledger_pending` is logged, so the profile API still serves and the next start applies the
 * ledger once a default entity is set.
 */
export function openDataPlaneDb(
  path: string,
  log: DataPlane["log"]
): DatabaseSync {
  const index = openIndex(path)
  let defaultEntityId: string | null
  try {
    defaultEntityId = readDefaultEntityId(index)
  } finally {
    index.close()
  }
  try {
    return openDataDb(path, defaultEntityId === null ? {} : { defaultEntityId })
  } catch (error) {
    if (
      !(error instanceof LedgerError) ||
      error.code !== "default_entity_required"
    )
      throw error
    log("ledger_pending", { reason: error.code })
    return openIndex(path)
  }
}

/**
 * Opens eido-data.db, the gate clients and the profile store, whose audit sink is the gate's
 * POST /audit, and logs the configuration and variable names.
 */
export function runDataPlane(config: DataPlaneConfig, env: Env): DataPlane {
  const model = createModelQueueProvider(
    config.api.modelBaseUrl,
    config.api.chatTemplateKwargs
  )
  const parser =
    config.api.gmailProxyUrl === undefined
      ? undefined
      : gmailParser(config.dataDir)
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log: DataPlane["log"] = (event, fields = {}) => {
    appendFileSync(
      config.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
      { mode: 0o600 }
    )
  }
  const db = openDataPlaneDb(config.dbPath, log)
  const conversationIndex = openConversationIndex(
    join(dirname(config.dbPath), "conversation-index.db")
  )
  const conversationTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turns'"
    )
    .get()
  const conversation =
    conversationTables === undefined
      ? undefined
      : createConversationStore({ db, index: conversationIndex })
  const gate = createIntentClient({ socketPath: config.gateSocket })
  const audit = createAuditClient({ socketPath: config.gateSocket })
  const profile = createProfileStore(db, { audit: audit.record })
  const obligations = createObligationStateStore(db, { audit: audit.record })
  let digestService: DigestService | undefined
  let digestServicePromise: Promise<DigestService> | undefined
  const getDigestService = async (): Promise<DigestService> => {
    if (digestServicePromise === undefined) {
      digestServicePromise = Promise.all([model.getQueue(), model.getModelId()])
        .then(([queue, modelId]) => {
          digestService = createDigestService({
            db,
            queue,
            modelId,
            config: { sectionTokens: config.api.digest.sectionTokens },
            onError: (error) =>
              log("digest_build_failed", {
                reason:
                  error instanceof Error ? error.message : "unknown error",
              }),
          })
          return digestService
        })
        .catch((error: unknown) => {
          digestServicePromise = undefined
          throw error
        })
    }
    return digestServicePromise
  }
  let digestScheduling = Promise.resolve()
  let replyScheduling = Promise.resolve()
  const scheduleReplies = (): void => {
    const repliesConfig = config.api.replies
    if (repliesConfig === undefined) return
    replyScheduling = replyScheduling.then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        const result = syncReplyObligations(new Date(), {
          ...repliesConfig,
          db,
        })
        if (result.created > 0 || result.resolved > 0)
          log("reply_obligations_synced", {
            created: String(result.created),
            resolved: String(result.resolved),
          })
      } catch (error) {
        log("reply_obligations_sync_failed", {
          reason: error instanceof Error ? error.message : "unknown error",
        })
      }
    })
  }
  const onIngested = (documents: readonly IndexedDocument[]): void => {
    digestScheduling = digestScheduling.then(async () => {
      try {
        scheduleIngestedDigests(db, await getDigestService(), documents)
      } catch (error) {
        log("digest_schedule_failed", {
          reason: error instanceof Error ? error.message : "unknown error",
        })
      }
    })
  }
  let stopGmailSync: () => void = () => {}
  let gmailSyncInFlight: Promise<void> | undefined
  if (config.api.gmailProxyUrl !== undefined) {
    if (parser === undefined) {
      throw new Error(
        "Gmail sync requires a configured sandboxed document parser"
      )
    }
    const sync = createGmailSyncRuntime({
      db,
      gate,
      profile,
      client: createGmailClient(
        createGmailEgressTransport({ proxyUrl: config.api.gmailProxyUrl })
      ),
      parser,
      onIngested,
      onBatchCommitted: scheduleReplies,
      log,
    })
    const runSync = (): void => {
      const current = sync()
      gmailSyncInFlight = current
      const clear = (): void => {
        if (gmailSyncInFlight === current) gmailSyncInFlight = undefined
      }
      void current.then(clear, clear)
    }
    const timer = setInterval(runSync, GMAIL_SYNC_INTERVAL_MS)
    timer.unref()
    stopGmailSync = () => clearInterval(timer)
    runSync()
  }
  scheduleReplies()
  log("started", {
    dataDir: config.dataDir,
    db: config.dbPath,
    gateSocket: config.gateSocket,
    env: Object.keys(env).sort().join(","),
  })
  return {
    db,
    ...(conversation === undefined ? {} : { conversation }),
    conversationIndex,
    gate,
    profile,
    obligations,
    log,
    stopGmailSync,
    getInferenceQueue: model.getQueue,
    getModelContextTokens: model.getContextTokens,
    scheduleIngestedDocuments: onIngested,
    scheduleReplyObligations: scheduleReplies,
    close: async () => {
      stopGmailSync()
      await gmailSyncInFlight
      await digestScheduling
      await replyScheduling
      await digestService?.whenIdle()
      await profile.drain()
      await obligations.drain()
      conversationIndex.close()
      db.close()
      log("stopped")
    },
  }
}

/** Starts core's API for `plane` and logs where it listens. */
export async function serveDataPlane(
  plane: DataPlane,
  config: CoreApiConfig
): Promise<CoreApi> {
  const modelBaseUrl = config.modelBaseUrl
  const conversation = plane.conversation
  const getQueue = plane.getInferenceQueue
  const ask =
    modelBaseUrl === undefined
      ? undefined
      : async (question: string) => {
          if (conversation === undefined) {
            if (question.trim() === "/compact") {
              return compactAskResult("Nothing to compact yet")
            }
            return askPipeline(question, plane.db, await getQueue())
          }
          const queue = await getQueue()
          const conversationId = "ask"
          const askBudgetTokens = Math.max(
            1,
            Math.min(
              ASK_CONTEXT_BUDGET_TOKENS,
              Math.floor(plane.getModelContextTokens() / 2)
            )
          )
          const compactOptions = {
            thresholdTokens: Math.max(1, Math.floor(askBudgetTokens / 2)),
            keepRecentTokens: Math.max(1, Math.floor(askBudgetTokens / 4)),
          }
          const command = await dispatchCommand(question, conversationId, {
            store: conversation,
            queue,
            options: compactOptions,
          })
          if (command.handled) {
            return compactAskResult(command.reply)
          }
          const priorTurns = conversation.getTurns(conversationId)
          conversation.appendTurn(conversationId, {
            id: randomUUID(),
            role: "user",
            text: question,
            at: new Date().toISOString(),
            sources: [],
          })
          const compacted = await compactConversation(
            priorTurns,
            compactOptions,
            { queue }
          )
          const result = await askPipeline(question, plane.db, queue, {
            budgetTokens: askBudgetTokens,
            conversation: compacted.turns,
            allocateSourceTag: (sourceRef) =>
              conversation.allocateSourceTag(conversationId, sourceRef),
          })
          conversation.appendTurn(conversationId, {
            id: randomUUID(),
            role: "assistant",
            text: result.answer,
            at: new Date().toISOString(),
            sources: result.citations.map((citation) => citation.tag),
          })
          return result
        }
  let sweeping = false
  const sweep = async (): Promise<void> => {
    if (
      sweeping ||
      modelBaseUrl === undefined ||
      plane.conversation === undefined
    )
      return
    sweeping = true
    try {
      const result = await runDigestSweep(plane.conversation, {
        queue: await getQueue(),
        now: () => new Date(),
        config: {
          digestIdleTtlMinutes: config.conversationDigestIdleTtlMinutes,
        },
      })
      if (result.failed.length > 0) {
        plane.log("conversation_digest_sweep_failed", {
          count: String(result.failed.length),
        })
      }
    } catch {
      plane.log("conversation_digest_sweep_failed", { count: "unknown" })
    } finally {
      sweeping = false
    }
  }
  const stopDigestTimer = startConversationDigestTimer(sweep)
  const api = await listenCoreApi({
    profile: plane.profile,
    obligations: plane.obligations,
    connectorHealth: plane.gate.getConnectorHealth,
    ...(ask === undefined ? {} : { ask }),
    documents: { db: plane.db },
    ...config,
  })
  const closeApi = api.close.bind(api)
  api.close = async () => {
    stopDigestTimer()
    await closeApi()
  }
  plane.log("listening", {
    host: api.host,
    port: String(api.port),
    basePath: config.basePath,
    allowedHosts: api.allowedHosts.join(","),
  })
  return api
}

function askPipeline(
  question: string,
  db: DatabaseSync,
  queue: ReturnType<typeof createInferenceQueue>,
  conversation: Partial<
    Pick<AskDeps, "budgetTokens" | "conversation" | "allocateSourceTag">
  > = {}
) {
  return ask(question, {
    db,
    queue,
    budgetTokens: conversation.budgetTokens ?? ASK_CONTEXT_BUDGET_TOKENS,
    ...conversation,
  })
}

function compactAskResult(answer: string) {
  return {
    status: "answered" as const,
    answer,
    citations: [],
    coverage: {
      searched: 0,
      matched: 0,
      readInFull: 0,
      label: coverageLabel(0, 0),
    },
    facts: { matchCount: 0 },
    figures: [
      { key: "matched", value: 0, location: "/coverage/matched" },
      { key: "searched", value: 0, location: "/coverage/searched" },
      { key: "readInFull", value: 0, location: "/coverage/readInFull" },
    ] satisfies AskFigure[],
    followUps: [],
    droppedTags: [],
    possiblyTruncated: false,
  }
}

const SIGNALS = ["SIGTERM", "SIGINT"] as const
type Signal = (typeof SIGNALS)[number]

export type Launch =
  | { kind: "reexec"; args: string[]; env: Record<string, string> }
  | { kind: "run" }

/**
 * Re-run with only the allowlisted variables when the environment holds anything else, once:
 * the re-run process carries SCRUBBED_FLAG and never re-runs again.
 */
export function launchPlan(
  argv: readonly string[],
  execArgv: readonly string[],
  env: Env
): Launch {
  if (argv.includes(SCRUBBED_FLAG) || outsideAllowlist(env).length === 0) {
    return { kind: "run" }
  }
  return {
    kind: "reexec",
    args: [...execArgv, ...argv.slice(1), SCRUBBED_FLAG],
    env: dataPlaneEnv(env),
  }
}

type SignalSource = { once: (signal: Signal, listener: () => void) => unknown }

/**
 * The listening API keeps the process up. On the first stop signal it stops taking requests,
 * then closes the data plane once its queued store calls settle, even when closing the API fails;
 * resolves once both are closed.
 */
export function holdUntilStopped(
  plane: DataPlane,
  api: CoreApi,
  signals: SignalSource
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopped = false
    for (const signal of SIGNALS) {
      signals.once(signal, () => {
        if (stopped) return
        stopped = true
        const stop = async (): Promise<void> => {
          try {
            await api.close()
          } finally {
            await plane.close()
          }
        }
        stop().then(resolve, reject)
      })
    }
  })
}

type Child = {
  kill: (signal: Signal) => unknown
  once: (event: "exit", listener: (code: number | null) => void) => unknown
}
type Parent = {
  on: (signal: Signal, listener: () => void) => unknown
  exit: (code: number) => void
}

/** Passes stop signals on to the re-run process and exits with its exit code. */
export function forwardTo(child: Child, parent: Parent): void {
  for (const signal of SIGNALS) parent.on(signal, () => child.kill(signal))
  child.once("exit", (code) => parent.exit(code ?? 1))
}

if (import.meta.main) {
  const plan = launchPlan(process.argv, process.execArgv, process.env)
  if (plan.kind === "reexec") {
    const child = spawn(process.execPath, plan.args, {
      env: plan.env,
      stdio: "inherit",
    })
    forwardTo(child, process)
  } else {
    const config = dataPlaneConfig(process.env)
    const plane = runDataPlane(config, process.env)
    await holdUntilStopped(
      plane,
      await serveDataPlane(plane, config.api),
      process
    )
  }
}
