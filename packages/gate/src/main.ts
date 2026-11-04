import { mkdirSync } from "node:fs"
import type { Server } from "node:http"
import { isAbsolute, join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { createProtonBridge } from "./internal/bridge/bridge"
import {
  PROTON_CALENDAR_CONNECTOR,
  PROTON_CONNECTOR,
  bridgeConfig,
} from "./internal/bridge/config"
import type { BridgeConfig } from "./internal/bridge/config"
import { BRIDGE_WRITERS, bridgeTransport } from "./internal/bridge/writers"
import { gmailProbe, gmailWriteTransport } from "./internal/gmail-transport"
import { bridgeProbe } from "./internal/connector-connect"
import type {
  ConnectorProbe,
  ConnectorProbes,
} from "./internal/connector-connect"
import { egressProbe, startEgressProxy } from "./internal/egress"
import { GMAIL_CONNECTOR, GMAIL_WRITERS } from "./internal/gmail-writers"
import { THINGS_CONNECTOR } from "./internal/things/things-routes"
import { createThingsReads } from "./internal/things/things-adapter"
import {
  THINGS_WRITERS,
  createThingsTransport,
} from "./internal/things/things-writers"
import { openControlDb } from "./internal/control-db"
import { createExecutor } from "./internal/executor"
import {
  basePath,
  close,
  createGateServer,
  hostHeader,
  listen,
  listenTcp,
  loopbackHost,
} from "./internal/http"
import type { Handler, LoopbackHost } from "./internal/http"
import { fileLog } from "./internal/log"
import { defaultBackupStampPath } from "./internal/backup-status"
import { phoneHandler } from "./internal/phone-routes"
import { readReviewedManifest } from "./internal/repin"
import { createPushNotifier } from "./internal/push-notify"
import {
  generateVapidPrivateKey,
  vapidAuthorization,
  vapidPublicKey,
} from "./internal/push-crypto"
import { controlHandler, dataPlaneHandler } from "./internal/routes"
import type { Clock } from "./internal/sessions"
import { runningGate, startGate, stopGate } from "./internal/runtime"
import {
  OWNER_CONFIG_FILE,
  createStoredAttendeesReader,
} from "./internal/policy"
import type { StoredAttendees } from "./internal/policy"
import {
  globalCalendarTracker,
  type CalendarTracker,
} from "./internal/bridge/calendar"
import { fileHelper } from "./internal/files/file-helper"
import type { FileHelperConfig } from "./internal/files/file-helper"
import { createFileReads } from "./internal/files/file-reads"
import { assertFileHelperInstall } from "./internal/files/file-install"
import { devFlagFromEnv, FileVault } from "./internal/vault/file-vault"
import type { Vault } from "./internal/vault/vault"
import { KeychainVault } from "./internal/vault/keychain-vault"
import type { WebAuthnConfig } from "./internal/webauthn"
import { initializeProfileAudit } from "./internal/profile-audit"
import type { ProfileAudit } from "./internal/profile-audit"

// The gate process (ADR 0003). It owns eido-control.db and opens no other database. It
// listens on two local sockets: the data-plane socket, the only path the data plane is given,
// and the control socket, which stays outside the data plane's configuration. When
// EIDO_GATE_PHONE_PORT is set it also listens on one loopback TCP port, the phone listener
// (#85) that `tailscale serve` forwards /api/gate to. When a read connector's OAuth client is
// configured it also runs the read egress proxy (#14, #515) on its own loopback TCP port,
// EIDO_GATE_EGRESS_PORT: core's connectors send their reads there, and the gate adds the read
// client's token, refreshing it when it has expired. Start it with
// `pnpm --filter @eido/gate start`.

export const CONTROL_DB_FILE = "eido-control.db"
export const GATE_LOG_FILE = "gate.log"

// The data-plane socket is group-accessible so the data-plane user can be given it (#70); the
// control socket is the gate user's alone.
const DATA_PLANE_SOCKET_MODE = 0o660
const CONTROL_SOCKET_MODE = 0o600

export const DRIVE_CONNECTOR = "drive"
export const DRIVE_CLIENT_ID_ENV = "EIDO_DRIVE_CLIENT_ID"
export const GMAIL_READ_CLIENT_ID_ENV = "EIDO_GMAIL_READ_CLIENT_ID"
/**
 * The read connectors whose OAuth client the gate refreshes in the egress proxy: the variable
 * naming each client's id, and the pinned read its health probe makes.
 */
export const READ_CONNECTORS = [
  {
    connector: GMAIL_CONNECTOR,
    clientIdEnv: GMAIL_READ_CLIENT_ID_ENV,
    probeUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  },
  {
    connector: DRIVE_CONNECTOR,
    clientIdEnv: DRIVE_CLIENT_ID_ENV,
    probeUrl: "https://www.googleapis.com/drive/v3/changes/startPageToken",
  },
] as const
export const SIMPLEFIN_CONNECTOR = "simplefin"
export const SIMPLEFIN_ENV = "EIDO_GATE_SIMPLEFIN"
/**
 * The read connectors whose credential is an access URL in the vault (`auth: basic-url`, #51):
 * the variable that turns each on (set to 1), and the pinned read its health probe makes. The
 * probe asks for balances only, one request of the connector's daily budget.
 */
export const BASIC_URL_READ_CONNECTORS = [
  {
    connector: SIMPLEFIN_CONNECTOR,
    enableEnv: SIMPLEFIN_ENV,
    probeUrl: "https://bridge.simplefin.org/simplefin/accounts?balances-only=1",
  },
] as const
export const EGRESS_PORT_ENV = "EIDO_GATE_EGRESS_PORT"

export type EgressProxyConfig = {
  vault: VaultConfig
  /** 0 picks a free port. */
  port: number
  /** Each configured read connector's OAuth client id. */
  clientIds: Readonly<Record<string, string>>
  /** The configured basic-url read connectors. With clientIds, at least one read connector. */
  basicUrlConnectors?: readonly string[]
}

export type PhoneListenerConfig = {
  host: LoopbackHost
  /** 0 picks a free port. */
  port: number
  basePath: string
  /** Host headers answered besides the listen address itself, such as the one serve forwards. */
  allowedHosts: readonly string[]
}

export type GateConfig = {
  dataDir: string
  socketPath: string
  controlSocketPath: string
  webAuthn: WebAuthnConfig
  /** Absent when EIDO_GATE_PHONE_PORT is not set: the gate then has no TCP listener. */
  phone?: PhoneListenerConfig
  /** Absent when EIDO_BRIDGE_HOST is not set: the gate then serves no mail routes (#195). */
  bridge?: BridgeListenerConfig
  /** Gmail compose client: refresh/access tokens and the OAuth client secret live in this vault. */
  gmail?: { vault: VaultConfig; clientId: string }
  /** Absent when no read connector's client id is set: the gate then runs no egress proxy. */
  egress?: EgressProxyConfig
  profileAudit?: { vault: VaultConfig; epoch: string }
  push?: {
    vault: VaultConfig
    subject: string
    windowMs: number
    nudgeThreshold: number
    nudgeWindowMs: number
  }
  /** Native helper binary and its pinned SHA-256, both required for file execution. */
  fileHelper?: FileHelperConfig
  backupStampPath?: string
  /** The calendar connector's sent record tracker (#21, #290). */
  calendarTracker?: CalendarTracker
  /** Overrides the stored attendees reader for policy (#168, #290). */
  storedAttendees?: StoredAttendees
}

export type BridgeListenerConfig = {
  config: BridgeConfig
  vault: VaultConfig
}

export type VaultConfig =
  | { kind: "keychain"; path: string }
  | { kind: "file"; path: string; devFlag: boolean }

/** The gate vault the environment selects; the `connect` command (#98) uses the same rule. */
export function vaultConfig(
  env: Readonly<Record<string, string | undefined>>
): VaultConfig | undefined {
  const keychainPath = env["EIDO_GATE_KEYCHAIN_PATH"] ?? ""
  const filePath = env["EIDO_GATE_VAULT_FILE"] ?? ""
  const devVault = devFlagFromEnv({ ...env })
  if (keychainPath !== "" && filePath !== "")
    throw new Error(
      "Set only one of EIDO_GATE_KEYCHAIN_PATH or EIDO_GATE_VAULT_FILE"
    )
  if (keychainPath !== "") {
    if (!isAbsolute(keychainPath))
      throw new Error("EIDO_GATE_KEYCHAIN_PATH must be an absolute path")
    if (devVault)
      throw new Error(
        "EIDO_DEV_VAULT=1 cannot be used with EIDO_GATE_KEYCHAIN_PATH"
      )
    return { kind: "keychain", path: keychainPath }
  }
  if (filePath !== "") {
    if (!isAbsolute(filePath))
      throw new Error("EIDO_GATE_VAULT_FILE must be an absolute path")
    if (!devVault)
      throw new Error("EIDO_GATE_VAULT_FILE requires EIDO_DEV_VAULT=1")
    return { kind: "file", path: filePath, devFlag: true }
  }
  if (devVault) throw new Error("EIDO_DEV_VAULT=1 needs EIDO_GATE_VAULT_FILE")
  return undefined
}

export function createVault(config: VaultConfig): Vault {
  return config.kind === "keychain"
    ? new KeychainVault({ path: config.path })
    : new FileVault({ path: config.path, devFlag: config.devFlag })
}

const REQUIRED = {
  dataDir: "EIDO_GATE_DATA_DIR",
  socketPath: "EIDO_GATE_SOCKET",
  controlSocketPath: "EIDO_GATE_CONTROL_SOCKET",
  rpId: "EIDO_WEBAUTHN_RP_ID",
  origin: "EIDO_WEBAUTHN_ORIGIN",
} as const

/** Reads the gate's configuration from its environment; throws naming every missing variable. */
export function gateConfig(
  env: Readonly<Record<string, string | undefined>>
): GateConfig {
  const missing = Object.values(REQUIRED).filter(
    (name) => (env[name] ?? "") === ""
  )
  if (missing.length > 0) {
    throw new Error(`the gate needs ${missing.join(", ")}`)
  }
  const read = (name: string) => env[name] ?? ""
  const backupOverride =
    env["EIDO_BACKUP_STAMP_FILE"] ?? env["EIDO_BACKUP_LOG_DIR"]
  const backupStampPath =
    backupOverride !== undefined && backupOverride !== ""
      ? defaultBackupStampPath(env)
      : undefined
  const config: GateConfig = {
    dataDir: read(REQUIRED.dataDir),
    socketPath: read(REQUIRED.socketPath),
    controlSocketPath: read(REQUIRED.controlSocketPath),
    webAuthn: { rpId: read(REQUIRED.rpId), origin: read(REQUIRED.origin) },
    ...(backupStampPath === undefined ? {} : { backupStampPath }),
  }
  const port = env["EIDO_GATE_PHONE_PORT"] ?? ""
  const bridge = bridgeConfig(env)
  const gmailClientId = env["EIDO_GMAIL_CLIENT_ID"] ?? ""
  const vault = vaultConfig(env)
  const epoch = env["EIDO_PROFILE_AUDIT_EPOCH"] ?? "1"
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(epoch))
    throw new Error(
      "EIDO_PROFILE_AUDIT_EPOCH must be 1 to 64 letters, digits, underscores or hyphens"
    )
  if (env["EIDO_PROFILE_AUDIT_EPOCH"] !== undefined && vault === undefined)
    throw new Error("EIDO_PROFILE_AUDIT_EPOCH needs a configured gate vault")
  const pushSubject = env["EIDO_PUSH_VAPID_SUBJECT"] ?? ""
  const fileHelperPath = env["EIDO_FILE_HELPER_PATH"] ?? ""
  const fileHelperSha256 = env["EIDO_FILE_HELPER_SHA256"] ?? ""
  if ((fileHelperPath === "") !== (fileHelperSha256 === ""))
    throw new Error(
      "EIDO_FILE_HELPER_PATH and EIDO_FILE_HELPER_SHA256 must be set together"
    )
  if (fileHelperSha256 !== "" && !/^[a-f0-9]{64}$/.test(fileHelperSha256))
    throw new Error("EIDO_FILE_HELPER_SHA256 must be a lowercase SHA-256 pin")
  if (fileHelperPath !== "" && !isAbsolute(fileHelperPath))
    throw new Error("EIDO_FILE_HELPER_PATH must be an absolute path")
  const requireVault = (service: string): VaultConfig => {
    if (vault === undefined)
      throw new Error(
        `${service} needs EIDO_GATE_KEYCHAIN_PATH or EIDO_DEV_VAULT=1 with EIDO_GATE_VAULT_FILE`
      )
    return vault
  }
  const readClientIds = Object.fromEntries(
    READ_CONNECTORS.flatMap(({ connector, clientIdEnv }) => {
      const id = env[clientIdEnv] ?? ""
      return id === "" ? [] : [[connector, id]]
    })
  )
  const basicUrlConnectors = BASIC_URL_READ_CONNECTORS.flatMap(
    ({ connector, enableEnv }) => {
      const value = env[enableEnv] ?? ""
      if (value !== "" && value !== "1")
        throw new Error(`${enableEnv} must be 1 or unset`)
      return value === "1" ? [connector] : []
    }
  )
  const egressPort = env[EGRESS_PORT_ENV] ?? ""
  const hasReadClient =
    Object.keys(readClientIds).length > 0 || basicUrlConnectors.length > 0
  if (egressPort !== "" && !hasReadClient)
    throw new Error(
      `${EGRESS_PORT_ENV} needs a read connector: ${[
        ...READ_CONNECTORS.map((read) => read.clientIdEnv),
        ...BASIC_URL_READ_CONNECTORS.map((read) => `${read.enableEnv}=1`),
      ].join(" or ")}`
    )
  if (hasReadClient && egressPort === "")
    throw new Error(`a read connector needs ${EGRESS_PORT_ENV}`)
  const positive = (name: string, fallback: number): number => {
    const value = env[name]
    if (value === undefined || value === "") return fallback
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error(`${name} must be a positive integer`)
    return number
  }
  return {
    ...config,
    ...(fileHelperPath === ""
      ? {}
      : { fileHelper: { path: fileHelperPath, sha256: fileHelperSha256 } }),
    ...(vault === undefined ? {} : { profileAudit: { vault, epoch } }),
    ...(port === "" ? {} : { phone: phoneConfig(env, port) }),
    ...(bridge === undefined ? {} : { bridge: bridgeVault(env, bridge) }),
    ...(gmailClientId === ""
      ? {}
      : {
          gmail: {
            vault: requireVault("Gmail"),
            clientId: gmailClientId,
          },
        }),
    ...(hasReadClient
      ? {
          egress: {
            vault: requireVault("The read egress proxy"),
            port: portNumber(EGRESS_PORT_ENV, egressPort),
            clientIds: readClientIds,
            ...(basicUrlConnectors.length === 0 ? {} : { basicUrlConnectors }),
          },
        }
      : {}),
    ...(pushSubject === ""
      ? {}
      : {
          push: {
            vault: requireVault("Web Push"),
            subject: pushSubject,
            windowMs: positive("EIDO_PUSH_WINDOW_MS", 60_000),
            nudgeThreshold: positive("EIDO_APPROVAL_NUDGE_THRESHOLD", 5),
            nudgeWindowMs: positive("EIDO_APPROVAL_NUDGE_WINDOW_MS", 120_000),
          },
        }),
  }
}

