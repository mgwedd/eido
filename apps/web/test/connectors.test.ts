import { describe, expect, test } from "vitest"
import {
  bridgeNotice,
  breakerLabel,
  displayName,
  healthLabel,
  invitationsWait,
} from "../lib/connectors"
import {
  driveDisabled,
  gmail,
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
