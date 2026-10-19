import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GateUnavailableError } from "@eido/gate"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DATA_DB_FILE,
  DATA_PLANE_LOG_FILE,
  SCRUBBED_FLAG,
  dataPlaneConfig,
  dataPlaneEnv,
  forwardTo,
  holdUntilStopped,
  launchPlan,
  outsideAllowlist,
  runDataPlane,
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
    })
  })

  it("names every missing or empty variable", () => {
    expect(() => dataPlaneConfig({ EIDO_GATE_SOCKET: "" })).toThrow(
      "the data plane needs EIDO_DATA_DIR, EIDO_GATE_SOCKET"
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
    await expect(plane.gate.listPending()).rejects.toBeInstanceOf(
      GateUnavailableError
    )
    plane.close()
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

describe("holdUntilStopped", () => {
  it("closes the data plane on the first stop signal only", () => {
    const env = {
      EIDO_DATA_DIR: join(dir, "data"),
      EIDO_GATE_SOCKET: join(dir, "missing.sock"),
    }
    const plane = runDataPlane(dataPlaneConfig(env), env)
    const signals = new EventEmitter()
    holdUntilStopped(plane, signals)
    expect(plane.db.isOpen).toBe(true)
    signals.emit("SIGTERM")
    expect(plane.db.isOpen).toBe(false)
    expect(() => signals.emit("SIGINT")).not.toThrow()
    const events = readFileSync(
      join(env.EIDO_DATA_DIR, DATA_PLANE_LOG_FILE),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => field(JSON.parse(line), "event"))
    expect(events).toEqual(["started", "stopped"])
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
