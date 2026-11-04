import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { runThingsScript, MAX_OUTPUT_BYTES } from "./runner"

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }))

class Pipe extends EventEmitter {
  resume = vi.fn()
}

class Child extends EventEmitter {
  stdout = new Pipe()
  stderr = new Pipe()
  kill = vi.fn()
}

let child: Child

beforeEach(() => {
  child = new Child()
  mocked.spawn.mockReset().mockReturnValue(child)
})

describe("runThingsScript process handling", () => {
  test("resolves stdout on exit code 0", async () => {
    const promise = runThingsScript("list-areas", [])
    child.stdout.emit("data", Buffer.from("a-1\x1FArea1"))
    child.emit("close", 0)
    const result = await promise
    expect(result).toBe("a-1\x1FArea1")
    expect(mocked.spawn).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      expect.arrayContaining([
        expect.stringContaining("list-areas.applescript"),
      ]),
      expect.objectContaining({ env: { PATH: "/usr/bin:/bin" } })
    )
  })

  test("rejects with automation_denied when stderr contains -1743", async () => {
    const promise = runThingsScript("list-areas", [])
    child.stderr.emit(
      "data",
      Buffer.from(
        "execution error: Not authorized to send Apple events (-1743)"
      )
    )
    child.emit("close", 1)
    await expect(promise).rejects.toMatchObject({
      code: "automation_denied",
    })
  })

  test("rejects with things_unavailable on non-zero exit", async () => {
    const promise = runThingsScript("list-areas", [])
    child.stderr.emit("data", Buffer.from("Application isn't running (-1719)"))
    child.emit("close", 1)
    await expect(promise).rejects.toMatchObject({
      code: "things_unavailable",
    })
  })

  test("rejects on process error event", async () => {
    const promise = runThingsScript("list-areas", [])
    child.emit("error", new Error("spawn ENOENT"))
    await expect(promise).rejects.toMatchObject({
      code: "things_unavailable",
    })
  })

  test("kills process and rejects when output exceeds limit", async () => {
    const promise = runThingsScript("list-areas", [])
    const hugeChunk = Buffer.alloc(MAX_OUTPUT_BYTES + 10, "x")
    child.stdout.emit("data", hugeChunk)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    await expect(promise).rejects.toMatchObject({
      code: "things_unavailable",
    })
  })

  test("kills process and rejects on timeout", async () => {
    vi.useFakeTimers()
    try {
      const promise = runThingsScript("list-areas", [])
      vi.advanceTimersByTime(11_000)
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      await expect(promise).rejects.toMatchObject({
        code: "things_unavailable",
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
