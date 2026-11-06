import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { request, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  MAX_BODY_BYTES,
  clearStaleSocket,
  prepareSocketDir,
  serveSupervisor,
  writeAtomic,
} from "./supervisor-server.ts"

const uid = process.getuid?.() ?? -1
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sv-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function call(
  socketPath: string,
  method: string,
  path: string,
  body?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        })
      )
    })
    req.on("error", reject)
    req.end(body)
  })
}

const closing = (server: Server) =>
  cleanups.unshift(() => {
    server.close()
  })

describe("prepareSocketDir", () => {
  it("creates a missing directory at 0700", () => {
    const dir = join(tempDir(), "run")
    prepareSocketDir(dir, uid)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it("refuses a directory open to others, a symlink, a file, or another owner", () => {
    const root = tempDir()
    const open = join(root, "open")
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    expect(() => prepareSocketDir(open, uid)).toThrow(
      `${open} is open to other users (mode 755); chmod 700 it`
    )
    const link = join(root, "link")
    symlinkSync(open, link)
    expect(() => prepareSocketDir(link, uid)).toThrow(`${link} is a symlink`)
    const file = join(root, "file")
    writeFileSync(file, "")
    expect(() => prepareSocketDir(file, uid)).toThrow(
      `${file} is not a directory`
    )
    const mine = join(root, "mine")
    mkdirSync(mine, { mode: 0o700 })
    expect(() => prepareSocketDir(mine, uid + 1)).toThrow(
      `${mine} is not owned by uid ${uid + 1}`
    )
  })
})

describe("clearStaleSocket", () => {
  it("removes a socket nothing answers on, and leaves a missing one alone", async () => {
    const dir = tempDir()
    const path = join(dir, "s.sock")
    await clearStaleSocket(path)
    // A process that exits without closing its listener leaves the socket file behind.
    const left = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
    ])
    expect(left.status).toBe(0)
    expect(lstatSync(path).isSocket()).toBe(true)
    await clearStaleSocket(path)
    expect(readdirSync(dir)).toEqual([])
  })

  it("refuses while another listener answers, and refuses a plain file", async () => {
    const dir = tempDir()
    const path = join(dir, "s.sock")
    const live = createNetServer()
    await new Promise<void>((r) => live.listen(path, r))
    cleanups.unshift(() => live.close())
    await expect(clearStaleSocket(path)).rejects.toThrow(
      `another supervisor is listening on ${path}`
    )
    const file = join(dir, "f.sock")
    writeFileSync(file, "")
    await expect(clearStaleSocket(file)).rejects.toThrow(
      `${file} exists and is not a socket`
    )
  })
})

describe("serveSupervisor", () => {
  it("answers through the routes on a 0600 socket", async () => {
    const path = join(tempDir(), "run", "supervisor.sock")
    const seen: string[] = []
    const server = await serveSupervisor(
      {
        handle: (method, url, body) => {
          seen.push(`${method} ${url} ${body}`)
          return Promise.resolve({ status: 202, body: { ok: true } })
        },
      },
      path,
      uid
    )
    closing(server)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(
      await call(path, "POST", "/jobs/stop", '{"names":["core"]}')
    ).toEqual({ status: 202, body: { ok: true } })
    expect(seen).toEqual(['POST /jobs/stop {"names":["core"]}'])
  })

  it("refuses a body over the limit without calling the routes", async () => {
    const path = join(tempDir(), "supervisor.sock")
    chmodSync(join(path, ".."), 0o700)
    let calls = 0
    const server = await serveSupervisor(
      {
        handle: () => {
          calls++
          return Promise.resolve({ status: 200, body: {} })
        },
      },
      path,
      uid
    )
    closing(server)
    const reply = await call(
      path,
      "POST",
      "/settings",
      "x".repeat(MAX_BODY_BYTES + 1)
    )
    expect(reply).toEqual({
      status: 413,
      body: {
        error: "invalid_body",
        message: `the body is over ${MAX_BODY_BYTES} bytes`,
      },
    })
    expect(calls).toBe(0)
  })

  it("refuses a socket path longer than a Unix socket allows", async () => {
    const path = join(tempDir(), "d".repeat(80), "supervisor.sock")
    await expect(
      serveSupervisor(
        { handle: () => Promise.resolve({ status: 200, body: {} }) },
        path,
        uid
      )
    ).rejects.toThrow(/over the 103 a Unix socket path allows/)
  })

  it("does not start in an unsafe directory", async () => {
    const dir = tempDir()
    chmodSync(dir, 0o755)
    await expect(
      serveSupervisor(
        { handle: () => Promise.resolve({ status: 200, body: {} }) },
        join(dir, "supervisor.sock"),
        uid
      )
    ).rejects.toThrow(/is open to other users/)
  })
})

describe("writeAtomic", () => {
  it("replaces the file at 0600 and leaves no temp file", () => {
    const dir = tempDir()
    const path = join(dir, "stack.env")
    writeFileSync(path, "old\n", { mode: 0o644 })
    writeAtomic(path, "new\n")
    expect(readFileSync(path, "utf8")).toBe("new\n")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(["stack.env"])
  })

  it("removes the temp file when the rename fails", () => {
    const dir = tempDir()
    const target = join(dir, "taken")
    mkdirSync(join(target, "child"), { recursive: true })
    expect(() => writeAtomic(target, "x")).toThrow()
    expect(readdirSync(dir)).toEqual(["taken"])
  })
})
