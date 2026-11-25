import { EventEmitter } from "node:events"
import { beforeEach, expect, test, vi } from "vitest"
import {
  base64Bytes,
  KEYCHAIN_SCRIPT,
  runKeychainCommand,
  unlockKeychain,
} from "./keychain-bridge"

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }))
class Pipe extends EventEmitter {
  end = vi.fn<(value: string | Buffer) => void>()
  resume = vi.fn()
}
class Child extends EventEmitter {
  stdin = new Pipe()
  stdout = new Pipe()
  stderr = new Pipe()
  kill = vi.fn()
}
// The whole spawn call: fixed source in argv, a PATH-only environment. Any request byte or extra
// environment key in it fails the comparison.
const SPAWN_CALL = [
  "/usr/bin/osascript",
  ["-l", "JavaScript", "-e", KEYCHAIN_SCRIPT],
  { stdio: "pipe", timeout: 10_000, env: { PATH: "/usr/bin:/bin" } },
]
let child: Child
beforeEach(() => {
  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
})
const command = {
  operation: "set",
  path: "/test.keychain-db",
  account: "test",
  data: "private-encoded-marker",
} as const
test("keeps the secret out of argv and returns only a validated native reply", async () => {
  const result = runKeychainCommand(command)
  expect(mocked.spawn.mock.calls).toEqual([SPAWN_CALL])
  expect(child.stdin.end.mock.calls[0]?.[0]).toBe(JSON.stringify(command))
  expect(child.stderr.resume).toHaveBeenCalledOnce()
  child.stdout.emit("data", Buffer.from('{"status":0}'))
  child.emit("close", 0)
  expect(await result).toEqual({ status: 0 })
})
test.each([
  "not-json",
  '{"status":"private-marker"}',
  '{"status":0,"unexpected":"private-marker"}',
])("rejects malformed replies without reflecting bytes: %s", async (text) => {
  const result = runKeychainCommand(command)
  child.stdout.emit("data", Buffer.from(text))
  child.emit("close", 0)
  await expect(result).rejects.toThrow("Keychain helper failed")
})
test.each(["spawn", "stdin", "exit", "overflow", "invalid-stream"])(
  "sanitizes %s failures",
  async (kind) => {
    const result = runKeychainCommand(command)
    if (kind === "spawn") child.emit("error", new Error("private-marker"))
    else if (kind === "stdin")
      child.stdin.emit("error", new Error("private-marker"))
    else if (kind === "exit") child.emit("close", 1)
    else {
      child.stdout.emit(
        "data",
        kind === "overflow" ? Buffer.alloc(1024 * 1024 + 1) : "private-marker"
      )
      expect(child.kill).toHaveBeenCalledOnce()
      child.emit("close", 0)
    }
    await expect(result).rejects.toThrow("Keychain helper failed")
  }
)

const PASSPHRASE = 'synthetic unlock "phrase" é'
function requestBytes(): Buffer {
  const sent: unknown = child.stdin.end.mock.calls[0]?.[0]
  if (!Buffer.isBuffer(sent)) throw new Error("request was not bytes")
  return Buffer.from(sent)
}
test("sends the unlock passphrase only on stdin, base64 in the request, and zeroes the request", async () => {
  const result = unlockKeychain(
    "/test.keychain-db",
    Buffer.from(PASSPHRASE, "utf8")
  )
  expect(mocked.spawn.mock.calls).toEqual([SPAWN_CALL])
  const sent = child.stdin.end.mock.calls[0]?.[0]
  expect(JSON.parse(requestBytes().toString("utf8"))).toEqual({
    operation: "unlock",
    path: "/test.keychain-db",
    data: Buffer.from(PASSPHRASE, "utf8").toString("base64"),
  })
  child.stdout.emit("data", Buffer.from('{"status":0,"unlock":"unlocked"}'))
  child.emit("close", 0)
  expect(await result).toBe("unlocked")
  expect(Buffer.isBuffer(sent) && sent.every((byte) => byte === 0)).toBe(true)
})
test("maps a rejected passphrase to the typed locked result", async () => {
  const result = unlockKeychain("/test.keychain-db", Buffer.from("wrong"))
  child.stdout.emit("data", Buffer.from('{"status":-25293,"unlock":"locked"}'))
  child.emit("close", 0)
  expect(await result).toBe("locked")
})
test.each([
  '{"status":-25294}',
  '{"status":0}',
  '{"status":-1,"unlock":"unlocked"}',
])("fails any other unlock reply without the passphrase: %s", async (reply) => {
  const result = unlockKeychain("/test.keychain-db", Buffer.from(PASSPHRASE))
  child.stdout.emit("data", Buffer.from(reply))
  child.emit("close", 0)
  const error: unknown = await result.catch((e: unknown) => e)
  expect(String(error)).toBe("Error: Keychain could not be unlocked")
})
test("zeroes the unlock request when the helper fails", async () => {
  const result = unlockKeychain("/test.keychain-db", Buffer.from(PASSPHRASE))
  const sent = child.stdin.end.mock.calls[0]?.[0]
  child.emit("close", 1)
  await expect(result).rejects.toThrow("Keychain helper failed")
  expect(Buffer.isBuffer(sent) && sent.every((byte) => byte === 0)).toBe(true)
})
test.each([
  ["", ""],
  ["f", "Zg=="],
  ["fo", "Zm8="],
  ["foo", "Zm9v"],
  ["ÿþýü", "w7/DvsO9w7w="],
])("encodes %j as standard base64 %s", (text, expected) => {
  expect(base64Bytes(Buffer.from(text, "utf8")).toString("latin1")).toBe(
    expected
  )
})
