import type { ConnectorManifest } from "@eido/schemas"

export type ConnectorHealthState = {
  health: "healthy" | "degraded" | "open"
  consecutiveFailures: number
  nextAttemptAt?: number
  lastError?: string
}

export type ConnectorHealthPolicy = ConnectorManifest["health"]

export const INITIAL_CONNECTOR_HEALTH: ConnectorHealthState = {
  health: "healthy",
  consecutiveFailures: 0,
}

export type HealthTransition = {
  state: ConnectorHealthState
  retryAfterMs: number
}

/** Computes capped exponential backoff, optionally applying full jitter from the injected source. */
export function backoffDelayMs(
  failures: number,
  policy: ConnectorHealthPolicy,
  random: () => number
): number {
  const { baseMs, maxMs, jitter } = policy.backoff
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1))
  return jitter ? Math.floor(exponential * clampRandom(random())) : exponential
}

/** A completed successful handshake closes the breaker and clears previous failure details. */
export function connectorHealthSuccess(): ConnectorHealthState {
  return INITIAL_CONNECTOR_HEALTH
}

/**
 * Records a retryable handshake failure. `errorCode` must be a short typed code, never an
 * upstream response body, message body, URL, credential, or arbitrary Error.message.
 */
export function connectorHealthFailure(
  current: ConnectorHealthState,
  errorCode: string,
  policy: ConnectorHealthPolicy,
  now: number,
  random: () => number
): HealthTransition {
  const consecutiveFailures = current.consecutiveFailures + 1
  const retryAfterMs = backoffDelayMs(consecutiveFailures, policy, random)
  const health =
    consecutiveFailures >= policy.breaker.failureThreshold ? "open" : "degraded"
  const delayUntilProbe =
    health === "open"
      ? Math.max(retryAfterMs, policy.breaker.halfOpenProbeAfterMs)
      : retryAfterMs
  return {
    state: {
      health,
      consecutiveFailures,
      lastError: sanitizeErrorCode(errorCode),
      nextAttemptAt: now + delayUntilProbe,
    },
    retryAfterMs,
  }
}

/** True only once an open connector's persisted probe delay has elapsed. */
export function connectorProbeDue(
  state: ConnectorHealthState,
  now: number
): boolean {
  if (state.nextAttemptAt === undefined) return state.health !== "open"
  return now >= state.nextAttemptAt
}

/** Backoff after a failed half-open probe grows from the number of failures already recorded. */
export function connectorProbeFailure(
  current: ConnectorHealthState,
  errorCode: string,
  policy: ConnectorHealthPolicy,
  now: number,
  random: () => number
): HealthTransition {
  const consecutiveFailures =
    Math.max(policy.breaker.failureThreshold, current.consecutiveFailures) + 1
  const retryAfterMs = backoffDelayMs(consecutiveFailures, policy, random)
  const delayUntilProbe = Math.max(
    retryAfterMs,
    policy.breaker.halfOpenProbeAfterMs
  )
  return {
    state: {
      health: "open",
      consecutiveFailures,
      nextAttemptAt: now + delayUntilProbe,
      lastError: sanitizeErrorCode(errorCode),
    },
    retryAfterMs,
  }
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1 - Number.EPSILON, Math.max(0, value))
}

function sanitizeErrorCode(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,79}$/i.test(value) ? value : "upstream_error"
}
