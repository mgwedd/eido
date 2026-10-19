import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createIntentClient } from "./internal/client"
import { runningGate } from "./internal/runtime"
import { WEBAUTHN } from "./internal/test-fixtures"
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
})
