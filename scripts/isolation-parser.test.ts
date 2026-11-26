import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { attempt } from "./isolation-parser-child.ts"
import {
  classifyParserAnswer,
  isParserProbeName,
  parserProbeDocument,
  parserTargetOf,
  readAttemptReport,
  readParserTarget,
} from "./isolation-parser.ts"
import type { ParserTarget } from "./isolation-parser.ts"

const TCP: ParserTarget = {
  kind: "tcp",
  host: "127.0.0.1",
  port: 18080,
  timeoutMs: 500,
}
const UNIX: ParserTarget = { kind: "unix", path: "/a/b.sock", timeoutMs: 500 }
const FILE: ParserTarget = { kind: "file", path: "/a/eido-data.db" }

/** What the parse child's result looks like once the broker returned it. */
const answer = (report: unknown) => ({
  ok: true,
  trust: "untrusted",
  text: JSON.stringify(report),
})

describe("classifyParserAnswer", () => {
  test("reached when the child connected: the proxy is reachable from the parse child", () => {
    expect(
      classifyParserAnswer(
        answer({ kind: "tcp", reached: true, code: "OK" }),
        TCP
      )
    ).toEqual({ ran: true, reached: true, code: "OK" })
  })

  test("reached when the child opened the file", () => {
    expect(
      classifyParserAnswer(
        answer({ kind: "file", reached: true, code: "OK" }),
        FILE
      )
    ).toEqual({ ran: true, reached: true, code: "OK" })
  })

  test("blocked with the errno name the child saw", () => {
    expect(
      classifyParserAnswer(
        answer({ kind: "tcp", reached: false, code: "EPERM" }),
        TCP
      )
    ).toEqual({ ran: true, reached: false, code: "EPERM" })
    expect(
      classifyParserAnswer(
        answer({ kind: "unix", reached: false, code: "EACCES" }),
        UNIX
      )
    ).toEqual({ ran: true, reached: false, code: "EACCES" })
  })

  test("a refusal's code is an errno-style name only, never a message", () => {
    expect(
      classifyParserAnswer(
        answer({ kind: "tcp", reached: false, code: "password: hunter2" }),
        TCP
      )
    ).toEqual({ ran: true, reached: false, code: "error" })
  })

  test("a reached report is reached whatever its code says", () => {
    expect(
      classifyParserAnswer(
        answer({ kind: "tcp", reached: true, code: "EPERM" }),
        TCP
      )
    ).toEqual({ ran: true, reached: true, code: "OK" })
  })

  test.each([
    ["crashed", "PARSE_CRASHED"],
    ["timeout", "PARSE_TIMEOUT"],
    ["unsupported", "PARSE_UNSUPPORTED"],
    ["Bad Reason!", "PARSE_FAILED"],
    [undefined, "PARSE_FAILED"],
  ])(
    "a failed parse (%s) is an error, not a blocked result",
    (reason, code) => {
      expect(
        classifyParserAnswer(
          { ok: false, ...(reason === undefined ? {} : { reason }) },
          TCP
        )
      ).toEqual({ ran: false, code })
    }
  )

  test("no answer at all is an error, so a dead broker cannot pass as blocked", () => {
    expect(classifyParserAnswer(undefined, TCP)).toEqual({
      ran: false,
      code: "NO_ANSWER",
    })
    expect(classifyParserAnswer("ok", TCP)).toEqual({
      ran: false,
      code: "NO_ANSWER",
    })
    expect(classifyParserAnswer({}, TCP)).toEqual({
      ran: false,
      code: "NO_ANSWER",
    })
  })

  test("a parse with no text, empty text or text that is no report is an error", () => {
    expect(classifyParserAnswer({ ok: true }, TCP)).toEqual({
      ran: false,
      code: "NO_REPORT",
    })
    expect(classifyParserAnswer({ ok: true, text: "" }, TCP)).toEqual({
      ran: false,
      code: "BAD_REPORT",
    })
    expect(classifyParserAnswer({ ok: true, text: "reached" }, TCP)).toEqual({
      ran: false,
      code: "BAD_REPORT",
    })
    expect(
      classifyParserAnswer(
        answer({ kind: "tcp", reached: "no", code: "E" }),
        TCP
      )
    ).toEqual({ ran: false, code: "BAD_REPORT" })
  })

  test("a report about another kind of target than the one asked is an error", () => {
    expect(
      classifyParserAnswer(
        answer({ kind: "file", reached: false, code: "EACCES" }),
        TCP
      )
    ).toEqual({ ran: false, code: "BAD_REPORT" })
  })
})

