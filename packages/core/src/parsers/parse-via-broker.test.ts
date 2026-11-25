import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBrokerClient } from "./broker-client"
import { startFakeBroker } from "./fake-broker.test-support"
import type { FakeBroker } from "./fake-broker.test-support"
import { createParser } from "./parse-document"
import type { Parser } from "./parse-document"
import { runInChild } from "./sandbox"
import { blobPath } from "./store"
import { DEFAULT_LIMITS } from "./types"
import type { ParseResult } from "./types"

// Under the plane split the parser hands every document to the broker. A real child is never
// started: the sandbox module is replaced by a spy that fails the test if it is asked to run one.
vi.mock("./sandbox", () => ({
  runInChild: vi.fn(() => {
    throw new Error("a local child was spawned")
  }),
}))

const BYTES = new TextEncoder().encode("a document the broker will parse")
const PDF = "application/pdf"

let dataDir: string
let broker: FakeBroker | undefined

beforeEach(() => {
  vi.mocked(runInChild).mockClear()
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "eido-via-broker-")))
})
afterEach(async () => {
  await broker?.close()
  broker = undefined
  rmSync(dataDir, { recursive: true, force: true })
})

function success(sha256: string, text: string): ParseResult {
  return {
    ok: true,
    sha256,
    trust: "untrusted",
    text,
    offsets: [{ offset: 0, line: 1 }],
    pages: 1,
  }
}

function parserWith(
  socketPath: string,
  limits?: Parameters<typeof createParser>[0]["limits"]
): Parser {
  return createParser({
    dataDir,
    ...(limits === undefined ? {} : { limits }),
    broker: createBrokerClient({ socketPath, ...(limits ? { limits } : {}) }),
  })
}

describe("a parser with a broker", () => {
  it("sends a stored original's bytes, mime and limits, and returns the broker's validated result", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "text from the broker")
    )
    const parser = parserWith(broker.socketPath, { pdfPages: 7 })
    const { sha256 } = parser.storeOriginal(BYTES)

    const result = await parser.parseDocument({ blobSha256: sha256, mime: PDF })

    expect(result).toEqual(success(sha256, "text from the broker"))
    expect(broker.requests).toHaveLength(1)
    const [request] = broker.requests
    expect(request?.body.equals(Buffer.from(BYTES))).toBe(true)
    expect(request?.header).toMatchObject({
      mime: PDF,
      sha256,
      bodyBytes: BYTES.byteLength,
      limits: { ...DEFAULT_LIMITS, pdfPages: 7 },
    })
  })

  it("sends bytes that are not kept, and stores nothing", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "from bytes")
    )
    const parser = parserWith(broker.socketPath)

    const result = await parser.parseBytes(BYTES, "image/png")

    expect(result.ok && result.text).toBe("from bytes")
    expect(broker.requests[0]?.body.equals(Buffer.from(BYTES))).toBe(true)
    expect(broker.requests[0]?.header.mime).toBe("image/png")
    expect(existsSync(join(dataDir, "blobs"))).toBe(false)
  })

  it("passes a broker failure through as the broker gave it", async () => {
    broker = await startFakeBroker((request) => ({
      ok: false,
      sha256: request.header.sha256,
      reason: "unsupported",
      detail: "no parser for this type",
    }))
    const parser = parserWith(broker.socketPath)

    const result = await parser.parseBytes(BYTES, "application/x-unknown")

    expect(result).toMatchObject({ ok: false, reason: "unsupported" })
  })

  it("does not trust a broker answer for another document", async () => {
    broker = await startFakeBroker(() => success("0".repeat(64), "not yours"))
    const parser = parserWith(broker.socketPath)

    const result = await parser.parseBytes(BYTES, PDF)

    expect(result).toMatchObject({ ok: false, reason: "crashed" })
  })

  it("refuses a stored original whose bytes do not match its hash, without trusting the broker's text", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "text of the wrong bytes")
    )
    const parser = parserWith(broker.socketPath)
    const { sha256 } = parser.storeOriginal(BYTES)
    // Corrupt the stored file in place; the name still says the old hash.
    const path = blobPath(dataDir, sha256)
    rmSync(path)
    writeFileSync(path, "other bytes")

    const result = await parser.parseDocument({ blobSha256: sha256, mime: PDF })

    expect(result).toMatchObject({
      ok: false,
      sha256,
      reason: "malformed",
      detail: "the stored original does not match its hash",
    })
  })

  it("makes no parse-tmp directory: nothing is scratch-parsed in core", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "ok")
    )
    const parser = parserWith(broker.socketPath)
    await parser.parseBytes(BYTES, PDF)

    expect(existsSync(join(dataDir, "parse-tmp"))).toBe(false)
  })
})

