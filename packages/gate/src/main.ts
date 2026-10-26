import { mkdirSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { createProtonBridge } from "./internal/bridge/bridge"
import { PROTON_CONNECTOR, bridgeConfig } from "./internal/bridge/config"
import type { BridgeConfig } from "./internal/bridge/config"
import { BRIDGE_WRITERS, bridgeTransport } from "./internal/bridge/writers"
import { gmailWriteTransport } from "./internal/gmail-transport"
import { GMAIL_CONNECTOR, GMAIL_WRITERS } from "./internal/gmail-writers"
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
import { phoneHandler } from "./internal/phone-routes"
import { controlHandler, dataPlaneHandler } from "./internal/routes"
import type { Clock } from "./internal/sessions"
import { runningGate, startGate, stopGate } from "./internal/runtime"
import { OWNER_CONFIG_FILE } from "./internal/policy"
import { devFlagFromEnv, FileVault } from "./internal/vault/file-vault"
import type { WebAuthnConfig } from "./internal/webauthn"

// The gate process (ADR 0003). It owns eido-control.db and opens no other database. It
// listens on two local sockets: the data-plane socket, the only path the data plane is given,
// and the control socket, which stays outside the data plane's configuration. When
// EIDO_GATE_PHONE_PORT is set it also listens on one loopback TCP port, the phone listener
// (#85) that `tailscale serve` forwards /api/gate to. Start it with
// `pnpm --filter @eido/gate start`.

export const CONTROL_DB_FILE = "eido-control.db"
export const GATE_LOG_FILE = "gate.log"

// The data-plane socket is group-accessible so the data-plane user can be given it (#70); the
// control socket is the gate user's alone.
const DATA_PLANE_SOCKET_MODE = 0o660
const CONTROL_SOCKET_MODE = 0o600

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
  gmail?: { vaultPath: string; devVault: boolean; clientId: string }
}

export type BridgeListenerConfig = {
  config: BridgeConfig
  /**
   * The development vault file holding the Bridge password. The Keychain vault (#67) replaces
   * it; until then Bridge needs EIDO_DEV_VAULT=1 and EIDO_GATE_VAULT_FILE.
   */
  vaultPath: string
  devVault: boolean
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
  const config: GateConfig = {
    dataDir: read(REQUIRED.dataDir),
    socketPath: read(REQUIRED.socketPath),
    controlSocketPath: read(REQUIRED.controlSocketPath),
    webAuthn: { rpId: read(REQUIRED.rpId), origin: read(REQUIRED.origin) },
  }
  const port = env["EIDO_GATE_PHONE_PORT"] ?? ""
  const bridge = bridgeConfig(env)
  const gmailClientId = env["EIDO_GMAIL_CLIENT_ID"] ?? ""
  const gmailVaultPath = env["EIDO_GATE_VAULT_FILE"] ?? ""
  if (gmailClientId !== "" && gmailVaultPath === "")
    throw new Error("Gmail needs EIDO_GATE_VAULT_FILE")
  return {
    ...config,
    ...(port === "" ? {} : { phone: phoneConfig(env, port) }),
    ...(bridge === undefined ? {} : { bridge: bridgeVault(env, bridge) }),
    ...(gmailClientId === ""
      ? {}
      : {
          gmail: {
            vaultPath: gmailVaultPath,
            devVault: devFlagFromEnv({ ...env }),
            clientId: gmailClientId,
          },
        }),
  }
}

function bridgeVault(
  env: Readonly<Record<string, string | undefined>>,
  config: BridgeConfig
): BridgeListenerConfig {
  const vaultPath = env["EIDO_GATE_VAULT_FILE"] ?? ""
  if (vaultPath === "") {
    throw new Error(
      "Bridge needs EIDO_GATE_VAULT_FILE, the development vault holding its password, until the Keychain vault (#67)"
    )
  }
  return { config, vaultPath, devVault: devFlagFromEnv({ ...env }) }
}

// The production host, base path and allowed hosts wait on the serve measurements (#178).
function phoneConfig(
  env: Readonly<Record<string, string | undefined>>,
  port: string
): PhoneListenerConfig {
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
    throw new Error(
      `EIDO_GATE_PHONE_PORT must be a port number, not ${JSON.stringify(port)}`
    )
  }
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
  close: () => Promise<void>
}

/**
 * Opens the control DB, loads the policy and listens on both sockets, and on the phone port
 * when configured. `now` is the session clock; tests move it.
 */
export async function runGate(
  config: GateConfig,
  now: Clock = () => new Date()
): Promise<RunningGate> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log = fileLog(join(config.dataDir, GATE_LOG_FILE))
  const db: DatabaseSync = openControlDb(join(config.dataDir, CONTROL_DB_FILE))
  const servers: Server[] = []
  let phone: RunningGate["phone"]
  try {
    // Owner addresses and allowed roots come from the gate-owned owner-config.json (#167).
    // No stored-attendee reader
    // is wired until the calendar connector's record exists (#21), so every calendar edit and
    // delete needs approval.
    const overlayErrors = startGate(
      db,
      {
        dataDir: config.dataDir,
        ownerAddresses: [],
        allowedRoots: [],
        ownerConfigPath: join(config.dataDir, OWNER_CONFIG_FILE),
      },
      config.webAuthn
    )
    const state = () => runningGate()
    // FileVault refuses to open without the explicit development flag.
    const mail =
      config.bridge === undefined
        ? undefined
        : createProtonBridge({
            config: config.bridge.config,
            vault: new FileVault({
              path: config.bridge.vaultPath,
              devFlag: config.bridge.devVault,
            }),
          })
    // Register only gate-owned adapters. A missing Bridge still takes a Proton intent through
    // the executor, where the attempted write is claimed and its failure is recorded.
    const protonTransport =
      mail === undefined
        ? () => Promise.reject(new Error("Bridge is not configured"))
        : bridgeTransport(mail)
    const gmail =
      config.gmail === undefined
        ? undefined
        : gmailWriteTransport({
            db,
            vault: new FileVault({
              path: config.gmail.vaultPath,
              devFlag: config.gmail.devVault,
            }),
            clientId: config.gmail.clientId,
          })
    const executor = createExecutor(
      db,
      [...BRIDGE_WRITERS, ...GMAIL_WRITERS],
      (request) =>
        request.connector === GMAIL_CONNECTOR
          ? gmail === undefined
            ? Promise.reject(new Error("Gmail is not configured"))
            : gmail(request)
          : request.connector === PROTON_CONNECTOR
            ? protonTransport(request)
            : Promise.reject(new Error("no write transport for connector"))
    )
    const execute = (id: string) => executor.execute(id)
    const dataPlane = createGateServer(
      "data-plane",
      dataPlaneHandler(state, mail, execute),
      log
    )
    const control = createGateServer("control", controlHandler(state), log)
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
    log("started", {
      socket: config.socketPath,
      controlSocket: config.controlSocketPath,
      phonePort: phone?.port ?? "off",
      mail: mail === undefined ? "off" : "bridge",
      overlayErrors: overlayErrors.length,
    })
  } catch (error) {
    await Promise.all(servers.filter((s) => s.listening).map(close))
    stopGate()
    db.close()
    throw error
  }
  return {
    ...(phone === undefined ? {} : { phone }),
    close: async () => {
      await Promise.all(servers.map(close))
      stopGate()
      db.close()
      log("stopped")
    },
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
