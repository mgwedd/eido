import { statSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { readPassphrase, unlockFromStdin } from "./keychain-unlock"

vi.mock("node:fs/promises", () => ({ lstat: vi.fn() }))
const fileStat = vi.mocked(lstat)
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid")
const PASSPHRASE = "synthetic-stdin-passphrase"

async function* chunks(...parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) {
    await Promise.resolve()
    yield part
  }
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

test("keeps inner and leading whitespace and all but one trailing newline", async () => {
  const passphrase = await readPassphrase(chunks(Buffer.from(" a b\n\n")))
  expect(passphrase.toString("utf8")).toBe(" a b\n")
})

test.each([
  ["empty", [], "Keychain passphrase on stdin is empty"],
  [
    "a lone newline",
    [Buffer.from("\n")],
    "Keychain passphrase on stdin is empty",
  ],
  ["text chunks", ["not bytes"], "must arrive as bytes on stdin"],
  [
    "over 4096 bytes",
    [Buffer.alloc(4000, 0x61), Buffer.alloc(97, 0x61)],
    "Keychain passphrase on stdin is too long",
  ],
])("refuses %s input", async (_name, parts, message) => {
  await expect(readPassphrase(chunks(...parts))).rejects.toThrow(message)
})

test("accepts a passphrase of exactly 4096 bytes", async () => {
  const passphrase = await readPassphrase(chunks(Buffer.alloc(4096, 0x61)))
  expect(passphrase.length).toBe(4096)
})

test("passes the stdin bytes to the unlock and zeroes them afterwards", async () => {
  let seen: Uint8Array | undefined
  let seenText = ""
  const unlock = vi.fn((path: string, passphrase: Uint8Array) => {
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

test("a rejected passphrase throws a locked error that does not contain it", async () => {
  let seen: Uint8Array | undefined
  const unlock = vi.fn((_path: string, passphrase: Uint8Array) => {
    seen = passphrase
    return Promise.resolve("locked" as const)
  })
  const error: unknown = await unlockFromStdin(
    "/test.keychain-db",
    chunks(Buffer.from(PASSPHRASE)),
    unlock
  ).catch((e: unknown) => e)
  expect(String(error)).toBe(
    "Error: Gate keychain is still locked: the passphrase was rejected"
  )
  expect(seen?.every((byte) => byte === 0)).toBe(true)
})

test.each(["missing", "group-readable", "other-owner"])(
  "refuses a %s keychain file before sending the passphrase anywhere",
  async (kind) => {
    const info = statSync(fileURLToPath(import.meta.url))
    info.uid = kind === "other-owner" ? 99999 : 12345
    info.mode = kind === "group-readable" ? 0o100640 : 0o100600
    if (kind === "missing") fileStat.mockRejectedValue(new Error("ENOENT"))
    else fileStat.mockResolvedValue(info)
    const unlock = vi.fn()
    await expect(
      unlockFromStdin(
        "/test.keychain-db",
        chunks(Buffer.from(PASSPHRASE)),
        unlock
      )
    ).rejects.toThrow(
      "Keychain file must exist, be private, and belong to the gate user"
    )
    expect(unlock).not.toHaveBeenCalled()
  }
)