describe("a parser whose broker fails", () => {
  it("answers crashed for parseDocument and parseBytes when the socket is not there, and spawns no child", async () => {
    const parser = parserWith(join(dirname(dataDir), "no-such-socket"))
    const { sha256 } = parser.storeOriginal(BYTES)

    const stored = await parser.parseDocument({ blobSha256: sha256, mime: PDF })
    const bytes = await parser.parseBytes(BYTES, PDF)

    expect(stored).toMatchObject({ ok: false, sha256, reason: "crashed" })
    expect(bytes).toMatchObject({ ok: false, sha256, reason: "crashed" })
    expect(runInChild).not.toHaveBeenCalled()
  })

  it("answers crashed and does not parse locally when the broker hangs up mid-request", async () => {
    broker = await startFakeBroker(() => "hang-up")
    const parser = parserWith(broker.socketPath)
    const { sha256 } = parser.storeOriginal(BYTES)

    const result = await parser.parseDocument({ blobSha256: sha256, mime: PDF })

    expect(result).toMatchObject({ ok: false, reason: "crashed" })
    expect(broker.requests).toHaveLength(1)
    expect(runInChild).not.toHaveBeenCalled()
  })

  it("answers crashed when the stored original cannot be read", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "unreachable")
    )
    const parser = parserWith(broker.socketPath)
    const { sha256 } = parser.storeOriginal(BYTES)
    const path = blobPath(dataDir, sha256)
    // A directory where the file was: it stats, but cannot be read as bytes.
    rmSync(path)
    mkdirSync(path)

    const result = await parser.parseDocument({ blobSha256: sha256, mime: PDF })

    expect(result).toMatchObject({ ok: false, sha256, reason: "crashed" })
    expect(broker.connections()).toBe(0)
  })
})

describe("what core decides before the broker is contacted", () => {
  it("rejects an oversize stored original by its file size", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "never")
    )
    const parser = parserWith(broker.socketPath, { inputBytes: 10 })
    const { sha256 } = parser.storeOriginal(BYTES)

    const result = await parser.parseDocument({ blobSha256: sha256, mime: PDF })

    expect(result).toMatchObject({ ok: false, sha256, reason: "oversize" })
    expect(broker.connections()).toBe(0)
  })

  it("rejects oversize bytes", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "never")
    )
    const parser = parserWith(broker.socketPath, { inputBytes: 10 })

    const result = await parser.parseBytes(BYTES, PDF)

    expect(result).toMatchObject({ ok: false, reason: "oversize" })
    expect(broker.connections()).toBe(0)
  })

  it("rejects a malformed hash", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "never")
    )
    const parser = parserWith(broker.socketPath)

    const result = await parser.parseDocument({
      blobSha256: "../../etc/passwd",
      mime: PDF,
    })

    expect(result).toMatchObject({ ok: false, reason: "malformed" })
    expect(broker.connections()).toBe(0)
  })

  it("rejects a hash with no stored original", async () => {
    broker = await startFakeBroker((request) =>
      success(request.header.sha256, "never")
    )
    const parser = parserWith(broker.socketPath)

    const result = await parser.parseDocument({
      blobSha256: "a".repeat(64),
      mime: PDF,
    })

    expect(result).toMatchObject({ ok: false, reason: "malformed" })
    expect(broker.connections()).toBe(0)
  })
})
