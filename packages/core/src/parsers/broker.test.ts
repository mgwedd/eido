import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { connect, createServer } from "node:net"
import type { Server, Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createBrokerClient } from "./broker-client"
import { encodeHeader, frame } from "./broker-wire"
import { startBroker } from "./broker"
import type { Broker, BrokerConfig } from "./broker"
import { message, textPdf } from "./fixtures.test-support"
import { DEFAULT_LIMITS } from "./types"

// Every parse here runs in a real child process behind a real Unix socket in a temp dir.
// The end-to-end tests use the real worker; the rest use a fake child (hostile/fake-child).

const HOSTILE = join(dirname(fileURLToPath(import.meta.url)), "hostile")
const FAKE_CHILD = join(HOSTILE, "fake-child.test-support.ts")
const WRONG_SHA_CHILD = join(HOSTILE, "wrong-sha.test-support.ts")
const SLOW = { timeout: 60_000 }

let root: string
let count = 0
const running: Broker[] = []

beforeAll(() => {
  // Unix socket paths are short (about 100 bytes), so the root is a short real path.
  root = realpathSync(mkdtempSync(join(tmpdir(), "eb-")))
})
afterEach(async () => {
  for (const broker of running.splice(0)) await broker.close()
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function start(config: Partial<BrokerConfig> = {}) {
  const dir = join(root, `b${String(count++)}`)
  mkdirSync(dir)
  const socketPath = join(dir, "s")
  const scratchDir = join(dir, "scratch")
  const broker = await startBroker({ socketPath, scratchDir, ...config })
  running.push(broker)
  return {
    broker,
    socketPath,
    scratchDir,
    client: createBrokerClient({ socketPath }),
  }
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

/** Sends `parts` and returns the one response frame as JSON, or null if the broker hangs up first. */
function raw(
  socketPath: string,
  parts: Uint8Array[],
  options: { end?: boolean } = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("no answer from the broker"))
    }, 15_000)
    const done = (value: unknown) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.on("error", () => undefined)
    socket.once("close", () => done(null))
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      if (all.length >= 4 && all.length >= 4 + all.readUInt32BE(0)) {
        done(JSON.parse(all.subarray(4).toString("utf8")))
      }
    })
    socket.once("connect", () => {
      for (const part of parts) socket.write(part)
      if (options.end === true) socket.end()
    })
  })
}

function request(body: Uint8Array, mime = "message/rfc822") {
  return [
    encodeHeader({
      mime,
      sha256: sha256(body),
      limits: DEFAULT_LIMITS,
      bodyBytes: body.byteLength,
    }),
    body,
  ]
}

const MAIL_TEXT =
  "Subject: Lorem ipsum\nFrom: Lorem Sender <sender@example.invalid>\nTo: owner@example.invalid\nDate: 2026-10-05T09:00:00.000Z\n\nLorem ipsum"

describe("end to end through the real worker", SLOW, () => {
  it("parses a small mail message", async () => {
    const { client } = await start()
    const bytes = message({ body: "Lorem ipsum" })
    const result = await client.parseBytes(bytes, "message/rfc822")
    expect(result).toMatchObject({
      ok: true,
      sha256: sha256(bytes),
      trust: "untrusted",
      text: MAIL_TEXT,
      pages: null,
    })
  })

  it("parses a PDF", async () => {
    const { client } = await start()
    const bytes = textPdf([["Lorem ipsum"], ["Dolor sit"]])
    const result = await client.parseBytes(bytes, "application/pdf")
    expect(result).toMatchObject({
      ok: true,
      sha256: sha256(bytes),
      text: "Lorem ipsum\nDolor sit",
      pages: 2,
    })
  })

  it("reports a bad file as a failure and keeps serving", async () => {
    const { client } = await start()
    const bad = await client.parseBytes(
      Buffer.from("not a pdf"),
      "application/pdf"
    )
    expect(bad).toMatchObject({ ok: false, reason: "unsupported" })
    const good = await client.parseBytes(
      message({ body: "Lorem ipsum" }),
      "message/rfc822"
    )
    expect(good.ok).toBe(true)
  })

  it("leaves nothing behind in its scratch dir", async () => {
    const { client, scratchDir } = await start()
    await client.parseBytes(message({ body: "Lorem ipsum" }), "message/rfc822")
    expect(readdirSync(scratchDir)).toEqual([])
  })
})

