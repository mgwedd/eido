import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocked = vi.hoisted(() => ({
  spawnSync:
    vi.fn<
      (file: string, argv: string[], options: { input: string }) => unknown
    >(),
}))
vi.mock("node:child_process", () => ({ spawnSync: mocked.spawnSync }))

import { KeychainControlStore } from "./keychain-checkpoint"

const NOT_FOUND = -25300
let dir: string
let path: string
let platform: PropertyDescriptor | undefined

// Windows has no owner or mode bits to check, so there the file check is replaced; the check
// itself is exercised on POSIX hosts below.
const WINDOWS = process.platform === "win32"
function open(): KeychainControlStore {
  return new KeychainControlStore(
    WINDOWS ? { path, checkFile: () => undefined } : { path }
  )
}

function reply(value: unknown) {
  return { status: 0, stdout: Buffer.from(JSON.stringify(value)) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-keychain-checkpoint-"))
  path = join(dir, "gate.keychain-db")
  writeFileSync(path, "", { mode: 0o600 })
  chmodSync(path, 0o600)
  mocked.spawnSync.mockReset()
  platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "darwin" })
})

afterEach(() => {
  if (platform !== undefined)
    Object.defineProperty(process, "platform", platform)
  rmSync(dir, { recursive: true, force: true })
})

describe("KeychainControlStore", () => {
  it("reads the checkpoint item through the Keychain bridge with the request on stdin only", () => {
    mocked.spawnSync.mockReturnValue(
      reply({ status: 0, data: Buffer.from("record-text").toString("base64") })
    )
    expect(open().load()).toBe("record-text")
    const call = mocked.spawnSync.mock.calls[0]
    expect(call?.[0]).toBe("/usr/bin/osascript")
    expect(JSON.parse(String(call?.[2].input))).toEqual({
      operation: "get",
      path,
      account: "eido.control-checkpoint.v1",
    })
    expect(JSON.stringify(call?.[1])).not.toContain(path)
  })

  it("reports a missing item as an uninitialised store", () => {
    mocked.spawnSync.mockReturnValue(reply({ status: NOT_FOUND }))
    expect(open().load()).toBeUndefined()
  })

  it("throws, never guesses, when the item cannot be read", () => {
    mocked.spawnSync.mockReturnValue(reply({ status: -25293 }))
    expect(() => open().load()).toThrow("control checkpoint could not be read")
    mocked.spawnSync.mockReturnValue(reply({ status: 0, data: "not base64!" }))
    expect(() => open().load()).toThrow(
      "control checkpoint encoding is invalid"
    )
  })

  it("writes the item and accepts it only when it reads back identically", () => {
    const text = '{"generation":2}'
    mocked.spawnSync
      .mockReturnValueOnce(reply({ status: 0 }))
      .mockReturnValueOnce(
        reply({ status: 0, data: Buffer.from(text).toString("base64") })
      )
    open().save(text)
    expect(
      JSON.parse(String(mocked.spawnSync.mock.calls[0]?.[2].input))
    ).toEqual({
      operation: "set",
      path,
      account: "eido.control-checkpoint.v1",
      data: Buffer.from(text).toString("base64"),
    })

    mocked.spawnSync.mockReset()
    mocked.spawnSync
      .mockReturnValueOnce(reply({ status: 0 }))
      .mockReturnValueOnce(
        reply({ status: 0, data: Buffer.from("older").toString("base64") })
      )
    expect(() => open().save(text)).toThrow(
      "control checkpoint did not read back"
    )
  })

  it("throws when the write is refused or the helper fails", () => {
    mocked.spawnSync.mockReturnValue(reply({ status: -25308 }))
    expect(() => open().save("x")).toThrow(
      "control checkpoint could not be stored"
    )
    mocked.spawnSync.mockReturnValue({ status: 1, stdout: Buffer.from("") })
    expect(() => open().load()).toThrow("Keychain helper failed")
    mocked.spawnSync.mockReturnValue({
      status: null,
      error: new Error("timed out"),
      stdout: Buffer.from(""),
    })
    expect(() => open().load()).toThrow("Keychain helper failed")
    mocked.spawnSync.mockReturnValue(reply({ nonsense: true }))
    expect(() => open().load()).toThrow("Keychain helper failed")
  })

  it.skipIf(WINDOWS)("refuses a Keychain file that is not private", () => {
    chmodSync(path, 0o644)
    expect(() => open().load()).toThrow(
      "Keychain file must exist, be private, and belong to the gate user"
    )
    expect(mocked.spawnSync).not.toHaveBeenCalled()
  })

  it("refuses a path that is not absolute", () => {
    expect(
      () => new KeychainControlStore({ path: "relative.keychain" })
    ).toThrow("Keychain path must be absolute and contain no NUL")
  })

  it("is macOS only", () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    expect(() => open()).toThrow("Keychain control store requires macOS")
  })
})
