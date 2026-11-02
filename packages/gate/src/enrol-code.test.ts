import { mkdtempSync, rmSync } from "node:fs"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CONTROL_SOCKET_ENV, enrolCode } from "./enrol-code"
import { close, createGateServer, listen } from "./internal/http"
import { controlHandler } from "./internal/routes"
import { setup, socketAddress } from "./internal/test-fixtures"
import type { Setup } from "./internal/test-fixtures"

let dir: string
let s: Setup
let server: Server
let socket: string
let out: string[]
let err: string[]
const output = {
  out: (line: string) => out.push(line),
  err: (line: string) => err.push(line),
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "eido-enrol-"))
  socket = socketAddress(dir, "control.sock")
  s = setup()
  out = []
  err = []
  server = createGateServer(
    "control",
    controlHandler(
      () => ({ db: s.db, policy: s.policy }),
      () => new Date("2026-10-19T08:00:00.000Z")
    ),
    () => undefined
  )
  await listen(server, socket, 0o600)
})

afterEach(async () => {
  if (server.listening) await close(server)
  s.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

describe("enrol-code", () => {
  it("prints a fresh code and its expiry from the running gate", async () => {
    expect(await enrolCode({ [CONTROL_SOCKET_ENV]: socket }, output)).toBe(0)
    expect(out).toEqual([
      expect.stringMatching(
        /^Enrolment code: [0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/
      ) as unknown,
      "Expires at 2026-10-19T08:10:00.000Z. It works once.",
    ])
    expect(err).toEqual([])
  })

  it("exits 2 when the control socket is not configured", async () => {
    expect(await enrolCode({}, output)).toBe(2)
    expect(err).toEqual([`${CONTROL_SOCKET_ENV} is not set`])
    expect(out).toEqual([])
  })

  it("exits 1 when the gate is not running", async () => {
    await close(server)
    expect(await enrolCode({ [CONTROL_SOCKET_ENV]: socket }, output)).toBe(1)
    expect(err).toEqual(["Could not issue a code: the gate is not reachable"])
    expect(out).toEqual([])
  })
})