describe("oversize requests", SLOW, () => {
  it("answers oversize from the header alone, without the body", async () => {
    const { socketPath } = await start()
    const header = encodeHeader({
      mime: "application/pdf",
      sha256: "a".repeat(64),
      limits: { ...DEFAULT_LIMITS, inputBytes: 100 },
      bodyBytes: 101,
    })
    // No body is ever sent: an answer at all means the broker did not wait for it.
    expect(await raw(socketPath, [header])).toEqual({
      ok: false,
      sha256: "a".repeat(64),
      reason: "oversize",
      detail: "101 bytes, more than 100",
    })
  })

  it("does not read a body that is sent anyway, and serves the next job", async () => {
    const { socketPath, client } = await start({ workerEntry: FAKE_CHILD })
    const body = Buffer.alloc(2 * 1024 * 1024, 0x41)
    const header = encodeHeader({
      mime: "application/pdf",
      sha256: sha256(body),
      limits: { ...DEFAULT_LIMITS, inputBytes: 1024 },
      bodyBytes: body.byteLength,
    })
    expect(await raw(socketPath, [header, body])).toMatchObject({
      ok: false,
      reason: "oversize",
    })
    const next = await client.parseBytes(Buffer.from("lorem:0"), "text/plain")
    expect(next.ok).toBe(true)
  })

  it("is oversize through the client too, with the document's hash", async () => {
    const { client } = await start({ workerEntry: FAKE_CHILD })
    const bytes = Buffer.from("lorem ipsum dolor sit amet")
    expect(
      await client.parseBytes(bytes, "text/plain", { inputBytes: 10 })
    ).toEqual({
      ok: false,
      sha256: sha256(bytes),
      reason: "oversize",
      detail: "26 bytes, more than 10",
    })
  })
})

