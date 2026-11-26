import { EventEmitter } from "node:events"
import { renameSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  SessionBridgeOutcomeUnknownError,
  SessionUnavailableError,
  createSessionBridge,
  outcomeUnknown,
  sentNothing,
} from "../session-bridge/client"
import {
  TEST_OWNER_UID,
  answeringBridge,
  failingBridge,
  socketDir,
  startFakeSessionBridge,
} from "../session-bridge/fake-session-bridge.test-support"
import type { FakeAnswer } from "../session-bridge/fake-session-bridge.test-support"
import { createThingsReads } from "./things-adapter"
import {
  MAX_OUTPUT_BYTES,
  bridgeThingsRunner,
  runThingsScript,
  thingsRunner,
} from "./runner"

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }))

class Pipe extends EventEmitter {
  resume = vi.fn()
}
class Child extends EventEmitter {
  stdout = new Pipe()
  stderr = new Pipe()
  kill = vi.fn()
}

let child: Child
beforeEach(() => {
  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fake(answer: (request: unknown) => FakeAnswer) {
  const { dir, remove } = socketDir()
  cleanups.push(remove)
  const bridge = await startFakeSessionBridge(answer, join(dir, "bridge.sock"))
  cleanups.push(bridge.close)
  return bridge
}
const stdout = (bytes: Buffer): FakeAnswer => ({
  json: { ok: true, result: { stdoutBase64: bytes.toString("base64") } },
})

// The SHA-256 of each script as the bridge's table in apps/helper/README.md lists it.
const ADD_TODO_SHA256 =
  "9338821e3c180a49ec73757ba471cc6db347ee2acc9bdae23767cbe2c4e9143c"
const LIST_AREAS_SHA256 =
  "9a55833b22dc537d9472b9f97e625d0c24f898e88bb9ce275bc47dbc193ef390"

// Unix sockets and the plane split are macOS-only (#781); the socket tests do not run on Windows.
const unix = process.platform === "win32" ? describe.skip : describe

test("without a session bridge the direct osascript runner is used", () => {
  expect(thingsRunner()).toBe(runThingsScript)
  expect(thingsRunner(undefined)).toBe(runThingsScript)
})

unix("Things through the session bridge", () => {
  test("sends the script, its pinned hash and argv, and returns what the direct runner would", async () => {
    // Synthetic multi-byte output: separators, an accent and a trailing newline.
    const output = Buffer.from("todo-1\u001FLorem ipsum é\u001E\n", "utf8")
    const direct = runThingsScript("add-todo", ["a", "b", "", "", "x,y"])
    child.stdout.emit("data", output)
    child.emit("close", 0)
    mocked.spawn.mockClear()

    const bridge = await fake(() => stdout(output))
    const viaBridge = await bridgeThingsRunner(
      createSessionBridge(bridge.socketPath, TEST_OWNER_UID)
    )("add-todo", ["a", "b", "", "", "x,y"])

    expect(viaBridge).toBe(await direct)
    expect(bridge.requests).toEqual([
      {
        op: "things",
        script: "add-todo",
        sha256: ADD_TODO_SHA256,
        argv: ["a", "b", "", "", "x,y"],
      },
    ])
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  test("the reads parse the bridge's output as they parse osascript's", async () => {
    const bridge = await fake(() =>
      stdout(Buffer.from("area-1\u001FLorem\u001Earea-2\u001FIpsum", "utf8"))
    )
    const reads = createThingsReads(
      thingsRunner(createSessionBridge(bridge.socketPath, TEST_OWNER_UID))
    )
    expect(await reads.listAreas()).toEqual({
      areas: [
        { id: "area-1", name: "Lorem" },
        { id: "area-2", name: "Ipsum" },
      ],
    })
    expect(bridge.requests).toEqual([
      {
        op: "things",
        script: "list-areas",
        sha256: LIST_AREAS_SHA256,
        argv: [],
      },
    ])
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
    const run = bridgeThingsRunner(createSessionBridge(stale, TEST_OWNER_UID))
    await expect(run("list-areas")).rejects.toMatchObject({
      code: "session_unavailable",
    })
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  test("a malformed frame from the bridge is things_unavailable", async () => {
    const bridge = await fake(() => ({ raw: Buffer.from([0, 0, 0, 0]) }))
    await expect(
      bridgeThingsRunner(
        createSessionBridge(bridge.socketPath, TEST_OWNER_UID)
      )("list-areas")
    ).rejects.toMatchObject({ code: "things_unavailable" })
    expect(mocked.spawn).not.toHaveBeenCalled()
  })
})

// An absent socket and what the runner does with an answer need no listener, so these run
// on every platform.
describe("Things answers from the session bridge", () => {
  test("a missing socket is session_unavailable and nothing is spawned", async () => {
    const { dir, remove } = socketDir()
    cleanups.push(remove)
    const run = bridgeThingsRunner(
      createSessionBridge(join(dir, "absent.sock"), TEST_OWNER_UID)
    )
    await expect(run("list-areas")).rejects.toMatchObject({
      name: "ThingsError",
      code: "session_unavailable",
    })
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  const answered = (answer: unknown) =>
    bridgeThingsRunner(answeringBridge(answer))
  const stdoutOf = (bytes: Buffer) => ({
    ok: true,
    result: { stdoutBase64: bytes.toString("base64") },
  })

  test("the bridge's automation_denied keeps its code and message", async () => {
    await expect(
      answered({ ok: false, code: "automation_denied" })("list-areas")
    ).rejects.toMatchObject({
      code: "automation_denied",
      message: "macOS Automation permission denied for Things",
    })
  })

  test.each(["unknown_script", "unavailable"])(
    "%s from the bridge is things_unavailable",
    async (code) => {
      await expect(
        answered({ ok: false, code })("list-areas")
      ).rejects.toMatchObject({ code: "things_unavailable" })
      expect(mocked.spawn).not.toHaveBeenCalled()
    }
  )

  test("refuses stdout over the direct runner's 5 MiB limit", async () => {
    await expect(
      answered(stdoutOf(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x61)))("list-areas")
    ).rejects.toMatchObject({
      code: "things_unavailable",
      message: "osascript output exceeded limit",
    })
  })

  test("accepts stdout of exactly 5 MiB", async () => {
    const text = await answered(stdoutOf(Buffer.alloc(MAX_OUTPUT_BYTES, 0x61)))(
      "list-areas"
    )
    expect(text.length).toBe(MAX_OUTPUT_BYTES)
  })

  test("a script the gate does not ship never reaches the bridge", async () => {
    const bridge = answeringBridge(stdoutOf(Buffer.from("")))
    await expect(
      bridgeThingsRunner(bridge)("delete-all")
    ).rejects.toMatchObject({ code: "things_unavailable" })
    expect(bridge.requests).toEqual([])
  })
})

describe("Things bridge deadline and causes", () => {
  test("waits past the bridge's worst case: 10 s receive, 10 s osascript, 10 s reply", async () => {
    const bridge = answeringBridge({
      ok: true,
      result: { stdoutBase64: "" },
    })
    await bridgeThingsRunner(bridge)("list-areas")
    expect(bridge.calls).toEqual([
      expect.objectContaining({ timeoutMs: 35_000 }),
    ])
  })

  test("a session_unavailable error still says nothing was sent", async () => {
    const error = await bridgeThingsRunner(
      failingBridge(new SessionUnavailableError())
    )("add-todo", ["a", "b", "", "", ""]).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "session_unavailable" })
    expect(sentNothing(error)).toBe(true)
  })

  test("a timeout after the request was sent still says the outcome is unknown", async () => {
    const error = await bridgeThingsRunner(
      failingBridge(new SessionBridgeOutcomeUnknownError())
    )("add-todo", ["a", "b", "", "", ""]).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "things_unavailable" })
    expect(sentNothing(error)).toBe(false)
    expect(outcomeUnknown(error)).toBe(true)
  })
})
