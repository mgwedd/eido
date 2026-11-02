import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { lstat } from "node:fs/promises"
import { runKeychainCommand } from "./keychain-bridge"
import { KeychainVault } from "./keychain-vault"

vi.mock("./keychain-bridge", () => ({ runKeychainCommand: vi.fn() }))
vi.mock("node:fs/promises", () => ({ lstat: vi.fn() }))
const run = vi.mocked(runKeychainCommand)
const fileStat = vi.mocked(lstat)
const platform = process.platform
const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid")
const KEY = { connector: "mail", kind: "password", client: "none" } as const
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" })
  Object.defineProperty(process, "getuid", {
    value: () => 12345,
    configurable: true,
  })
  const info = statSync(fileURLToPath(import.meta.url))
  info.uid = 12345
  info.mode = 0o100600
  fileStat.mockReset().mockResolvedValue(info)
  run.mockReset()
})
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform })
  if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor)
  else Reflect.deleteProperty(process, "getuid")
})

test.each(["missing", "permissions", "owner", "symlink", "unknown-uid"])(
  "rejects %s keychain paths without invoking native access",
  async (kind) => {
    const info = statSync(fileURLToPath(import.meta.url))
    info.uid = kind === "owner" ? 99999 : 12345
    info.mode =
      kind === "symlink"
        ? 0o120600
        : kind === "permissions"
          ? 0o100644
          : 0o100600
    if (kind === "missing")
      fileStat.mockRejectedValue(new Error("private-marker"))
    else fileStat.mockResolvedValue(info)
    if (kind === "unknown-uid") Reflect.deleteProperty(process, "getuid")
    await expect(
      new KeychainVault({ path: "/test.keychain-db" }).get(KEY)
    ).rejects.toThrow(
      "Keychain file must exist, be private, and belong to the gate user"
    )
    expect(run).not.toHaveBeenCalled()
  }
)

test("requires macOS and an explicit absolute keychain path", () => {
  Object.defineProperty(process, "platform", { value: "linux" })
  expect(() => new KeychainVault({ path: "/test.keychain-db" })).toThrow(
    "requires macOS"
  )
  Object.defineProperty(process, "platform", { value: "darwin" })
  expect(() => new KeychainVault({ path: "relative" })).toThrow("absolute")
  expect(() => new KeychainVault({ path: "/bad\0path" })).toThrow("NUL")
})
test("uses collision-free accounts and encodes secret bytes only in the request", async () => {
  run.mockResolvedValue({ status: 0 })
  await new KeychainVault({ path: "/test.keychain-db" }).set(KEY, "private\n🔐")
  expect(run.mock.calls[0]).toEqual([
    {
      operation: "set",
      path: "/test.keychain-db",
      account: '["mail","password","none"]',
      data: Buffer.from("private\n🔐", "utf16le").toString("base64"),
    },
  ])
})
test("reads valid data and treats missing credentials as absent", async () => {
  run
    .mockResolvedValueOnce({ status: 0, data: "cwBlAGMAcgBlAHQA" })
    .mockResolvedValueOnce({ status: -25300 })
  const vault = new KeychainVault({ path: "/test.keychain-db" })
  expect(await vault.get(KEY)).toBe("secret")
  expect(await vault.get(KEY)).toBeUndefined()
})

test("refuses a secret that cannot safely fit the bounded read-back response", async () => {
  await expect(
    new KeychainVault({ path: "/test.keychain-db" }).set(
      KEY,
      "x".repeat(128 * 1024 + 1)
    )
  ).rejects.toThrow("Keychain credential is too large")
  expect(run).not.toHaveBeenCalled()
})
test.each([
  { status: -1 },
  { status: 0 },
  { status: 0, data: "%%%" },
  { status: 0, data: "eA==" },
])("rejects failed or malformed native reads %#", async (reply) => {
  run.mockResolvedValue(reply)
  await expect(
    new KeychainVault({ path: "/test.keychain-db" }).get(KEY)
  ).rejects.toThrow("Keychain credential")
})
test("write/delete failures expose only static messages", async () => {
  run.mockResolvedValue({ status: -25293 })
  const vault = new KeychainVault({ path: "/test.keychain-db" })
  await expect(vault.set(KEY, "private-marker")).rejects.toThrow(
    "Keychain credential could not be stored"
  )
  await expect(vault.delete(KEY)).rejects.toThrow(
    "Keychain credential could not be deleted"
  )
  run.mockResolvedValue({ status: -25300 })
  await expect(vault.delete(KEY)).resolves.toBeUndefined()
  run.mockResolvedValue({ status: 0 })
  await expect(vault.delete(KEY)).resolves.toBeUndefined()
})