describe("bad frames and vanishing clients", SLOW, () => {
  const LOREM = Buffer.from("lorem:0")

  async function servesNext(client: {
    parseBytes: (b: Buffer, m: string) => Promise<{ ok: boolean }>
  }) {
    expect((await client.parseBytes(LOREM, "text/plain")).ok).toBe(true)
  }

  const cases: Array<[string, () => Uint8Array[]]> = [
    ["a zero-length header", () => [frame(new Uint8Array(0))]],
    [
      "a header over the size limit",
      () => [Buffer.from([0x00, 0x00, 0x20, 0x00])],
    ],
    ["a header that is not JSON", () => [frame(Buffer.from("not json"))]],
    [
      "a header of the wrong shape",
      () => [frame(Buffer.from(JSON.stringify({ version: 1, mime: 7 })))],
    ],
    [
      "more bytes than the header declares",
      () => {
        const [head, body] = request(LOREM, "text/plain")
        return [
          head as Buffer,
          Buffer.concat([body as Buffer, Buffer.from("x")]),
        ]
      },
    ],
  ]
  for (const [name, build] of cases) {
    it(`answers ${name} as malformed and serves the next job`, async () => {
      const { socketPath, client } = await start({ workerEntry: FAKE_CHILD })
      expect(await raw(socketPath, build())).toMatchObject({
        ok: false,
        reason: "malformed",
      })
      await servesNext(client)
    })
  }

  it("answers a body that does not match its hash as malformed", async () => {
    const { socketPath, client } = await start({ workerEntry: FAKE_CHILD })
    const header = encodeHeader({
      mime: "text/plain",
      sha256: "b".repeat(64),
      limits: DEFAULT_LIMITS,
      bodyBytes: LOREM.byteLength,
    })
    expect(await raw(socketPath, [header, LOREM])).toEqual({
      ok: false,
      sha256: "b".repeat(64),
      reason: "malformed",
      detail: "the body does not match its hash",
    })
    await servesNext(client)
  })

  it("answers a truncated body as malformed and serves the next job", async () => {
    const { socketPath, client } = await start({ workerEntry: FAKE_CHILD })
    const [head, body] = request(LOREM, "text/plain")
    const answer = await raw(
      socketPath,
      [head as Buffer, (body as Buffer).subarray(0, 3)],
      { end: true }
    )
    expect(answer).toMatchObject({
      ok: false,
      reason: "malformed",
      detail: "the request ended before its last byte",
    })
    await servesNext(client)
  })

  it("drops a client that never finishes its request, and serves the next job", async () => {
    const { socketPath, client } = await start({
      workerEntry: FAKE_CHILD,
      requestTimeoutMs: 300,
    })
    // Half a header, then silence.
    expect(await raw(socketPath, [Buffer.from([0x00, 0x00])])).toMatchObject({
      ok: false,
      reason: "malformed",
      detail: "the request was not completed in time",
    })
    await servesNext(client)
  })

  it("serves the next job after a client disconnects mid-job, and cleans up", async () => {
    const { socketPath, client, scratchDir } = await start({
      workerEntry: FAKE_CHILD,
    })
    const slow = Buffer.from("lorem:600")
    const leaving = connect(socketPath)
    leaving.on("error", () => undefined)
    await new Promise<void>((resolve) =>
      leaving.once("connect", () => {
        for (const part of request(slow, "text/plain")) leaving.write(part)
        // The request is out; hang up before the child has answered.
        setTimeout(() => {
          leaving.destroy()
          resolve()
        }, 200)
      })
    )
    await servesNext(client)
    // The abandoned child finishes or is never started; either way its work dir goes.
    await expect
      .poll(() => readdirSync(scratchDir), { timeout: 20_000 })
      .toEqual([])
  })

  it("skips a queued job whose client has left", async () => {
    const { socketPath, client, scratchDir } = await start({
      workerEntry: FAKE_CHILD,
      maxConcurrent: 1,
    })
    const running = client.parseBytes(Buffer.from("lorem:800"), "text/plain")
    // Queues behind the running job, then its client leaves.
    const queued = connect(socketPath)
    queued.on("error", () => undefined)
    await new Promise<void>((resolve) =>
      queued.once("connect", () => {
        for (const part of request(Buffer.from("queued:0"), "text/plain"))
          queued.write(part)
        setTimeout(() => {
          queued.destroy()
          resolve()
        }, 300)
      })
    )
    expect((await running).ok).toBe(true)
    await servesNext(client)
    expect(readdirSync(scratchDir)).toEqual([])
  })

  it("answers a crashing child as crashed and serves the next job", async () => {
    const { client } = await start({ workerEntry: FAKE_CHILD })
    expect(await client.parseBytes(LOREM, "crash")).toMatchObject({
      ok: false,
      reason: "crashed",
      detail: "the parser exited with 3",
    })
    await servesNext(client)
  })
})

describe("what the child answers", SLOW, () => {
  it("is crashed, from the broker, when the child answers for another hash", async () => {
    const { socketPath } = await start({ workerEntry: WRONG_SHA_CHILD })
    const body = Buffer.from("lorem:0")
    expect(await raw(socketPath, request(body, "text/plain"))).toEqual({
      ok: false,
      sha256: sha256(body),
      reason: "crashed",
      detail: "the parser returned a malformed result",
    })
  })
})

