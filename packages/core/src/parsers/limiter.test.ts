import { describe, expect, it } from "vitest"
import { createLimiter } from "./limiter"

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("createLimiter", () => {
  it("runs at most max tasks at once, the rest in arrival order", async () => {
    const limit = createLimiter(2)
    let running = 0
    let peak = 0
    const started: number[] = []
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const runs = gates.map((gate, index) =>
      limit(async () => {
        started.push(index)
        running += 1
        peak = Math.max(peak, running)
        await gate.promise
        running -= 1
        return index
      })
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[1]?.resolve()
    await runs[1]
    // A newcomer arriving now must queue behind task 2, which inherited the slot.
    const late = limit(() => {
      started.push(9)
      return Promise.resolve(9)
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual([0, 1, 2])
    for (const gate of gates) gate.resolve()
    expect(await Promise.all([...runs, late])).toEqual([0, 1, 2, 3, 9])
    expect(started).toEqual([0, 1, 2, 3, 9])
    expect(peak).toBe(2)
  })

  it("frees the slot when a task throws", async () => {
    const limit = createLimiter(1)
    await expect(
      limit(() => Promise.reject(new Error("lorem")))
    ).rejects.toThrow("lorem")
    expect(await limit(() => Promise.resolve("next"))).toBe("next")
  })
})
