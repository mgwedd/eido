import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, test } from "vitest"
import {
  SupervisorRequestError,
  SupervisorUnavailableError,
  createSupervisorClient,
} from "./supervisor-client"
import { socketAddress } from "./test-fixtures"

type Route = { status: number; body: unknown; delayMs?: number }

const JOBS = {
  processes: [{ name: "core", state: "starting", controllable: true }],
  tasks: [],
}
const HASH = "b".repeat(64)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A stand-in supervisor that answers `routes` by "METHOD /path" and records each request. */
async function supervisor(routes: Record<string, Route>) {
  const dir = mkdtempSync(join(tmpdir(), "sv-client-"))
  const socketPath = socketAddress(dir, "supervisor.sock")
  const seen: string[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const key = `${req.method} ${req.url}`
      seen.push(`${key} ${Buffer.concat(chunks).toString("utf8")}`.trim())
      const route = routes[key] ?? {
        status: 404,
        body: { error: "not_found", message: key },
      }
      setTimeout(() => {
        res.writeHead(route.status, { "content-type": "application/json" })
        res.end(
          typeof route.body === "string"
            ? route.body
            : JSON.stringify(route.body)
        )
      }, route.delayMs ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(() => {
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { socketPath, seen }
}

describe("createSupervisorClient", () => {
  test("sends the job request and returns the checked status", async () => {
    const s = await supervisor({
      "POST /jobs/restart": { status: 202, body: JOBS },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    expect(await client.restart(["core", "llama"])).toEqual(JOBS)
    expect(s.seen).toEqual(['POST /jobs/restart {"names":["core","llama"]}'])
  })

  test("reads and writes settings against the hash", async () => {
    const settings = { sha256: HASH, settings: { EIDO_WEB_PORT: "3001" } }
    const s = await supervisor({
      "GET /settings": { status: 200, body: { sha256: null, settings: {} } },
      "POST /settings": { status: 200, body: settings },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    expect(await client.settings()).toEqual({ sha256: null, settings: {} })
    expect(
      await client.writeSettings({
        expectedSha256: null,
        set: { EIDO_WEB_PORT: "3001" },
      })
    ).toEqual(settings)
    expect(s.seen[1]).toBe(
      'POST /settings {"expectedSha256":null,"set":{"EIDO_WEB_PORT":"3001"}}'
    )
  })

  test("calls each route by its fixed path", async () => {
    const models = { active: "m", profiles: [] }
    const s = await supervisor({
      "GET /doctor": { status: 200, body: { checks: [] } },
      "GET /jobs": { status: 200, body: JOBS },
      "POST /jobs/start": { status: 202, body: JOBS },
      "POST /jobs/stop": { status: 202, body: JOBS },
      "GET /models": { status: 200, body: models },
      "POST /models/use": { status: 200, body: models },
      "POST /models/fetch": { status: 202, body: JOBS },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    expect(await client.doctor()).toEqual({ checks: [] })
    expect(await client.jobs()).toEqual(JOBS)
    expect(await client.start(["llama"])).toEqual(JOBS)
    expect(await client.stop(["core"])).toEqual(JOBS)
    expect(await client.models()).toEqual(models)
    expect(await client.useModel("m")).toEqual(models)
    expect(await client.fetchModel("m")).toEqual(JOBS)
    expect(s.seen).toEqual([
      "GET /doctor",
      "GET /jobs",
      'POST /jobs/start {"names":["llama"]}',
      'POST /jobs/stop {"names":["core"]}',
      "GET /models",
      'POST /models/use {"id":"m"}',
      'POST /models/fetch {"id":"m"}',
    ])
  })

  test("reads and sets start at login, and raises unsupported off macOS (#664)", async () => {
    const s = await supervisor({
      "GET /login-item": { status: 200, body: { enabled: false } },
      "POST /login-item": { status: 200, body: { enabled: true } },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    expect(await client.loginItem()).toEqual({ enabled: false })
    expect(await client.setLoginItem(true)).toEqual({ enabled: true })
    expect(s.seen).toEqual([
      "GET /login-item",
      'POST /login-item {"enabled":true}',
    ])
    const linux = await supervisor({
      "GET /login-item": {
        status: 501,
        body: { error: "unsupported", message: "macOS only" },
      },
    })
    const off = createSupervisorClient({ socketPath: linux.socketPath })
    await expect(off.loginItem()).rejects.toMatchObject({
      status: 501,
      code: "unsupported",
    })
  })

  test("rejects a start at login reply that is not a boolean", async () => {
    const s = await supervisor({
      "GET /login-item": { status: 200, body: { enabled: "yes" } },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    await expect(client.loginItem()).rejects.toMatchObject({
      code: "bad_response",
    })
  })

  test("raises the supervisor's refusal with its code", async () => {
    const s = await supervisor({
      "POST /settings": {
        status: 409,
        body: { error: "stale_settings", message: "read it again" },
      },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    const error = await client
      .writeSettings({ expectedSha256: HASH, set: {} })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SupervisorRequestError)
    expect(error).toMatchObject({
      status: 409,
      code: "stale_settings",
      message: "read it again",
    })
  })

  test("rejects a reply that fails its schema, success or refusal", async () => {
    const s = await supervisor({
      "GET /jobs": {
        status: 200,
        body: {
          processes: [{ name: "vault", state: "running", controllable: false }],
          tasks: [],
        },
      },
      "GET /models": { status: 200, body: "not json" },
      "GET /doctor": { status: 500, body: { error: "teapot", message: "x" } },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    await expect(client.jobs()).rejects.toMatchObject({
      code: "bad_response",
      message: "the supervisor's response is not a StackJobStatus",
    })
    await expect(client.models()).rejects.toMatchObject({
      code: "bad_response",
    })
    await expect(client.doctor()).rejects.toMatchObject({
      status: 500,
      code: "bad_response",
      message: "the supervisor's refusal is not a StackError",
    })
  })

  test("rejects a 200 where the route answers 202", async () => {
    const s = await supervisor({
      "POST /jobs/stop": { status: 200, body: JOBS },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    await expect(client.stop(["core"])).rejects.toMatchObject({
      code: "bad_response",
    })
  })

  test("times out after 2 s by default", async () => {
    const s = await supervisor({
      "GET /jobs": { status: 200, body: JOBS, delayMs: 2500 },
    })
    const client = createSupervisorClient({ socketPath: s.socketPath })
    const started = Date.now()
    await expect(client.jobs()).rejects.toBeInstanceOf(
      SupervisorUnavailableError
    )
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(1900)
    expect(waited).toBeLessThan(2400)
  })

  test("reports an absent supervisor as unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sv-client-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const client = createSupervisorClient({
      socketPath: socketAddress(dir, "supervisor.sock"),
    })
    await expect(client.jobs()).rejects.toThrow(
      "the stack supervisor is not reachable"
    )
  })
})