describe("limits", SLOW, () => {
  const intervals = (results: Array<{ ok: boolean; text?: string }>) =>
    results
      .map((r) => (r.text ?? "").split(",").map(Number))
      .map(([from, to]) => ({ from: from ?? 0, to: to ?? 0 }))
      .sort((a, b) => a.from - b.from)

  const bodies = (delayMs: number) =>
    ["a", "b", "c"].map((name) => Buffer.from(`${name}:${String(delayMs)}`))

  it("runs one parse at a time when maxConcurrent is 1", async () => {
    const { client } = await start({
      workerEntry: FAKE_CHILD,
      maxConcurrent: 1,
    })
    const spans = intervals(
      await Promise.all(
        bodies(500).map((b) => client.parseBytes(b, "text/plain"))
      )
    )
    expect(spans).toHaveLength(3)
    expect(spans[1]!.from).toBeGreaterThanOrEqual(spans[0]!.to)
    expect(spans[2]!.from).toBeGreaterThanOrEqual(spans[1]!.to)
  })

  it("runs parses side by side when maxConcurrent allows it", async () => {
    const { client } = await start({
      workerEntry: FAKE_CHILD,
      maxConcurrent: 3,
    })
    const spans = intervals(
      // Long enough that a slow runner starting three processes still overlaps them.
      await Promise.all(
        bodies(6_000).map((b) => client.parseBytes(b, "text/plain"))
      )
    )
    // The last to start began before the first to start had finished.
    expect(spans[2]!.from).toBeLessThan(spans[0]!.to)
  })

  it("kills a child that passes its timeout, and serves the next job", async () => {
    const { client } = await start({ workerEntry: FAKE_CHILD })
    const pidFile = join(root, `pid-${String(count++)}`)
    const result = await client.parseBytes(Buffer.from("lorem:0"), pidFile, {
      timeoutMs: 3_000,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: "timeout",
      detail: "killed after 3000 ms",
    })
    const pid = Number(readFileSync(pidFile, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/)
    const next = await client.parseBytes(Buffer.from("lorem:0"), "text/plain")
    expect(next.ok).toBe(true)
  })
})

describe("the broker's socket", () => {
  it("is mode 0660 by default and the configured mode when set", async () => {
    const first = await start()
    expect(lstatSync(first.socketPath).mode & 0o777).toBe(0o660)
    const second = await start({ socketMode: 0o600 })
    expect(lstatSync(second.socketPath).mode & 0o777).toBe(0o600)
  })

  it("replaces the socket file of a broker that died, and removes its own on close", async () => {
    const dir = join(root, `b${String(count++)}`)
    mkdirSync(dir)
    const socketPath = join(dir, "s")
    // A process killed with SIGKILL leaves its socket file behind, as a crashed broker does.
    const dying = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))",
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    )
    await new Promise<void>((resolve) =>
      dying.stdout.once("data", () => resolve())
    )
    const exited = new Promise((resolve) => dying.once("exit", resolve))
    dying.kill("SIGKILL")
    await exited
    expect(lstatSync(socketPath).isSocket()).toBe(true)
    const broker = await startBroker({
      socketPath,
      scratchDir: join(dir, "scratch"),
      workerEntry: FAKE_CHILD,
    })
    const client = createBrokerClient({ socketPath })
    expect(
      (await client.parseBytes(Buffer.from("lorem:0"), "text/plain")).ok
    ).toBe(true)
    await broker.close()
    expect(existsSync(socketPath)).toBe(false)
  })

  it("refuses to listen where something else is", async () => {
    const dir = join(root, `b${String(count++)}`)
    mkdirSync(dir)
    const socketPath = join(dir, "s")
    writeFileSync(socketPath, "not a socket")
    await expect(
      startBroker({ socketPath, scratchDir: join(dir, "scratch") })
    ).rejects.toThrow("not a socket")
    expect(readFileSync(socketPath, "utf8")).toBe("not a socket")
  })

  it("refuses to take the path of a running broker, which keeps serving", async () => {
    const live = await start({ workerEntry: FAKE_CHILD })
    await expect(
      startBroker({
        socketPath: live.socketPath,
        scratchDir: join(dirname(live.socketPath), "scratch2"),
      })
    ).rejects.toThrow("already listening")
    expect(
      (await live.client.parseBytes(Buffer.from("lorem:0"), "text/plain")).ok
    ).toBe(true)
  })
})

