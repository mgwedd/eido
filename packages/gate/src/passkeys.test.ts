import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CONTROL_SOCKET_ENV } from "./enrol-code"
import { close, createGateServer, listen } from "./internal/http"
import { controlHandler } from "./internal/routes"
import { setup, socketAddress } from "./internal/test-fixtures"
import type { Setup } from "./internal/test-fixtures"
import { passkeys } from "./passkeys"

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

const fingerprint = (id: string) =>
  createHash("sha256").update(id, "utf8").digest("hex")

function enrol(id: string, createdAt: string): string {
  s.db
    .prepare(
      "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, 'AA', 0, ?)"
    )
    .run(id, createdAt)
  return fingerprint(id)
}

function revokedAt(id: string): unknown {
  return s.db
    .prepare("SELECT revoked_at FROM credentials WHERE credential_id = ?")
    .get(id)?.["revoked_at"]
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "eido-passkeys-"))
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

const env = () => ({ [CONTROL_SOCKET_ENV]: socket })

describe("passkeys", () => {
  it("says when no passkey is enrolled", async () => {
    expect(await passkeys([], env(), output)).toBe(0)
    expect(out).toEqual(["No passkeys are enrolled."])
  })

  it("lists each passkey by its short fingerprint and state", async () => {
    const fp = enrol("Y3JlZC1vbmU", "2026-10-01T00:00:00.000Z")
    expect(await passkeys([], env(), output)).toBe(0)
    expect(out).toEqual([
      `${fp.slice(0, 8)}  enrolled 2026-10-01T00:00:00.000Z  active`,
    ])
  })

  it("revokes the passkey a unique prefix names, in any case", async () => {
    const fp = enrol("Y3JlZC1vbmU", "2026-10-01T00:00:00.000Z")
    enrol("Y3JlZC10d28", "2026-10-02T00:00:00.000Z")
    const prefix = fp.slice(0, 8)
    expect(
      await passkeys(["revoke", prefix.toUpperCase()], env(), output)
    ).toBe(0)
    expect(out[0]).toBe(`Revoked ${prefix}. That phone is signed out.`)
    expect(out[1]).toMatch(new RegExp(`^${prefix}  enrolled .*  revoked `))
    expect(out[2]).toMatch(/ {2}active$/)
    expect(revokedAt("Y3JlZC1vbmU")).toEqual(expect.any(String))
    expect(revokedAt("Y3JlZC10d28")).toBeNull()
  })

  it("exits 1 and revokes nothing when no passkey matches", async () => {
    enrol("Y3JlZC1vbmU", "2026-10-01T00:00:00.000Z")
    const absent = fingerprint("Y3JlZC1vbmU").startsWith("00000000")
      ? "11111111"
      : "00000000"
    expect(await passkeys(["revoke", absent], env(), output)).toBe(1)
    expect(err).toEqual([`No passkey has a fingerprint starting ${absent}.`])
    expect(revokedAt("Y3JlZC1vbmU")).toBeNull()
  })

  it("exits 1 when the gate refuses, for an already revoked passkey", async () => {
    const fp = enrol("Y3JlZC1vbmU", "2026-10-01T00:00:00.000Z")
    expect(await passkeys(["revoke", fp], env(), output)).toBe(0)
    err = []
    expect(await passkeys(["revoke", fp], env(), output)).toBe(1)
    expect(err).toEqual([
      "Could not reach the passkeys: the passkey is already revoked",
    ])
  })

  it.each([
    ["an unknown command", ["remove", "abcdef12"]],
    ["a prefix under 8 characters", ["revoke", "abcdef1"]],
    ["a prefix that is not hex", ["revoke", "abcdefgh"]],
    ["no fingerprint", ["revoke"]],
  ])("exits 2 on %s", async (_name, args) => {
    expect(await passkeys(args, env(), output)).toBe(2)
    expect(err[0]).toBe("usage: passkeys [revoke <fingerprint>]")
  })

  it("exits 2 when the control socket is not configured", async () => {
    expect(await passkeys([], {}, output)).toBe(2)
    expect(err).toEqual([`${CONTROL_SOCKET_ENV} is not set`])
  })

  it("exits 1 when the gate is not running", async () => {
    await close(server)
    expect(await passkeys([], env(), output)).toBe(1)
    expect(err).toEqual([
      "Could not reach the passkeys: the gate is not reachable",
    ])
  })
})
