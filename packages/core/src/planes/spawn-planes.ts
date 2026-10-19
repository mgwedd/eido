import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { GateUnavailableError, createIntentClient } from "@eido/gate"
import { DATA_DB_FILE, DATA_PLANE_LOG_FILE, dataPlaneEnv } from "../main"

// Test harness (#42; reused by #43 and #56): starts the gate and the data plane as two real
// processes against temp databases and temp sockets, and tears them down. The gate's own
// files (main.ts, its TypeScript loader and its control DB test tool) are run by path as
// separate processes; nothing here imports gate internals.

const GATE_SRC = dirname(createRequire(import.meta.url).resolve("@eido/gate"))
const CORE_SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning", "--import"]

const GATE_MAIN = join(GATE_SRC, "main.ts")
const GATE_HOOKS = join(GATE_SRC, "ts-hooks.ts")
const GATE_TOOL = join(GATE_SRC, "internal", "control-db-tool.ts")
const CORE_MAIN = join(CORE_SRC, "main.ts")
const CORE_HOOKS = join(CORE_SRC, "ts-hooks.ts")
const PROBE = join(CORE_SRC, "planes", "probe.ts")

const READY_TIMEOUT_MS = 15_000
const POLL_MS = 50

/** A relying party for the gate's approval config; the tests never sign an approval. */
const WEBAUTHN_RP_ID = "eido.example.invalid"
const WEBAUTHN_ORIGIN = "https://eido.example.invalid"

export type PlanePaths = {
  gateDir: string
  dataDir: string
  controlDb: string
  dataDb: string
  gateSocket: string
  controlSocket: string
  gateLog: string
  dataPlaneLog: string
}

export type Planes = {
  paths: PlanePaths
  /** The environment the data plane is started with: the parent's, plus its allowlist. */
  dataPlaneStartEnv: Readonly<Record<string, string>>
  /** Runs one probe command in a short-lived data-plane process; resolves its JSON result. */
  probe: (...args: string[]) => Promise<unknown>
  /** The control DB's audit rows and intent ids, read by the gate's test tool. */
  inspectControlDb: () => Promise<unknown>
  /** Rejects a pending intent as the owner, through the gate's test tool. */
  rejectInGate: (intentId: string) => Promise<unknown>
  /** Stops the gate process and waits for it to exit. */
  stopGate: () => Promise<void>
  /** Stops both processes. */
  close: () => Promise<void>
}

export type SpawnPlanesOptions = {
  tmpDir: string
  /** Variables the data plane's parent holds; the data plane must not inherit them. */
  parentEnv?: Readonly<Record<string, string>>
}

function socketPath(tmpDir: string, name: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\eido-${name}-${String(process.pid)}-${String(Date.now())}`
    : join(tmpDir, `${name}.sock`)
}

function runNode(
  hooks: string,
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...NODE_FLAGS, hooks, file, ...args],
      { env, timeout: READY_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${file} failed: ${stderr || error.message}`))
          return
        }
        const parsed: unknown = JSON.parse(stdout)
        resolve(parsed)
      }
    )
  })
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => child.once("exit", () => resolve()))
}

async function stop(child: ChildProcess): Promise<void> {
  const done = exited(child)
  child.kill("SIGTERM")
  await done
}

async function waitFor(
  what: string,
  child: ChildProcess,
  ready: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${what} exited with ${String(child.exitCode)}`)
    }
    if (await ready()) return
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`${what} did not start within ${String(READY_TIMEOUT_MS)} ms`)
}

function logged(path: string, event: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => line.includes(`"event":"${event}"`))
}

/** Starts the gate (seeded with a synthetic mail connector) and then the data plane. */
export async function spawnPlanes(
  options: SpawnPlanesOptions
): Promise<Planes> {
  const gateDir = join(options.tmpDir, "gate")
  const dataDir = join(options.tmpDir, "data")
  mkdirSync(gateDir, { recursive: true, mode: 0o700 })
  const paths: PlanePaths = {
    gateDir,
    dataDir,
    controlDb: join(gateDir, "eido-control.db"),
    dataDb: join(dataDir, DATA_DB_FILE),
    gateSocket: socketPath(options.tmpDir, "gate"),
    controlSocket: socketPath(options.tmpDir, "control"),
    gateLog: join(gateDir, "gate.log"),
    dataPlaneLog: join(dataDir, DATA_PLANE_LOG_FILE),
  }
  // The gate's processes get only what they need too: nothing from the test runner's environment.
  const toolEnv = {}
  const tool = (...args: string[]) =>
    runNode(GATE_HOOKS, GATE_TOOL, args, toolEnv)
  await tool("seed", paths.controlDb)

  const gate = spawn(process.execPath, [...NODE_FLAGS, GATE_HOOKS, GATE_MAIN], {
    env: {
      ...toolEnv,
      EIDO_GATE_DATA_DIR: gateDir,
      EIDO_GATE_SOCKET: paths.gateSocket,
      EIDO_GATE_CONTROL_SOCKET: paths.controlSocket,
      EIDO_WEBAUTHN_RP_ID: WEBAUTHN_RP_ID,
      EIDO_WEBAUTHN_ORIGIN: WEBAUTHN_ORIGIN,
    },
    stdio: "inherit",
  })
  const client = createIntentClient({ socketPath: paths.gateSocket })
  const reachable = async () => {
    try {
      await client.listPending()
      return true
    } catch (error) {
      if (error instanceof GateUnavailableError) return false
      throw error
    }
  }

  const dataPlaneStartEnv = {
    ...options.parentEnv,
    EIDO_DATA_DIR: dataDir,
    EIDO_GATE_SOCKET: paths.gateSocket,
  }
  let dataPlane: ChildProcess | undefined
  try {
    await waitFor("the gate", gate, reachable)
    const started = spawn(
      process.execPath,
      [...NODE_FLAGS, CORE_HOOKS, CORE_MAIN],
      { env: dataPlaneStartEnv, stdio: "inherit" }
    )
    dataPlane = started
    await waitFor("the data plane", started, () =>
      Promise.resolve(logged(paths.dataPlaneLog, "started"))
    )
  } catch (error) {
    await Promise.all([gate, dataPlane].flatMap((c) => (c ? [stop(c)] : [])))
    throw error
  }
  const running = dataPlane

  return {
    paths,
    dataPlaneStartEnv,
    probe: (...args) =>
      runNode(CORE_HOOKS, PROBE, args, dataPlaneEnv(dataPlaneStartEnv)),
    inspectControlDb: () => tool("inspect", paths.controlDb),
    rejectInGate: (intentId) => tool("reject", paths.controlDb, intentId),
    stopGate: () => stop(gate),
    close: async () => {
      await Promise.all([stop(gate), stop(running)])
    },
  }
}