describe("what the broker may touch", () => {
  const sources = [
    "broker.ts",
    "broker-client.ts",
    "broker-main.ts",
    "broker-wire.ts",
  ]
  const here = dirname(fileURLToPath(import.meta.url))
  const read = (name: string) => readFileSync(join(here, name), "utf8")
  const code = (name: string) =>
    read(name)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("imports only the parser modules and Node built-ins it needs", () => {
    const allowed = new Set([
      "node:crypto",
      "node:fs",
      "node:net",
      "node:os",
      "node:path",
      "node:url",
      "./broker",
      "./broker-client",
      "./broker-wire",
      "./limiter",
      "./parse-document",
      "./private-scratch",
      "./sandbox",
      "./types",
      "./worker",
    ])
    for (const name of sources) {
      const imports = [
        ...read(name).matchAll(
          /^(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm
        ),
      ].map((m) => m[1])
      expect(imports.length, `${name} has imports`).toBeGreaterThan(0)
      for (const specifier of imports) {
        expect(
          allowed.has(specifier ?? ""),
          `${name} imports ${String(specifier)}`
        ).toBe(true)
      }
    }
  })

  it("names no data dir, token or gate setting", () => {
    for (const name of sources) {
      expect(code(name), name).not.toMatch(
        /EIDO_DATA_DIR|EIDO_GATE|dataDir|@eido\/gate|token/i
      )
    }
  })
})

// Fake brokers: a hostile or broken broker must be a crashed result, never a trusted value.
describe("the client against a broker it cannot trust", () => {
  const body = Buffer.from("lorem ipsum")
  const hash = sha256(body)
  const good = {
    ok: true,
    sha256: hash,
    trust: "untrusted",
    text: "Lorem ipsum",
    offsets: [],
    pages: null,
  }
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function fake(answer: (socket: Socket) => void, deadlineMs?: number) {
    const socketPath = join(root, `f${String(count++)}`)
    const server = createServer((socket) => {
      socket.on("error", () => undefined)
      answer(socket)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return createBrokerClient({ socketPath, deadlineMs })
  }
  const json = (value: unknown) => frame(Buffer.from(JSON.stringify(value)))
  const crashed = (detail: string) => ({
    ok: false,
    sha256: hash,
    reason: "crashed",
    detail,
  })

  it("accepts a well-formed answer for its document", async () => {
    const client = await fake((s) => s.write(json(good)))
    expect(await client.parseBytes(body, "text/plain")).toEqual(good)
  })

  it("rejects an answer for another document", async () => {
    const client = await fake((s) =>
      s.write(json({ ...good, sha256: "c".repeat(64) }))
    )
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser returned a malformed result")
    )
  })

  const offShape: Array<[string, unknown]> = [
    ["text that is not a string", { ...good, text: 7 }],
    [
      "no trust field needed but no offsets",
      { ok: true, sha256: hash, text: "x", pages: null },
    ],
    [
      "an offset past the end of the text",
      { ...good, offsets: [{ offset: 99, line: 1 }] },
    ],
    [
      "an unknown failure reason",
      { ok: false, sha256: hash, reason: "nope", detail: "x" },
    ],
    ["a bare number", 42],
    ["null", null],
  ]
  for (const [name, value] of offShape) {
    it(`rejects ${name}`, async () => {
      const client = await fake((s) => s.write(json(value)))
      expect(await client.parseBytes(body, "text/plain")).toEqual(
        crashed("the parser returned a malformed result")
      )
    })
  }

  it("rejects an answer that is not JSON", async () => {
    const client = await fake((s) => s.write(frame(Buffer.from("{nope"))))
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser broker's answer is not JSON")
    )
  })

  it("rejects a frame larger than the limits allow, without waiting for the rest", async () => {
    const client = await fake((s) => {
      const head = Buffer.alloc(4)
      head.writeUInt32BE(0xffffffff)
      s.write(head)
    })
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser broker's answer is too large")
    )
  })

  it("rejects more than one frame", async () => {
    const client = await fake((s) =>
      s.write(Buffer.concat([json(good), json(good)]))
    )
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser broker sent more than one frame")
    )
  })

  it("is crashed when the broker hangs up without an answer", async () => {
    const client = await fake((s) => s.destroy())
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser broker closed the connection without a result")
    )
  })

  it("is crashed when the broker never answers", async () => {
    const client = await fake(() => undefined, 200)
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser broker did not answer in time")
    )
  })

  it("is crashed when there is no broker at the socket", async () => {
    const client = createBrokerClient({ socketPath: join(root, "nobody") })
    expect(await client.parseBytes(body, "text/plain")).toEqual(
      crashed("the parser broker could not be reached (ENOENT)")
    )
  })

  it("throws, as the in-process parser does, for limits that are not valid", async () => {
    const client = await fake((s) => s.write(json(good)))
    await expect(
      client.parseBytes(body, "text/plain", { timeoutMs: 0 })
    ).rejects.toThrow(RangeError)
  })
})
