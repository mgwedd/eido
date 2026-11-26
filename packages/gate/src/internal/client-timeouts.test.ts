import { afterEach, describe, expect, test, vi } from "vitest"
import { createAppleClient, createFileClient } from "./client"
import { APPLE_BRIDGE_TIMEOUT_MS } from "./apple/runner"
import { BRIDGE_TIMEOUT_MS as FILE_BRIDGE_TIMEOUT_MS } from "./files/file-helper"
import { socketAddress } from "./test-fixtures"

// The gate waits on the session bridge for these durations; a client that gives up sooner
// reports a failure for a call the gate is still waiting on (#914).
describe("gate client default timeouts", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The limit the client armed for its first call, read from the abort signal it created. */
  async function armedTimeout(call: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(AbortSignal, "timeout")
    await call().catch(() => undefined)
    const armed = spy.mock.calls[0]?.[0]
    if (armed === undefined) throw new Error("the client armed no timeout")
    return armed
  }

  const socketPath = socketAddress("/nonexistent-eido-dir", "gate.sock")

  test("the gate's bridge waits are 55 s", () => {
    expect(APPLE_BRIDGE_TIMEOUT_MS).toBe(55_000)
    expect(FILE_BRIDGE_TIMEOUT_MS).toBe(55_000)
  })

  test("the Apple read client waits longer than the gate's EventKit wait", async () => {
    const client = createAppleClient({ socketPath })
    const armed = await armedTimeout(() => client.listCalendars())
    expect(armed).toBe(60_000)
    expect(armed).toBeGreaterThan(APPLE_BRIDGE_TIMEOUT_MS)
  })

  test("the file client waits longer than the gate's file helper wait", async () => {
    const client = createFileClient({ socketPath })
    const armed = await armedTimeout(() => client.roots())
    expect(armed).toBe(60_000)
    expect(armed).toBeGreaterThan(FILE_BRIDGE_TIMEOUT_MS)
  })
})
