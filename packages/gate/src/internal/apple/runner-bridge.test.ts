import type * as ChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSessionBridge } from "../session-bridge/client"
import {
  socketDir,
  startFakeSessionBridge,
} from "../session-bridge/fake-session-bridge.test-support"
import type { FakeAnswer } from "../session-bridge/fake-session-bridge.test-support"
import {
  APPLE_MAX_BYTES,
  APPLE_MAX_CONCURRENT,
  createAppleRunner,
} from "./runner"

// spawn keeps its real behaviour, so the direct runner still launches the synthetic Helper,
// but every call is recorded to prove the bridge path never spawns.
const spawned = vi.hoisted(() => ({ calls: 0 }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawned.calls += 1
      return actual.spawn(...args)
    },
  }
})
beforeEach(() => {
  spawned.calls = 0
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// A synthetic Helper that prints one fixed answer, pinned to its own bytes.
const ANSWER = {
  ok: true,
  result: {
    calendars: [
      { id: "cal-1", title: "Lorem é", writable: true },
      { id: "cal-2", title: "Ipsum", writable: false },
    ],
  },
}
function helper(): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "eido-apple-bridge-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "helper")
  writeFileSync(
    path,
    `#!/bin/sh\n/bin/cat >/dev/null\nprintf '%s' '${JSON.stringify(ANSWER)}'\n`,
    { mode: 0o700 }
  )
  return {
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }
}

async function fake(answer: (request: unknown) => FakeAnswer) {
  const { dir, remove } = socketDir()
  cleanups.push(remove)
  const bridge = await startFakeSessionBridge(answer, join(dir, "bridge.sock"))
  cleanups.push(bridge.close)
  return bridge
}

const request = { operation: "list_calendars", args: {} } as const
const darwin = { platform: "darwin" } as const

// The Helper and Unix sockets are macOS-only; these tests do not run on Windows.
const unix = process.platform === "win32" ? describe.skip : describe

unix("EventKit through the session bridge", () => {
  test("sends the checked request as an eventkit op and returns what the Helper would", async () => {
    const pin = helper()
    const direct = await createAppleRunner(pin, darwin)(request)
    expect(spawned.calls).toBe(1)
    spawned.calls = 0

    const bridge = await fake(() => ({ json: ANSWER }))
    const viaBridge = await createAppleRunner(pin, {
      ...darwin,
      bridge: createSessionBridge(bridge.socketPath),
    })(request)

    expect(viaBridge).toEqual(direct)
    expect(viaBridge).toEqual(ANSWER.result)
    expect(bridge.requests).toEqual([
      { op: "eventkit", request: { operation: "list_calendars", args: {} } },
    ])
    expect(spawned.calls).toBe(0)
  })

  test("a Helper whose bytes do not match the pin never reaches the bridge", async () => {
    const pin = helper()
    const bridge = await fake(() => ({ json: ANSWER }))
    const run = createAppleRunner(
      { path: pin.path, sha256: "0".repeat(64) },
      { ...darwin, bridge: createSessionBridge(bridge.socketPath) }
    )
    await expect(run(request)).rejects.toMatchObject({ code: "unavailable" })
    expect(bridge.connections()).toBe(0)
  })

  test("a request outside the schema never reaches the bridge", async () => {
    const bridge = await fake(() => ({ json: ANSWER }))
    const run = createAppleRunner(helper(), {
      ...darwin,
      bridge: createSessionBridge(bridge.socketPath),
    })
    await expect(
      run({
        operation: "list_events",
        args: { calendarId: "", start: "bad", end: "bad" },
      })
    ).rejects.toMatchObject({ code: "invalid_request" })
    expect(bridge.connections()).toBe(0)
  })

  test("a missing socket is session_unavailable and nothing is spawned", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const run = createAppleRunner(helper(), {
      ...darwin,
      bridge: createSessionBridge(join(dir, "absent.sock")),
    })
    await expect(run(request)).rejects.toMatchObject({
      name: "AppleError",
      code: "session_unavailable",
    })
    expect(spawned.calls).toBe(0)
  })

  test("a refused connection is session_unavailable and nothing is spawned", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const live = join(dir, "live.sock")
    const stale = join(dir, "stale.sock")
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(live, resolve))
    renameSync(live, stale)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const run = createAppleRunner(helper(), {
      ...darwin,
      bridge: createSessionBridge(stale),
    })
    await expect(run(request)).rejects.toMatchObject({
      code: "session_unavailable",
    })
    expect(spawned.calls).toBe(0)
  })

  test("the Helper's own refusal code passes through", async () => {
    const bridge = await fake(() => ({
      json: { ok: false, code: "not_found" },
    }))
    const run = createAppleRunner(helper(), {
      ...darwin,
      bridge: createSessionBridge(bridge.socketPath),
    })
    await expect(run(request)).rejects.toMatchObject({ code: "not_found" })
  })

  test.each([
    [
      "a bridge code the Helper does not use",
      { json: { ok: false, code: "unknown_op" } },
    ],
    ["an answer outside the schema", { json: { ok: true } }],
    [
      "an answer over the Helper's 1 MiB limit",
      { json: { ok: true, result: { pad: "x".repeat(APPLE_MAX_BYTES) } } },
    ],
    ["a dropped connection", { raw: Buffer.from([0, 0]) }],
  ] satisfies [string, FakeAnswer][])(
    "%s is unavailable",
    async (_name, answer) => {
      const bridge = await fake(() => answer)
      const run = createAppleRunner(helper(), {
        ...darwin,
        bridge: createSessionBridge(bridge.socketPath),
      })
      await expect(run(request)).rejects.toMatchObject({ code: "unavailable" })
    }
  )

  test("the deadline applies to the bridge call", async () => {
    const bridge = await fake(() => ({ hang: true }))
    const run = createAppleRunner(helper(), {
      ...darwin,
      timeoutMs: 100,
      bridge: createSessionBridge(bridge.socketPath),
    })
    await expect(run(request)).rejects.toMatchObject({ code: "unavailable" })
  })

  test("calls beyond the concurrency limit are refused, and the slots free up", async () => {
    const bridge = await fake(() => ({ hang: true }))
    const run = createAppleRunner(helper(), {
      ...darwin,
      timeoutMs: 300,
      bridge: createSessionBridge(bridge.socketPath),
    })
    const held = Array.from({ length: APPLE_MAX_CONCURRENT }, () =>
      run(request).catch((e: unknown) => e)
    )
    // Let every held call get past the pin check and open its connection.
    await vi.waitFor(() =>
      expect(bridge.connections()).toBe(APPLE_MAX_CONCURRENT)
    )
    await expect(run(request)).rejects.toMatchObject({ code: "unavailable" })
    expect(bridge.connections()).toBe(APPLE_MAX_CONCURRENT)
    await Promise.all(held)
    // Every held call timed out and gave its slot back, so a new call connects again.
    await run(request).catch(() => undefined)
    expect(bridge.connections()).toBe(APPLE_MAX_CONCURRENT + 1)
  })
})
