import { describe, expect, test } from "vitest"
import { createHealthAwareSync } from "./health-aware-sync"

describe("health-aware sync callbacks", () => {
  test("skips an open connector until its persisted retry deadline", async () => {
    const gate = {
      getConnectorHealth: () =>
        Promise.resolve([
          {
            name: "proton",
            health: "open" as const,
            consecutiveFailures: 3,
            nextAttemptAt: "2026-10-25T12:00:01.000Z",
          },
        ]),
    }
    const run = createHealthAwareSync(gate, () =>
      Date.parse("2026-10-25T12:00:00.999Z")
    )
    let calls = 0

    expect(
      await run("proton", () => {
        calls++
        return Promise.resolve("synced")
      })
    ).toEqual({ status: "skipped" })
    expect(calls).toBe(0)
  })

  test("runs the callback at the probe deadline while another connector stays independent", async () => {
    const gate = {
      getConnectorHealth: () =>
        Promise.resolve([
          {
            name: "proton",
            health: "open" as const,
            consecutiveFailures: 3,
            nextAttemptAt: "2026-10-25T12:00:00.000Z",
          },
          {
            name: "gmail",
            health: "healthy" as const,
            consecutiveFailures: 0,
          },
        ]),
    }
    const run = createHealthAwareSync(gate, () =>
      Date.parse("2026-10-25T12:00:00.000Z")
    )
    let releaseProton: (() => void) | undefined
    const proton = run(
      "proton",
      () =>
        new Promise<string>((resolve) => {
          releaseProton = () => resolve("recovered")
        })
    )

    expect(await run("proton", () => Promise.resolve("duplicate run"))).toEqual(
      { status: "skipped" }
    )
    expect(
      await run("gmail", () => Promise.resolve("gmail kept syncing"))
    ).toEqual({
      status: "synced",
      result: "gmail kept syncing",
    })
    releaseProton?.()
    expect(await proton).toEqual({ status: "synced", result: "recovered" })
  })

  test("runs a connector absent from the health projection", async () => {
    const run = createHealthAwareSync({
      getConnectorHealth: () => Promise.resolve([]),
    })
    expect(await run("gmail", () => Promise.resolve(7))).toEqual({
      status: "synced",
      result: 7,
    })
  })

  test("an auth-disabled open connector with no retry deadline stays skipped", async () => {
    const gate = {
      getConnectorHealth: () =>
        Promise.resolve([
          {
            name: "proton-mail",
            health: "open" as const,
            consecutiveFailures: 0,
            lastError: "auth_failed",
          },
        ]),
    }
    const run = createHealthAwareSync(gate)
    let attempts = 0
    expect(
      await run("proton-mail", () => {
        attempts++
        return Promise.resolve()
      })
    ).toEqual({ status: "skipped" })
    expect(
      await run("proton-mail", () => {
        attempts++
        return Promise.resolve()
      })
    ).toEqual({ status: "skipped" })
    expect(attempts).toBe(0)
  })
})
