import { EventEmitter } from "node:events"
import { beforeEach, expect, test, vi } from "vitest"
import { runKeychainCommand } from "./keychain-bridge"

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }))
class Pipe extends EventEmitter {
  end = vi.fn<(value: string) => void>()
  resume = vi.fn()
}
class Child extends EventEmitter {
  stdin = new Pipe()
  stdout = new Pipe()
  stderr = new Pipe()
  kill = vi.fn()
}
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
  expect(mocked.spawn.mock.calls[0]?.[0]).toBe("/usr/bin/osascript")
  expect(JSON.stringify(mocked.spawn.mock.calls[0])).not.toContain(
    "private-encoded-marker"
  )
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
