import { describe, expect, test } from "vitest"

import {
  connectorRow,
  connectorSummary,
  formatProbe,
  formatSynced,
} from "../lib/today-connectors"
import {
  drive,
  driveDegraded,
  driveDisabled,
  driveDrifted,
  gmail,
  protonMailOpen,
  sharedBridgeOpen,
} from "./fixtures/connectors"
import { NOW } from "./fixtures/today"

describe("formatSynced", () => {
  test("names whole minutes", () => {
    expect(formatSynced("2026-10-18T11:56:00.000Z", NOW)).toBe(
      "Synced 4 min ago"
    )
  })
  test("switches to hours and days", () => {
    expect(formatSynced("2026-10-18T09:30:00.000Z", NOW)).toBe("Synced 2 h ago")
    expect(formatSynced("2026-10-15T12:00:00.000Z", NOW)).toBe("Synced 3 d ago")
  })
  test("under a minute reads as just now, and a future time never goes negative", () => {
    expect(formatSynced("2026-10-18T11:59:30.000Z", NOW)).toBe(
      "Synced just now"
    )
    expect(formatSynced("2026-10-18T12:05:00.000Z", NOW)).toBe(
      "Synced just now"
    )
  })
})

describe("formatProbe", () => {
  test("counts down to the gate's next attempt", () => {
    expect(formatProbe("2026-10-18T12:12:00.000Z", NOW)).toBe("Probe in 12 min")
  })
  test("says the probe is due once the time has passed", () => {
    expect(formatProbe("2026-10-18T10:14:00.000Z", NOW)).toBe("Probe due")
  })
})

describe("connectorRow", () => {
  test("healthy shows the last sync", () => {
    expect(connectorRow(gmail, NOW)).toEqual({
      name: "Gmail",
      dot: "healthy",
      status: "Healthy",
      detail: "Synced 32 min ago",
    })
  })
  test("healthy without a recorded sync does not invent one", () => {
    expect(connectorRow(drive, NOW).detail).toBe("Not synced yet")
  })
  test("open shows the failures and the probe", () => {
    expect(connectorRow(protonMailOpen, NOW)).toEqual({
      name: "Proton Mail (Bridge)",
      dot: "open",
      status: "Open",
      detail: "Breaker open after 3 failed handshakes · Probe due",
    })
  })
  test("open without a next attempt omits the probe", () => {
    const noProbe = { ...protonMailOpen, consecutiveFailures: 1 }
    delete noProbe.nextAttemptAt
    expect(connectorRow(noProbe, NOW).detail).toBe(
      "Breaker open after 1 failed handshake"
    )
  })
  test("degraded shows the backoff", () => {
    expect(connectorRow(driveDegraded, NOW)).toEqual({
      name: "Drive",
      dot: "degraded",
      status: "Degraded",
      detail: "Backing off after 1 failed handshake · Probe in 5 min",
    })
  })
  test("disabled by drift says the tool list changed", () => {
    expect(connectorRow(driveDrifted, NOW).detail).toBe(
      "Disabled: tool list changed, re-review"
    )
  })
  test("disabled by hand does not claim drift", () => {
    expect(connectorRow(driveDisabled, NOW)).toMatchObject({
      dot: "disabled",
      status: "Disabled",
      detail: "Disabled: pin it again to resume reads",
    })
  })
})

describe("connectorSummary", () => {
  test("counts pinned manifests and open breakers", () => {
    expect(connectorSummary(sharedBridgeOpen)).toBe(
      "4 manifests pinned · 2 breakers open"
    )
  })
  test("uses the singular", () => {
    expect(connectorSummary([protonMailOpen])).toBe(
      "1 manifest pinned · 1 breaker open"
    )
  })
  test("a disabled connector is not counted as an open breaker", () => {
    expect(connectorSummary([{ ...protonMailOpen, enabled: false }])).toBe(
      "1 manifest pinned · 0 breakers open"
    )
  })
})
