import { describe, expect, test } from "vitest"
import {
  backoffDelayMs,
  connectorHealthFailure,
  connectorHealthSuccess,
  connectorProbeDue,
  connectorProbeFailure,
} from "./health"
import type { ConnectorHealthPolicy } from "./health"

const policy = {
  backoff: { baseMs: 1000, maxMs: 5000, jitter: true },
  breaker: { failureThreshold: 3, halfOpenProbeAfterMs: 1000 },
} satisfies ConnectorHealthPolicy

describe("connector health transitions", () => {
  test("opens after three retryable failures, while two remain degraded", () => {
    const random = () => 0.5
    const first = connectorHealthFailure(
      { health: "healthy", consecutiveFailures: 0 },
      "handshake_failed",
      policy,
      10_000,
      random
    )
    const second = connectorHealthFailure(
      first.state,
      "handshake_failed",
      policy,
      10_500,
      random
    )
    const third = connectorHealthFailure(
      second.state,
      "handshake_failed",
      policy,
      11_000,
      random
    )

    expect(first.state).toMatchObject({
      health: "degraded",
      consecutiveFailures: 1,
    })
    expect(second.state).toMatchObject({
      health: "degraded",
      consecutiveFailures: 2,
    })
    expect(third.state).toMatchObject({
      health: "open",
      consecutiveFailures: 3,
      nextAttemptAt: 13_000,
      lastError: "handshake_failed",
    })
  })

  test("success resets the breaker after previous failures", () => {
    expect(connectorHealthSuccess()).toEqual({
      health: "healthy",
      consecutiveFailures: 0,
    })
  })

  test("jitter is deterministic, bounded by exponential backoff, and capped", () => {
    expect(backoffDelayMs(1, policy, () => 0.25)).toBe(250)
    expect(backoffDelayMs(3, policy, () => 0.75)).toBe(3000)
    expect(backoffDelayMs(8, policy, () => 0.5)).toBe(2500)
    expect(backoffDelayMs(8, policy, () => 0)).toBe(0)
    expect(backoffDelayMs(8, policy, () => 1)).toBeLessThanOrEqual(5000)
  })

  test("an open connector becomes probe eligible only at its persisted deadline", () => {
    const open = {
      health: "open" as const,
      consecutiveFailures: 3,
      nextAttemptAt: 12_000,
    }
    expect(connectorProbeDue(open, 11_999)).toBe(false)
    expect(connectorProbeDue(open, 12_000)).toBe(true)
    expect(
      connectorProbeDue({ health: "open", consecutiveFailures: 3 }, 12_000)
    ).toBe(false)
  })

  test("a failed half-open probe reopens with a longer exponential delay", () => {
    const open = {
      health: "open" as const,
      consecutiveFailures: 3,
      nextAttemptAt: 12_000,
    }
    const retry = connectorProbeFailure(
      open,
      "handshake_failed",
      policy,
      12_000,
      () => 0.5
    )
    expect(retry.retryAfterMs).toBe(2500)
    expect(retry.state).toEqual({
      health: "open",
      consecutiveFailures: 4,
      nextAttemptAt: 14_500,
      lastError: "handshake_failed",
    })
  })

  test("stored error summaries are codes and never arbitrary error text", () => {
    const result = connectorHealthFailure(
      { health: "healthy", consecutiveFailures: 0 },
      "upstream failed: token=private",
      policy,
      0,
      () => 0
    )
    expect(result.state.lastError).toBe("upstream_error")
  })
})
