import { describe, expect, test, vi } from "vitest"
import {
  bridgeNotice,
  breakerLabel,
  disabledByDrift,
  displayName,
  loadConnectors,
  healthLabel,
  invitationsWait,
} from "../lib/connectors"
import {
  AS_OF,
  driveDisabled,
  driveDrifted,
  gmail,
  gmailUnpinned,
  protonCalendarOpen,
  protonMailOpen,
} from "./fixtures/connectors"

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

describe("drift", () => {
  test("only a disabled connector with drift detail is disabled by drift", () => {
    expect(disabledByDrift(driveDrifted)).toBe(true)
    expect(disabledByDrift(driveDisabled)).toBe(false)
    expect(disabledByDrift({ ...driveDrifted, enabled: true })).toBe(false)
  })
})

describe("loadConnectors", () => {
  const read = (body: unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body)))
    )
    return loadConnectors(new AbortController().signal)
  }
  test("carries the gate's asOf", async () => {
    expect(await read({ connectors: [gmail], asOf: AS_OF })).toEqual({
      status: "ready",
      connectors: [gmail],
      unpinned: [],
      asOf: AS_OF,
    })
  })
  test("carries the placed, unpinned manifests the gate lists (#627)", async () => {
    expect(await read({ connectors: [], unpinned: [gmailUnpinned] })).toEqual({
      status: "ready",
      connectors: [],
      unpinned: [gmailUnpinned],
    })
  })
  test("carries no asOf when the gate sent none", async () => {
    expect(await read({ connectors: [gmail] })).toEqual({
      status: "ready",
      connectors: [gmail],
      unpinned: [],
    })
  })
})
