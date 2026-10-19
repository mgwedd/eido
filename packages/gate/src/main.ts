import { mkdirSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { openControlDb } from "./internal/control-db"
import { close, createGateServer, listen } from "./internal/http"
import { fileLog } from "./internal/log"
import { controlHandler, dataPlaneHandler } from "./internal/routes"
import { runningGate, startGate, stopGate } from "./internal/runtime"
import type { WebAuthnConfig } from "./internal/webauthn"

// The gate process (ADR 0003). It owns eido-control.db and opens no other database. It
// listens on two local sockets and no TCP port: the data-plane socket, the only path the data
// plane is given, and the control socket, which stays outside the data plane's configuration.
// Start it with `pnpm --filter @eido/gate start`.

export const CONTROL_DB_FILE = "eido-control.db"
export const GATE_LOG_FILE = "gate.log"

// The data-plane socket is group-accessible so the data-plane user can be given it (#70); the
// control socket is the gate user's alone.
const DATA_PLANE_SOCKET_MODE = 0o660
const CONTROL_SOCKET_MODE = 0o600

export type GateConfig = {
  dataDir: string
  socketPath: string
  controlSocketPath: string
  webAuthn: WebAuthnConfig
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
  return {
    dataDir: read(REQUIRED.dataDir),
    socketPath: read(REQUIRED.socketPath),
    controlSocketPath: read(REQUIRED.controlSocketPath),
    webAuthn: { rpId: read(REQUIRED.rpId), origin: read(REQUIRED.origin) },
  }
}

export type RunningGate = { close: () => Promise<void> }

/** Opens the control DB, loads the policy and listens on both sockets. */
export async function runGate(config: GateConfig): Promise<RunningGate> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const log = fileLog(join(config.dataDir, GATE_LOG_FILE))
  const db: DatabaseSync = openControlDb(join(config.dataDir, CONTROL_DB_FILE))
  const servers: Server[] = []
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
    log("started", {
      socket: config.socketPath,
      controlSocket: config.controlSocketPath,
      overlayErrors: overlayErrors.length,
    })
  } catch (error) {
    await Promise.all(servers.filter((s) => s.listening).map(close))
    stopGate()
    db.close()
    throw error
  }
  return {
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
