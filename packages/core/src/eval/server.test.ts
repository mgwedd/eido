import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { readModelId } from "../inference/client"
import { startStubModelServer } from "../inference/stub-server"
import { freePort, stubChildCommand } from "./eval.test-support"
import { startServer } from "./server"

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function logFile(): string {
  dir = mkdtempSync(join(tmpdir(), "eido-eval-server-"))
  return join(dir, "server.log")
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url)
    return true
  } catch {
    return false
  }
}

describe("candidate server lifecycle", () => {
  test("starts the command, waits until /health answers, and stops it", async () => {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${String(port)}`
    const server = await startServer({
      baseUrl,
      command: stubChildCommand(port, "child-model", []),
      logFile: logFile(),
      readyTimeoutSeconds: 30,
      pollMs: 50,
    })
    expect(await readModelId(baseUrl)).toBe("child-model")
    await server.stop()
    expect(await reachable(`${baseUrl}/health`)).toBe(false)
    await server.stop()
  })

  test("refuses to start when a server already answers at the address", async () => {
    const stub = await startStubModelServer({ replies: [] })
    try {
      await expect(
        startServer({
          baseUrl: stub.url,
          command: [process.execPath, "-e", ""],
          logFile: logFile(),
        })
      ).rejects.toThrow(`a server already answers at ${stub.url}`)
    } finally {
      await stub.close()
    }
  })

  test("reports a command that exits before it is ready, with its log", async () => {
    const port = await freePort()
    const log = logFile()
    await expect(
      startServer({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        command: [
          process.execPath,
          "-e",
          "console.error('weights not found'); process.exit(3)",
        ],
        logFile: log,
        pollMs: 50,
      })
    ).rejects.toThrow("exited (3) before it was ready")
    expect(readFileSync(log, "utf8")).toContain("weights not found")
  })

  test("stops a command that is not ready in time", async () => {
    const port = await freePort()
    await expect(
      startServer({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        logFile: logFile(),
        readyTimeoutSeconds: 0.3,
        pollMs: 50,
      })
    ).rejects.toThrow("was not ready")
  })

  test("reports a command that cannot be started", async () => {
    const port = await freePort()
    await expect(
      startServer({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        command: [join(tmpdir(), "no-such-llama-server")],
        logFile: logFile(),
        pollMs: 50,
      })
    ).rejects.toThrow("could not start")
  })

  test("refuses an empty command", async () => {
    const port = await freePort()
    await expect(
      startServer({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        command: [],
        logFile: logFile(),
      })
    ).rejects.toThrow("server command is empty")
  })
})
