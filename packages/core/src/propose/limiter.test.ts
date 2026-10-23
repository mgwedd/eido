import { describe, expect, test } from "vitest"
import { createProposalLimiter } from "./limiter"

const HOUR = 60 * 60 * 1000

describe("createProposalLimiter", () => {
  test("allows the cap within an hour, then refuses", () => {
    let now = 0
    const limiter = createProposalLimiter({
      maxProposalsPerHour: 2,
      now: () => now,
    })
    expect([
      limiter.tryAcquire(),
      limiter.tryAcquire(),
      limiter.tryAcquire(),
    ]).toEqual([true, true, false])
    now = HOUR - 1
    expect(limiter.tryAcquire()).toBe(false)
  })

  test("a slot frees an hour after it was taken", () => {
    let now = 0
    const limiter = createProposalLimiter({
      maxProposalsPerHour: 1,
      now: () => now,
    })
    expect(limiter.tryAcquire()).toBe(true)
    now = HOUR
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false)
  })

  test("a refused request does not take a slot", () => {
    let now = 0
    const limiter = createProposalLimiter({
      maxProposalsPerHour: 1,
      now: () => now,
    })
    limiter.tryAcquire()
    now = HOUR / 2
    limiter.tryAcquire()
    now = HOUR
    expect(limiter.tryAcquire()).toBe(true)
  })

  test("uses the wall clock by default", () => {
    const limiter = createProposalLimiter({ maxProposalsPerHour: 1 })
    expect([limiter.tryAcquire(), limiter.tryAcquire()]).toEqual([true, false])
  })

  test.each([0, 1.5, Number.NaN])("refuses a cap of %s", (max) => {
    expect(() => createProposalLimiter({ maxProposalsPerHour: max })).toThrow(
      RangeError
    )
  })
})
