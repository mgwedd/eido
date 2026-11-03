import { describe, expect, it } from "vitest"
import { parseSyncTime, SIMPLEFIN_SYNC_INTERVAL_MS } from "./config"
import {
  lastScheduledAt,
  nextLocalMidnight,
  nextScheduledAt,
  nextSyncAtMs,
  syncDue,
} from "./schedule"

// Local times are built with the local Date constructor, so the expectations hold in any host
// time zone. July avoids the daylight-saving changes of most zones.
const local = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 6, day, hour, minute).getTime()
const SIX_THIRTY = { hour: 6, minute: 30 }

describe("parseSyncTime", () => {
  it("reads HH:MM on a 24-hour clock", () => {
    expect(parseSyncTime("06:30")).toEqual({ hour: 6, minute: 30 })
    expect(parseSyncTime("6:05")).toEqual({ hour: 6, minute: 5 })
    expect(parseSyncTime(" 23:59 ")).toEqual({ hour: 23, minute: 59 })
    expect(parseSyncTime("00:00")).toEqual({ hour: 0, minute: 0 })
  })

  it("refuses anything else", () => {
    for (const bad of ["24:00", "6:60", "6", "06:30pm", "", "6:5", "noon"]) {
      expect(parseSyncTime(bad)).toBeUndefined()
    }
  })
})

describe("scheduled occurrences", () => {
  it("the latest one is today's once its time has come, else yesterday's", () => {
    expect(lastScheduledAt(local(2, 6, 29), SIX_THIRTY)).toBe(local(1, 6, 30))
    expect(lastScheduledAt(local(2, 6, 30), SIX_THIRTY)).toBe(local(2, 6, 30))
    expect(lastScheduledAt(local(2, 23, 0), SIX_THIRTY)).toBe(local(2, 6, 30))
  })

  it("the next one is strictly after now", () => {
    expect(nextScheduledAt(local(2, 6, 29), SIX_THIRTY)).toBe(local(2, 6, 30))
    expect(nextScheduledAt(local(2, 6, 30), SIX_THIRTY)).toBe(local(3, 6, 30))
  })

  it("the budget resets at the next local midnight", () => {
    expect(nextLocalMidnight(local(2, 23, 59))).toBe(local(3, 0))
    expect(nextLocalMidnight(local(3, 0))).toBe(local(4, 0))
  })
})

describe("syncDue", () => {
  it("is due when nothing has synced yet", () => {
    expect(syncDue(local(2, 12), undefined, SIX_THIRTY)).toBe(true)
    expect(syncDue(local(2, 12), undefined, undefined)).toBe(true)
  })

  it("with a time, is due once its occurrence has passed with no sync since", () => {
    const last = local(1, 6, 31)
    expect(syncDue(local(2, 6, 29), last, SIX_THIRTY)).toBe(false)
    expect(syncDue(local(2, 6, 30), last, SIX_THIRTY)).toBe(true)
  })

  it("with a time, a sync on request after the occurrence satisfies it", () => {
    expect(syncDue(local(2, 20), local(2, 9), SIX_THIRTY)).toBe(false)
  })

  it("without a time, is due once the interval has passed", () => {
    const last = local(2, 0)
    expect(syncDue(last + SIMPLEFIN_SYNC_INTERVAL_MS - 1, last, undefined)).toBe(
      false
    )
    expect(syncDue(last + SIMPLEFIN_SYNC_INTERVAL_MS, last, undefined)).toBe(
      true
    )
  })
})

describe("nextSyncAtMs", () => {
  it("is now while a sync is due", () => {
    expect(nextSyncAtMs(local(2, 12), undefined, SIX_THIRTY)).toBe(local(2, 12))
  })

  it("is the next occurrence with a time, and last plus the interval without", () => {
    expect(nextSyncAtMs(local(2, 12), local(2, 7), SIX_THIRTY)).toBe(
      local(3, 6, 30)
    )
    expect(nextSyncAtMs(local(2, 12), local(2, 11), undefined)).toBe(
      local(2, 11) + SIMPLEFIN_SYNC_INTERVAL_MS
    )
  })
})
