import { statSync } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import {
  KeychainUnlockError,
  readPassphrase,
  unlockFromStdin,
} from "./keychain-unlock"

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), realpath: vi.fn() }))
const fileStat = vi.mocked(lstat)
const realDirectory = vi.mocked(realpath)
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid")
const PASSPHRASE = "synthetic-stdin-passphrase"
const PATH_REFUSED =
  "Keychain file must exist, be private, belong to the gate user, and not be a login or System keychain"

async function* chunks(...parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) {
    await Promise.resolve()
    yield part
  }
}
async function failure(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(KeychainUnlockError)
  return error instanceof KeychainUnlockError
    ? { reason: error.reason, message: error.message }
    : undefined
}

beforeEach(() => {
  Object.defineProperty(process, "getuid", {
    value: () => 12345,
    configurable: true,
  })
  const info = statSync(fileURLToPath(import.meta.url))
  info.uid = 12345
  info.mode = 0o100600
  fileStat.mockReset().mockResolvedValue(info)
  realDirectory
    .mockReset()
    .mockImplementation((path) => Promise.resolve(String(path)))
})
afterEach(() => {
  if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor)
  else Reflect.deleteProperty(process, "getuid")
})

test("reads the passphrase across chunks, drops one trailing newline and zeroes the chunks", async () => {
  const first = Buffer.from("synthetic-")
  const second = Buffer.from("stdin-passphrase\n")
  const passphrase = await readPassphrase(chunks(first, second))
  expect(passphrase.toString("utf8")).toBe(PASSPHRASE)
  expect([...first, ...second].every((byte) => byte === 0)).toBe(true)
})

test.each([
  ["a trailing CRLF", "abc\r\n", "abc"],
  ["a CRLF split across chunks", ["abc\r", "\n"], "abc"],
  [
    "inner and leading whitespace, keeping all but one newline",
    " a b\n\n",
    " a b\n",
  ],
  ["a lone CR", "abc\r", "abc\r"],
])("keeps the exact bytes with %s", async (_name, input, expected) => {
  const parts = (Array.isArray(input) ? input : [input]).map((part) =>
    Buffer.from(part)
  )
  const passphrase = await readPassphrase(chunks(...parts))
  expect(passphrase.toString("utf8")).toBe(expected)
})

test.each([
  ["empty", [], "Keychain passphrase on stdin is empty"],
  [
    "a lone newline",
    [Buffer.from("\n")],
    "Keychain passphrase on stdin is empty",
  ],
  [
    "a lone CRLF",
    [Buffer.from("\r\n")],
    "Keychain passphrase on stdin is empty",
  ],
  [
    "text chunks",
    ["not bytes"],
    "Keychain passphrase must arrive as bytes on stdin",
  ],
  [
    "4097 bytes after the line end is dropped",
    [Buffer.alloc(4097, 0x61), Buffer.from("\n")],
    "Keychain passphrase on stdin is too long",
  ],
  [
    "more than the limit and a CRLF",
    [Buffer.alloc(4000, 0x61), Buffer.alloc(99, 0x61)],
    "Keychain passphrase on stdin is too long",
  ],
])("refuses %s input", async (_name, parts, message) => {
  expect(await failure(readPassphrase(chunks(...parts)))).toEqual({
    reason: "input",
    message,
  })
})

test.each([
  ["no line end", ""],
  ["a newline", "\n"],
  ["a CRLF", "\r\n"],
])("accepts a passphrase of exactly 4096 bytes with %s", async (_name, end) => {
  const passphrase = await readPassphrase(
    chunks(Buffer.alloc(4096, 0x61), Buffer.from(end))
  )
  expect(passphrase.equals(Buffer.alloc(4096, 0x61))).toBe(true)
})

test("gives up on a pipe that is never closed, with a fixed error, and destroys it", async () => {
  const stdin = new PassThrough()
  stdin.write(Buffer.from(PASSPHRASE))
  expect(await failure(readPassphrase(stdin, 20))).toEqual({
    reason: "timeout",
    message: "Keychain passphrase did not arrive on stdin in time",
  })
  expect(stdin.destroyed).toBe(true)
})

test("gives up on an input that never yields", async () => {
  const stalled: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<unknown>>(() => undefined),
    }),
  }
  const unlock = vi.fn()
  expect(
    await failure(unlockFromStdin("/test.keychain-db", stalled, unlock, 20))
  ).toEqual({
    reason: "timeout",
    message: "Keychain passphrase did not arrive on stdin in time",
  })
  expect(unlock).not.toHaveBeenCalled()
})

