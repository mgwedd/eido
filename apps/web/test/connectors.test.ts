import { describe, expect, test } from "vitest"
import {
  CACHE_KEY,
  bridgeNotice,
  breakerLabel,
  displayName,
  healthLabel,
  invitationsWait,
  readCache,
  writeCache,
} from "../lib/connectors"
import {
  AS_OF,
  driveDisabled,
  gmail,
  protonCalendarOpen,
  protonMailOpen,
} from "./fixtures/connectors"

function memoryStore(initial?: string) {
  let value = initial
  return {
    getItem: () => value ?? null,
    setItem: (_key: string, next: string) => {
      value = next
    },
  }
}

describe("labels", () => {
  test("names known connectors and passes others through", () => {
    expect(displayName("gmail")).toBe("Gmail")
    expect(displayName("local-folders")).toBe("local-folders")
  })
  test("a disabled connector reads Disabled whatever its health", () => {
    expect(healthLabel(driveDisabled)).toBe("Disabled")
    expect(healthLabel({ ...gmail, health: "degraded" })).toBe("Degraded")
    expect(healthLabel(protonMailOpen)).toBe("Open")
  })
  test("breaker follows health", () => {
    expect(breakerLabel("healthy")).toBe("Closed")
    expect(breakerLabel("degraded")).toBe("Backing off")
    expect(breakerLabel("open")).toBe("Open")
  })
})

describe("shared Bridge health", () => {
  test("no notice while Bridge connectors are healthy", () => {
    expect(
      bridgeNotice([{ ...protonMailOpen, health: "healthy" }, gmail])
    ).toBeNull()
  })
  test("no notice for a non-Bridge connector being open", () => {
    expect(bridgeNotice([{ ...gmail, health: "open" }])).toBeNull()
  })
  test("names the calendar only when the gate reports a calendar row", () => {
    expect(bridgeNotice([protonMailOpen])?.detail).toBe("Proton Mail waits.")
    expect(bridgeNotice([protonMailOpen, protonCalendarOpen])?.detail).toBe(
      "Proton Mail and Proton Calendar invitations wait."
    )
  })
  test("invitations wait only on an unhealthy calendar row", () => {
    expect(invitationsWait(protonCalendarOpen)).toBe(true)
    expect(invitationsWait({ ...protonCalendarOpen, health: "healthy" })).toBe(
      false
    )
    expect(invitationsWait(protonMailOpen)).toBe(false)
  })
})

describe("cache", () => {
  test("round-trips a read with its as_of time", () => {
    const store = memoryStore()
    writeCache({ connectors: [gmail] }, new Date(AS_OF), store)
    expect(readCache(store)).toEqual({ asOf: AS_OF, connectors: [gmail] })
  })
  test("ignores corrupt, malformed and missing entries", () => {
    expect(readCache(memoryStore())).toBeNull()
    expect(readCache(memoryStore("{"))).toBeNull()
    expect(
      readCache(memoryStore(JSON.stringify({ asOf: "no", settings: {} })))
    ).toBeNull()
    expect(
      readCache(
        memoryStore(
          JSON.stringify({ asOf: AS_OF, settings: { connectors: [{}] } })
        )
      )
    ).toBeNull()
    expect(readCache(null)).toBeNull()
    expect(CACHE_KEY).toContain("connectors")
  })
  test("a blocked store does not throw", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(() =>
      writeCache({ connectors: [] }, new Date(AS_OF), blocked)
    ).not.toThrow()
    expect(readCache(blocked)).toBeNull()
  })
})
