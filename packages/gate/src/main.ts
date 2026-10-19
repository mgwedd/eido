import { mkdirSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { openControlDb } from "./internal/control-db"
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
  if (port === "") return config
  return { ...config, phone: phoneConfig(env, port) }
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
    // Owner addresses and allowed roots come from the gate's settings (#167); until then
    // calendar guests need approval and file intents are forbidden.
    const overlayErrors = startGate(
      db,
      { dataDir: config.dataDir, ownerAddresses: [], allowedRoots: [] },
      config.webAuthn
    )
    const state = () => runningGate()
    const dataPlane = createGateServer(
      "data-plane",
      dataPlaneHandler(state),
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