test("refuses a terminal on stdin before reading it", async () => {
  const read = vi.fn()
  const terminal = Object.assign(chunks(Buffer.from(PASSPHRASE)), {
    isTTY: true,
    next: read,
  })
  const unlock = vi.fn()
  expect(
    await failure(unlockFromStdin("/test.keychain-db", terminal, unlock))
  ).toEqual({
    reason: "tty",
    message: "Keychain passphrase must come from a pipe, not a terminal",
  })
  expect(read).not.toHaveBeenCalled()
  expect(unlock).not.toHaveBeenCalled()
})

test("passes the stdin bytes to the unlock and zeroes them afterwards", async () => {
  let seen: Uint8Array | undefined
  let seenText = ""
  const unlock = vi.fn((_path: string, passphrase: Uint8Array) => {
    seen = passphrase
    seenText = Buffer.from(passphrase).toString("utf8")
    return Promise.resolve("unlocked" as const)
  })
  await unlockFromStdin(
    "/test.keychain-db",
    chunks(Buffer.from(`${PASSPHRASE}\n`)),
    unlock
  )
  expect(unlock.mock.calls[0]?.[0]).toBe("/test.keychain-db")
  expect(seenText).toBe(PASSPHRASE)
  expect(seen?.every((byte) => byte === 0)).toBe(true)
})

test("a rejected passphrase throws a fixed locked error and the bytes are zeroed", async () => {
  let seen: Uint8Array | undefined
  const unlock = vi.fn((_path: string, passphrase: Uint8Array) => {
    seen = passphrase
    return Promise.resolve("locked" as const)
  })
  expect(
    await failure(
      unlockFromStdin(
        "/test.keychain-db",
        chunks(Buffer.from(PASSPHRASE)),
        unlock
      )
    )
  ).toEqual({
    reason: "locked",
    message: "Gate keychain is still locked: the passphrase was rejected",
  })
  expect(seen?.every((byte) => byte === 0)).toBe(true)
})

test("a helper failure becomes a fixed helper error", async () => {
  const unlock = vi.fn(() =>
    Promise.reject(new Error(`helper said ${PASSPHRASE}`))
  )
  expect(
    await failure(
      unlockFromStdin(
        "/test.keychain-db",
        chunks(Buffer.from(PASSPHRASE)),
        unlock
      )
    )
  ).toEqual({ reason: "helper", message: "Keychain could not be unlocked" })
})

test.each(["missing", "group-readable", "other-owner", "unresolvable"])(
  "refuses a %s keychain file before sending the passphrase anywhere",
  async (kind) => {
    const info = statSync(fileURLToPath(import.meta.url))
    info.uid = kind === "other-owner" ? 99999 : 12345
    info.mode = kind === "group-readable" ? 0o100640 : 0o100600
    if (kind === "missing") fileStat.mockRejectedValue(new Error("ENOENT"))
    else fileStat.mockResolvedValue(info)
    if (kind === "unresolvable")
      realDirectory.mockRejectedValue(new Error("ENOENT"))
    const unlock = vi.fn()
    expect(
      await failure(
        unlockFromStdin(
          "/test.keychain-db",
          chunks(Buffer.from(PASSPHRASE)),
          unlock
        )
      )
    ).toEqual({ reason: "path", message: PATH_REFUSED })
    expect(unlock).not.toHaveBeenCalled()
  }
)

test.each([
  ["the login keychain directory", join(homedir(), "Library", "Keychains")],
  [
    "the login directory with a trailing slash",
    `${join(homedir(), "Library", "Keychains")}/`,
  ],
  ["the System keychain directory", "/Library/Keychains"],
  ["the System directory in another case", "/library/KEYCHAINS"],
])(
  "refuses a keychain in %s, where auto-lock must stay on",
  async (_name, directory) => {
    realDirectory.mockResolvedValue(directory)
    const unlock = vi.fn()
    expect(
      await failure(
        unlockFromStdin(
          "/linked/gate.keychain-db",
          chunks(Buffer.from(PASSPHRASE)),
          unlock
        )
      )
    ).toEqual({ reason: "path", message: PATH_REFUSED })
    expect(realDirectory).toHaveBeenCalledWith("/linked")
    expect(unlock).not.toHaveBeenCalled()
  }
)

test.each([
  [
    "the gate's own keychain folder",
    join(homedir(), "Library", "Keychains", "eido"),
  ],
  ["a folder that only starts like the System one", "/Library/KeychainsGate"],
])("accepts a keychain in %s", async (_name, directory) => {
  realDirectory.mockResolvedValue(directory)
  const unlock = vi.fn(() => Promise.resolve("unlocked" as const))
  await unlockFromStdin(
    "/linked/gate.keychain-db",
    chunks(Buffer.from(PASSPHRASE)),
    unlock
  )
  expect(unlock).toHaveBeenCalledOnce()
})
