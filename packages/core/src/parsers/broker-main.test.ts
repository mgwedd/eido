import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createBrokerClient } from "./broker-client"
import { readBrokerEnv } from "./broker-main"
import { message } from "./fixtures.test-support"

const HERE = dirname(fileURLToPath(import.meta.url))

describe("readBrokerEnv", () => {
  it("reads the socket and defaults the rest", () => {
    expect(
      readBrokerEnv({ EIDO_PARSER_SOCKET: "/run/eido/parser.sock" })
    ).toEqual({
      socketPath: "/run/eido/parser.sock",
      scratchDir: join(tmpdir(), "eido-parser"),
    })
  })

  it("reads every setting", () => {
    expect(
      readBrokerEnv({
        EIDO_PARSER_SOCKET: "/run/p.sock",
        EIDO_PARSER_SCRATCH_DIR: "/var/p",
        EIDO_PARSER_OCR_BINARY: "/opt/bin/tesseract",
        EIDO_PARSER_MAX_CONCURRENT: "4",
      })
    ).toEqual({
      socketPath: "/run/p.sock",
      scratchDir: "/var/p",
      ocrBinary: "/opt/bin/tesseract",
      maxConcurrent: 4,
    })
  })

  it("treats empty optional values as not set", () => {
    expect(
      readBrokerEnv({
        EIDO_PARSER_SOCKET: "/run/p.sock",
        EIDO_PARSER_OCR_BINARY: "",
        EIDO_PARSER_MAX_CONCURRENT: "",
      })
    ).toEqual({
      socketPath: "/run/p.sock",
      scratchDir: join(tmpdir(), "eido-parser"),
    })
  })

  const refused: Array<[string, Record<string, string>, string]> = [
    ["a missing socket", {}, "EIDO_PARSER_SOCKET is required"],
    [
      "an empty socket",
      { EIDO_PARSER_SOCKET: "" },
      "EIDO_PARSER_SOCKET is required",
    ],
    [
      "a relative socket",
      { EIDO_PARSER_SOCKET: "p.sock" },
      "EIDO_PARSER_SOCKET must be an absolute path",
    ],
    [
      "a relative scratch dir",
      { EIDO_PARSER_SOCKET: "/p.sock", EIDO_PARSER_SCRATCH_DIR: "tmp" },
      "EIDO_PARSER_SCRATCH_DIR must be an absolute path",
    ],
    [
      "a relative OCR binary",
      { EIDO_PARSER_SOCKET: "/p.sock", EIDO_PARSER_OCR_BINARY: "tesseract" },
      "EIDO_PARSER_OCR_BINARY must be an absolute path",
    ],
    [
      "zero parses at once",
      { EIDO_PARSER_SOCKET: "/p.sock", EIDO_PARSER_MAX_CONCURRENT: "0" },
      "EIDO_PARSER_MAX_CONCURRENT must be a positive integer",
    ],
    [
      "a fractional count",
      { EIDO_PARSER_SOCKET: "/p.sock", EIDO_PARSER_MAX_CONCURRENT: "1.5" },
      "EIDO_PARSER_MAX_CONCURRENT must be a positive integer",
    ],
    [
      "a count that is not a number",
      { EIDO_PARSER_SOCKET: "/p.sock", EIDO_PARSER_MAX_CONCURRENT: "many" },
      "EIDO_PARSER_MAX_CONCURRENT must be a positive integer",
    ],
  ]
  for (const [name, env, error] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => readBrokerEnv(env)).toThrow(error)
    })
  }
})

describe("the broker process", () => {
  let root: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "eb-")))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it(
    "serves a parse under the no-network preload and exits cleanly on SIGTERM",
    { timeout: 60_000 },
    async () => {
      const dir = join(root, "main")
      mkdirSync(dir)
      const socketPath = join(dir, "s")
      const child = spawn(
        process.execPath,
        [
          "--import",
          join(HERE, "..", "ts-hooks.ts"),
          "--import",
          join(HERE, "no-network.ts"),
          join(HERE, "broker-main.ts"),
        ],
        {
          env: {
            EIDO_PARSER_SOCKET: socketPath,
            EIDO_PARSER_SCRATCH_DIR: join(dir, "scratch"),
          },
          stdio: ["ignore", "ignore", "pipe"],
        }
      )
      let stderr = ""
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code))
      )
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (stderr.includes("parser broker listening")) {
            clearInterval(poll)
            resolve()
          }
        }, 50)
        void exited.then((code) => {
          clearInterval(poll)
          reject(new Error(`broker exited with ${String(code)}: ${stderr}`))
        })
      })
      const client = createBrokerClient({ socketPath })
      const result = await client.parseBytes(
        message({ body: "Lorem ipsum" }),
        "message/rfc822"
      )
      expect(result).toMatchObject({ ok: true })
      child.kill("SIGTERM")
      expect(await exited).toBe(0)
      expect(existsSync(socketPath)).toBe(false)
    }
  )

  it("exits with an error when its socket is not configured", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        join(HERE, "..", "ts-hooks.ts"),
        join(HERE, "broker-main.ts"),
      ],
      {
        env: {},
        stdio: ["ignore", "ignore", "pipe"],
      }
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", resolve)
    )
    expect(code).not.toBe(0)
    expect(stderr).toContain("EIDO_PARSER_SOCKET is required")
  })
})