function bridgeVault(
  env: Readonly<Record<string, string | undefined>>,
  config: BridgeConfig
): BridgeListenerConfig {
  const vault = vaultConfig(env)
  if (vault === undefined)
    throw new Error(
      "Bridge needs EIDO_GATE_KEYCHAIN_PATH or EIDO_DEV_VAULT=1 with EIDO_GATE_VAULT_FILE"
    )
  return { config, vault }
}

function portNumber(name: string, port: string): number {
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    throw new Error(
      `${name} must be a port number, not ${JSON.stringify(port)}`
    )
  }
  return Number(port)
}

// The production host, base path and allowed hosts wait on the serve measurements (#178).
function phoneConfig(
  env: Readonly<Record<string, string | undefined>>,
  port: string
): PhoneListenerConfig {
  portNumber("EIDO_GATE_PHONE_PORT", port)
  const allowed = env["EIDO_GATE_PHONE_ALLOWED_HOSTS"] ?? ""
  return {
    host: loopbackHost(env["EIDO_GATE_PHONE_HOST"] ?? "127.0.0.1"),
    port: Number(port),
    basePath: basePath(env["EIDO_GATE_PHONE_BASE_PATH"] ?? ""),
    allowedHosts: allowed
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== ""),
  }
}

export type RunningGate = {
  /** The phone listener's port and the Host headers it answers, when it runs. */
  phone?: { port: number; allowedHosts: readonly string[] }
  /** The read egress proxy's loopback port, when it runs. */
  egress?: { port: number }
  close: () => Promise<void>
}