describe("readAttemptReport", () => {
  test("reads a report and refuses anything else", () => {
    expect(
      readAttemptReport('{"kind":"unix","reached":false,"code":"ENOENT"}')
    ).toEqual({ kind: "unix", reached: false, code: "ENOENT" })
    expect(readAttemptReport("not json")).toBeUndefined()
    expect(readAttemptReport("null")).toBeUndefined()
    expect(
      readAttemptReport('{"kind":"dns","reached":true,"code":"OK"}')
    ).toBeUndefined()
    expect(readAttemptReport('{"kind":"tcp","reached":true}')).toBeUndefined()
  })
})

describe("parserTargetOf and readParserTarget", () => {
  test("builds each probe's target from the spec fields", () => {
    const fields = { host: "127.0.0.1", port: 9, path: "/p", timeoutMs: 7 }
    expect(parserTargetOf("parser-loopback", fields)).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 9,
      timeoutMs: 7,
    })
    expect(parserTargetOf("parser-proxy", fields)?.kind).toBe("tcp")
    expect(parserTargetOf("parser-llama", fields)?.kind).toBe("tcp")
    expect(parserTargetOf("parser-intent-socket", fields)).toEqual({
      kind: "unix",
      path: "/p",
      timeoutMs: 7,
    })
    expect(parserTargetOf("parser-data-db", fields)).toEqual({
      kind: "file",
      path: "/p",
    })
  })

  test("builds nothing when the spec lacks what the probe needs", () => {
    expect(parserTargetOf("parser-proxy", { host: "h", timeoutMs: 1 })).toBe(
      undefined
    )
    expect(parserTargetOf("parser-proxy", { port: 1, timeoutMs: 1 })).toBe(
      undefined
    )
    expect(parserTargetOf("parser-intent-socket", { timeoutMs: 1 })).toBe(
      undefined
    )
    expect(parserTargetOf("parser-data-db", { timeoutMs: 1 })).toBe(undefined)
  })

  test("the probe document round-trips through the parse child's reader", () => {
    for (const target of [TCP, UNIX, FILE])
      expect(
        readParserTarget(parserProbeDocument(target).toString("utf8"))
      ).toEqual(target)
  })

  test.each([
    "not json",
    "null",
    '{"kind":"tcp","host":"h","timeoutMs":1}',
    '{"kind":"tcp","host":"h","port":"1","timeoutMs":1}',
    '{"kind":"unix","path":"/p"}',
    '{"kind":"file"}',
    '{"kind":"exec","path":"/bin/sh"}',
  ])("the parse child refuses the document %s", (text) => {
    expect(readParserTarget(text)).toBeUndefined()
  })

  test("names the five broker probes", () => {
    expect(isParserProbeName("parser-proxy")).toBe(true)
    expect(isParserProbeName("proxy")).toBe(false)
    expect(isParserProbeName(undefined)).toBe(false)
  })
})

describe("the parse child's attempt, against real targets", () => {
  let dir = ""
  let server: Server | undefined
  let port = 0
  let accepted = 0

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "eido-ip-"))
    server = createServer((socket) => {
      accepted += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve)
    )
    const address = server.address()
    port = typeof address === "object" && address !== null ? address.port : 0
  })

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  test("reaches a listener, and the listener saw the connection", async () => {
    const before = accepted
    expect(
      await attempt({ kind: "tcp", host: "127.0.0.1", port, timeoutMs: 2000 })
    ).toEqual({ kind: "tcp", reached: true, code: "OK" })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(accepted).toBeGreaterThan(before)
  })

  test("is refused by a port nothing listens on, with ECONNREFUSED", async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const address = closed.address()
    const closedPort =
      typeof address === "object" && address !== null ? address.port : 0
    await new Promise((resolve) => closed.close(resolve))
    expect(
      await attempt({
        kind: "tcp",
        host: "127.0.0.1",
        port: closedPort,
        timeoutMs: 2000,
      })
    ).toEqual({ kind: "tcp", reached: false, code: "ECONNREFUSED" })
  })

  test("a missing Unix socket is ENOENT", async () => {
    expect(
      await attempt({
        kind: "unix",
        path: join(dir, "none.sock"),
        timeoutMs: 2000,
      })
    ).toEqual({ kind: "unix", reached: false, code: "ENOENT" })
  })

  test("opens a file that exists and reports one that does not", async () => {
    const path = join(dir, "eido-data.db")
    writeFileSync(path, "synthetic")
    expect(await attempt({ kind: "file", path })).toEqual({
      kind: "file",
      reached: true,
      code: "OK",
    })
    expect(await attempt({ kind: "file", path: join(dir, "none.db") })).toEqual(
      {
        kind: "file",
        reached: false,
        code: "ENOENT",
      }
    )
  })
})
