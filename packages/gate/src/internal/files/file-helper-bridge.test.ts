import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"
import { openControlDb } from "../control-db"
import {
  SessionUnavailableError,
  createSessionBridge,
} from "../session-bridge/client"
import {
  answeringBridge,
  socketDir,
  startFakeSessionBridge,
} from "../session-bridge/fake-session-bridge"
import type { FakeAnswer } from "../session-bridge/fake-session-bridge"
import { signedFileRoots } from "../test-fixtures"
import { fileHelper } from "./file-helper"
import { createFile } from "./file-ops"

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }))
class Pipe extends EventEmitter {
  end = vi.fn()
  resume = vi.fn()
}
class Child extends EventEmitter {
  stdin = new Pipe()
  stdout = new Pipe()
  stderr = new Pipe()
  kill = vi.fn()
}
let child: Child
beforeEach(() => {
  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
})

const dir = mkdtempSync(join(tmpdir(), "eido-file-helper-bridge-"))
const binary = join(dir, "eido-file-helper")
writeFileSync(binary, "synthetic helper bytes")
const pin = {
  path: binary,
  sha256: createHash("sha256").update("synthetic helper bytes").digest("hex"),
}
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fake(answer: (request: unknown) => FakeAnswer) {
  const { dir: socketParent, remove } = socketDir()
  cleanups.push(remove)
  const bridge = await startFakeSessionBridge(
    answer,
    join(socketParent, "bridge.sock")
  )
  cleanups.push(bridge.close)
  return bridge
}
const stdout = (text: string): FakeAnswer => ({
  json: {
    ok: true,
    result: { stdoutBase64: Buffer.from(text, "utf8").toString("base64") },
  },
})

const DOCS = {
  path: "/srv/example/docs",
  dev: "2a",
  ino: "1001",
  trashDir: ".eido-trash",
}
const identify = { op: "identify", path: "/srv/example/docs" } as const
const IDENTIFIED =
  '{"ok":true,"op":"identify","canonicalPath":"/srv/example/docs","dev":"2a","ino":"1001"}\n'

// Unix sockets and the plane split are macOS-only (#781); the socket tests do not run on Windows.
const unix = process.platform === "win32" ? describe.skip : describe

unix("file helper through the session bridge", () => {
  test("a create in an approved root reaches the bridge as a file op and succeeds", async () => {
    const db = openControlDb(":memory:")
    await signedFileRoots(db, { roots: [{ id: "docs", root: DOCS }] })
    const bridge = await fake(() => stdout('{"ok":true,"op":"create"}\n'))
    const outcome = await createFile(
      db,
      fileHelper(pin, createSessionBridge(bridge.socketPath)),
      {
        rootId: "docs",
        path: "notes/lorem.txt",
        content: new TextEncoder().encode("lorem-ipsum-file-body"),
      }
    )
    expect(outcome).toEqual({ ok: true })
    expect(bridge.requests).toEqual([
      {
        op: "file",
        request: {
          op: "create",
          root: DOCS,
          path: "notes/lorem.txt",
          contentBase64: "bG9yZW0taXBzdW0tZmlsZS1ib2R5",
        },
      },
    ])
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  test("returns the same reply the spawned helper gives for the same stdout", async () => {
    const direct = fileHelper(pin)(identify)
    await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled())
    child.stdout.emit("data", Buffer.from(IDENTIFIED))
    child.emit("close", 0)
    mocked.spawn.mockClear()

    const bridge = await fake(() => stdout(IDENTIFIED))
    const viaBridge = await fileHelper(
      pin,
      createSessionBridge(bridge.socketPath)
    )(identify)
    expect(viaBridge).toEqual(await direct)
    expect(viaBridge).toEqual({
      ok: true,
      op: "identify",
      canonicalPath: "/srv/example/docs",
      dev: "2a",
      ino: "1001",
    })
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  test("a missing socket is session_unavailable and nothing is spawned", async () => {
    const { dir: parent, remove } = socketDir()
    cleanups.push(remove)
    const error = await fileHelper(
      pin,
      createSessionBridge(join(parent, "absent.sock"))
    )(identify).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  test("a refused connection is session_unavailable and nothing is spawned", async () => {
    const { dir: parent, remove } = socketDir()
    cleanups.push(remove)
    const live = join(parent, "live.sock")
    const stale = join(parent, "stale.sock")
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(live, resolve))
    renameSync(live, stale)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const error = await fileHelper(
      pin,
      createSessionBridge(stale)
    )(identify).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SessionUnavailableError)
    expect(mocked.spawn).not.toHaveBeenCalled()
  })

  test("a malformed frame is a helper failure", async () => {
    const bridge = await fake(() => ({ raw: Buffer.from([0, 0, 0, 0]) }))
    const error = await fileHelper(
      pin,
      createSessionBridge(bridge.socketPath)
    )(identify).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(SessionUnavailableError)
    expect(error).toMatchObject({ message: "file helper failed" })
  })
})

// What the helper does with an answer needs no socket, so these run on every platform.
describe("file helper answers from the session bridge", () => {
  const stdoutOf = (text: string) => ({
    ok: true,
    result: { stdoutBase64: Buffer.from(text, "utf8").toString("base64") },
  })

  test("accepts a valid reply at the limit", async () => {
    const atLimit = IDENTIFIED + " ".repeat(64 * 1024 - IDENTIFIED.length)
    await expect(
      fileHelper(pin, answeringBridge(stdoutOf(atLimit)))(identify)
    ).resolves.toMatchObject({ ok: true, op: "identify" })
  })

  test("a binary that does not match its pin never reaches the bridge", async () => {
    const bridge = answeringBridge(stdoutOf(IDENTIFIED))
    await expect(
      fileHelper({ path: binary, sha256: "0".repeat(64) }, bridge)(identify)
    ).rejects.toThrow("file helper does not match its pinned hash")
    expect(bridge.requests).toEqual([])
  })

  test.each([
    ["a bridge refusal", { ok: false, code: "unavailable" }],
    ["stdout that is not JSON", stdoutOf("not json\n")],
    [
      "stdout outside the helper's schema",
      stdoutOf('{"ok":true,"op":"teapot"}\n'),
    ],
    [
      "stdout over the 64 KiB reply limit",
      // A valid reply padded with whitespace JSON.parse would accept: only the limit refuses it.
      stdoutOf(IDENTIFIED + " ".repeat(64 * 1024)),
    ],
  ])("%s is a helper failure", async (_name, answer) => {
    const error = await fileHelper(
      pin,
      answeringBridge(answer)
    )(identify).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(SessionUnavailableError)
    expect(error).toMatchObject({ message: "file helper failed" })
  })
})