/**
 * Opens the control DB, loads the policy and listens on both sockets, and on the phone port
 * when configured. `now` is the session clock; tests move it.
 */
export async function runGate(
  config: GateConfig,
  now: Clock = () => new Date(),
  vaultFactory: (config: VaultConfig) => Vault = createVault
): Promise<RunningGate> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log = fileLog(join(config.dataDir, GATE_LOG_FILE))
  const db: DatabaseSync = openControlDb(join(config.dataDir, CONTROL_DB_FILE))
  const servers: Server[] = []
  let notifier: ReturnType<typeof createPushNotifier> | undefined
  let phone: RunningGate["phone"]
  let egressProxy: Awaited<ReturnType<typeof startEgressProxy>> | undefined
  try {
    // Owner addresses and allowed roots come from the gate-owned owner-config.json (#167).
    // Stored attendees are read from the calendar connector's sent record (#21, #290).
    const tracker = config.calendarTracker ?? globalCalendarTracker
    const storedAttendees =
      config.storedAttendees ?? createStoredAttendeesReader(tracker)
    const overlayErrors = startGate(
      db,
      {
        dataDir: config.dataDir,
        ownerAddresses: [],
        allowedRoots: [],
        ownerConfigPath: join(config.dataDir, OWNER_CONFIG_FILE),
        storedAttendees,
      },
      config.webAuthn
    )
    const pushVault: Vault | undefined =
      config.push === undefined ? undefined : vaultFactory(config.push.vault)
    const vapidKey = {
      connector: "eido-web-push",
      kind: "api_key",
      client: "write",
    } as const
    const privateKey = async (): Promise<string | undefined> => {
      if (pushVault === undefined) return undefined
      let key = await pushVault.get(vapidKey)
      if (key === undefined) {
        key = generateVapidPrivateKey()
        await pushVault.set(vapidKey, key)
      }
      vapidPublicKey(key)
      return key
    }
    if (config.push !== undefined) {
      const key = await privateKey()
      if (key === undefined) throw new Error("Web Push key is unavailable")
      vapidAuthorization(
        "https://push.example.invalid/",
        key,
        config.push.subject
      )
      notifier = createPushNotifier({
        db,
        privateKey,
        subject: config.push.subject,
        fetch,
        now: () => now().getTime(),
        windowMs: config.push.windowMs,
      })
    }
    let profileAudit: ProfileAudit | undefined
    if (config.profileAudit !== undefined) {
      try {
        profileAudit = await initializeProfileAudit(
          db,
          vaultFactory(config.profileAudit.vault),
          config.profileAudit.epoch
        )
      } catch {
        log("profile_audit_unavailable", {})
      }
    }
    if (config.fileHelper !== undefined)
      await assertFileHelperInstall(config.fileHelper.path)
    const nativeFiles =
      config.fileHelper === undefined
        ? undefined
        : fileHelper(config.fileHelper)
    const fileReads =
      nativeFiles === undefined ? undefined : createFileReads(db, nativeFiles)
    // FileVault refuses to open without the explicit development flag.
    const mail =
      config.bridge === undefined
        ? undefined
        : createProtonBridge({
            config: config.bridge.config,
            vault: vaultFactory(config.bridge.vault),
          })
    const gmailOptions =
      config.gmail === undefined
        ? undefined
        : {
            db,
            vault: vaultFactory(config.gmail.vault),
            clientId: config.gmail.clientId,
          }
    const gmail =
      gmailOptions === undefined ? undefined : gmailWriteTransport(gmailOptions)
    const egressOptions =
      config.egress === undefined
        ? undefined
        : {
            db,
            vault: vaultFactory(config.egress.vault),
            clientIds: config.egress.clientIds,
          }
    const readProbes: Record<string, ConnectorProbe> =
      egressOptions === undefined
        ? {}
        : Object.fromEntries(
            READ_CONNECTORS.filter(
              ({ connector }) =>
                egressOptions.clientIds[connector] !== undefined
            ).map(({ connector, probeUrl }) => [
              connector,
              egressProbe(egressOptions, connector, probeUrl),
            ])
          )
    const basicUrlConnectors = config.egress?.basicUrlConnectors ?? []
    if (egressOptions !== undefined)
      for (const { connector, probeUrl } of BASIC_URL_READ_CONNECTORS)
        if (basicUrlConnectors.includes(connector))
          readProbes[connector] = egressProbe(
            egressOptions,
            connector,
            probeUrl
          )
    const gmailProbes = [
      ...(gmailOptions === undefined ? [] : [gmailProbe(gmailOptions)]),
      ...(readProbes[GMAIL_CONNECTOR] === undefined
        ? []
        : [readProbes[GMAIL_CONNECTOR]]),
    ]
    // The checks the control socket runs after the owner connects a connector (#98). Both Proton
    // connectors sign in to Bridge with the one stored password. Gmail is healthy only when each
    // of its configured clients (compose and read) can make its read.
    const probes: ConnectorProbes = {
      ...readProbes,
      ...(gmailProbes.length === 0
        ? {}
        : { [GMAIL_CONNECTOR]: allProbes(gmailProbes) }),
      ...(mail === undefined
        ? {}
        : {
            [PROTON_CONNECTOR]: bridgeProbe(mail),
            [PROTON_CALENDAR_CONNECTOR]: bridgeProbe(mail),
          }),
    }
    const state = () => ({
      probes,
      fileHelper: nativeFiles,
      files: fileReads,
      ...runningGate(),
      profileAudit,
      backupStampPath: config.backupStampPath ?? defaultBackupStampPath(),
      reviewedManifest: (connector: string) =>
        readReviewedManifest(config.dataDir, connector),
      notifyPending: notifier?.notifyPending,
      ...(config.push === undefined
        ? {}
        : {
            nudge: {
              threshold: config.push.nudgeThreshold,
              windowMs: config.push.nudgeWindowMs,
            },
            push: {
              publicKey: async () => vapidPublicKey((await privateKey()) ?? ""),
              notifyPending: () => notifier?.notifyPending(),
            },
          }),
    })
    // Register only gate-owned adapters. A missing Bridge still takes a Proton intent through
    // the executor, where the attempted write is claimed and its failure is recorded.
    const protonTransport =
      mail === undefined
        ? () => Promise.reject(new Error("Bridge is not configured"))
        : bridgeTransport(mail, { tracker })
    const things = createThingsReads()
    const thingsTransport = createThingsTransport()
    const executor = createExecutor(
      db,
      [...BRIDGE_WRITERS, ...GMAIL_WRITERS, ...THINGS_WRITERS],
      (request) =>
        request.connector === GMAIL_CONNECTOR
          ? gmail === undefined
            ? Promise.reject(new Error("Gmail is not configured"))
            : gmail(request)
          : request.connector === PROTON_CONNECTOR ||
              request.connector === PROTON_CALENDAR_CONNECTOR
            ? protonTransport(request)
            : request.connector === THINGS_CONNECTOR
              ? thingsTransport(request)
              : Promise.reject(new Error("no write transport for connector")),
      nativeFiles
    )
    const execute = (id: string) => executor.execute(id)
    const dataPlane = createGateServer(
      "data-plane",
      dataPlaneHandler(state, mail, execute, things),
      log
    )
    const control = createGateServer("control", controlHandler(state, now), log)
    servers.push(dataPlane, control)
    await listen(dataPlane, config.socketPath, DATA_PLANE_SOCKET_MODE)
    await listen(control, config.controlSocketPath, CONTROL_SOCKET_MODE)
    if (config.phone !== undefined) {
      const options = config.phone
      // The listen address carries the port, known only once the server listens. Until then no
      // Host is allowed, so nothing is answered with anything but 421.
      const handlerFor = (allowedHosts: readonly string[]): Handler =>
        phoneHandler({
          gate: state,
          allowedHosts,
          basePath: options.basePath,
          now,
          execute,
          undo: (id) => executor.undo(id),
        })
      let handler = handlerFor([])
      const server = createGateServer(
        "phone",
        (request) => handler(request),
        log
      )
      servers.push(server)
      const port = await listenTcp(server, options.host, options.port)
      const listenHost = hostHeader(options.host, port)
      const allowedHosts = [
        listenHost,
        ...options.allowedHosts.filter((allowed) => allowed !== listenHost),
      ]
      handler = handlerFor(allowedHosts)
      phone = { port, allowedHosts }
    }
    if (egressOptions !== undefined && config.egress !== undefined) {
      egressProxy = await startEgressProxy({
        ...egressOptions,
        port: config.egress.port,
        now: () => now().getTime(),
      })
    }
    log("started", {
      socket: config.socketPath,
      controlSocket: config.controlSocketPath,
      phonePort: phone?.port ?? "off",
      egressPort: egressProxy?.port ?? "off",
      mail: mail === undefined ? "off" : "bridge",
      overlayErrors: overlayErrors.length,
    })
  } catch (error) {
    notifier?.close()
    await egressProxy?.close()
    await Promise.all(servers.filter((s) => s.listening).map(close))
    stopGate()
    db.close()
    throw error
  }
  return {
    ...(phone === undefined ? {} : { phone }),
    ...(egressProxy === undefined
      ? {}
      : { egress: { port: egressProxy.port } }),
    close: async () => {
      notifier?.close()
      await egressProxy?.close()
      await Promise.all(servers.map(close))
      stopGate()
      db.close()
      log("stopped")
    },
  }
}

/** One probe over several clients: the first outcome that is not ok, or ok. */
export function allProbes(probes: readonly ConnectorProbe[]): ConnectorProbe {
  return async () => {
    for (const probe of probes) {
      const outcome = await probe()
      if (outcome !== "ok") return outcome
    }
    return "ok"
  }
}

if (import.meta.main) {
  const gate = await runGate(gateConfig(process.env))
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void gate.close().then(() => process.exit(0))
    })
  }
}
