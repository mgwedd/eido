import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { GateConnectorHealth } from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { getPinnedManifest } from "./connectors"

/** A probe reservation expires if the gate process stops mid-request. */
const PROBE_LEASE_MS = 60_000
const BACKOFF_FACTOR = 2

type ConnectorHealth = GateConnectorHealth["connectors"][number]
export type ReadAttempt = {
  allowed: boolean
  probe: boolean
  generation: number
  probeLeaseId?: string
  reason?: "connector_open" | "connector_backoff" | "connector_disabled"
}

/** The read-only projection served to the data plane and Today API. */
export function getConnectorHealth(db: DatabaseSync): ConnectorHealth[] {
  return db
    .prepare(
      `SELECT name, health, consecutive_failures, next_attempt_at, last_error
       FROM connectors ORDER BY name`
    )
    .all()
    .map((row) => ({
      name: String(row["name"]),
      health: row["health"] as ConnectorHealth["health"],
      consecutiveFailures: Number(row["consecutive_failures"]),
      ...(typeof row["last_error"] === "string"
        ? { lastError: row["last_error"] }
        : {}),
      ...(typeof row["next_attempt_at"] === "string"
        ? { nextAttemptAt: row["next_attempt_at"] }
        : {}),
    }))
}

/**
 * Admit a read for an enabled connector. An open connector gets one atomic probe reservation only
 * after its backoff elapsed; concurrent reads see the reservation and are refused.
 */
export function beginConnectorRead(
  db: DatabaseSync,
  name: string,
  now = Date.now(),
  method = "GET"
): ReadAttempt {
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db
      .prepare(
        `SELECT enabled, health, next_attempt_at, probe_started_at,
                health_generation
         FROM connectors WHERE name = ?`
      )
      .get(name)
    if (row?.["enabled"] !== 1) {
      db.exec("ROLLBACK")
      return {
        allowed: false,
        probe: false,
        generation: -1,
        reason: "connector_disabled",
      }
    }
    const generation = Number(row["health_generation"])
    if (row["health"] !== "open") {
      if (
        row["health"] === "degraded" &&
        typeof row["next_attempt_at"] === "string" &&
        Date.parse(row["next_attempt_at"]) > now
      ) {
        db.exec("ROLLBACK")
        return {
          allowed: false,
          probe: false,
          generation,
          reason: "connector_backoff",
        }
      }
      db.exec("COMMIT")
      return { allowed: true, probe: false, generation }
    }
    const nextAttemptAt = row["next_attempt_at"]
    if (
      typeof nextAttemptAt !== "string" ||
      Date.parse(nextAttemptAt) > now ||
      method !== "GET" ||
      (typeof row["probe_started_at"] === "string" &&
        now - Date.parse(row["probe_started_at"]) < PROBE_LEASE_MS)
    ) {
      db.exec("ROLLBACK")
      return {
        allowed: false,
        probe: false,
        generation,
        reason: "connector_open",
      }
    }
    const probeLeaseId = randomUUID()
    db.prepare(
      `UPDATE connectors SET probe_started_at = ?, probe_lease_id = ?
       WHERE name = ? AND health = 'open'`
    ).run(new Date(now).toISOString(), probeLeaseId, name)
    db.exec("COMMIT")
    return { allowed: true, probe: true, generation, probeLeaseId }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

/** Clear a probe reservation when no upstream read was made (for example, no vault credential). */
export function releaseConnectorProbe(
  db: DatabaseSync,
  name: string,
  attempt: ReadAttempt
): void {
  db.prepare(
    `UPDATE connectors SET probe_started_at = NULL, probe_lease_id = NULL
     WHERE name = ? AND health = 'open' AND probe_lease_id = ? AND health_generation = ?`
  ).run(name, attempt.probeLeaseId ?? "", attempt.generation)
}

/** Record an actual successful read; it is the only transition that closes an open breaker. */
export function recordConnectorReadSuccess(
  db: DatabaseSync,
  name: string,
  attempt: ReadAttempt
): void {
  const row = db
    .prepare(
      "SELECT health, probe_started_at, probe_lease_id, health_generation FROM connectors WHERE name = ?"
    )
    .get(name)
  if (row === undefined) return
  if (Number(row["health_generation"]) !== attempt.generation) return
  if (
    row["health"] === "open" &&
    (!attempt.probe ||
      row["probe_started_at"] === null ||
      row["probe_lease_id"] !== attempt.probeLeaseId)
  )
    return
  if (attempt.probe) {
    db.prepare(
      `UPDATE connectors SET health = 'healthy', consecutive_failures = 0,
         next_attempt_at = NULL, last_error = NULL, probe_started_at = NULL,
         probe_lease_id = NULL, health_generation = health_generation + 1
       WHERE name = ? AND health = 'open' AND health_generation = ?
         AND probe_lease_id = ?`
    ).run(name, attempt.generation, attempt.probeLeaseId ?? "")
  } else {
    db.prepare(
      `UPDATE connectors SET health = 'healthy', consecutive_failures = 0,
         next_attempt_at = NULL, last_error = NULL, probe_started_at = NULL,
         probe_lease_id = NULL, health_generation = health_generation + 1
       WHERE name = ? AND health_generation = ? AND health != 'open'
         AND probe_started_at IS NULL`
    ).run(name, attempt.generation)
  }
}

/** Record a network/handshake failure using the manifest's breaker and backoff policy. */
export function recordConnectorReadFailure(
  db: DatabaseSync,
  name: string,
  errorCode: "handshake_failed" | "timeout" | "unavailable",
  attempt: ReadAttempt,
  now = Date.now(),
  random = Math.random
): void {
  const row = db
    .prepare(
      "SELECT health, consecutive_failures, probe_lease_id, health_generation FROM connectors WHERE name = ?"
    )
    .get(name)
  const manifest = getPinnedManifest(db, name)
  if (row === undefined || manifest === undefined) return
  if (Number(row["health_generation"]) !== attempt.generation) return
  if (
    row["health"] === "open" &&
    (!attempt.probe || row["probe_lease_id"] !== attempt.probeLeaseId)
  )
    return
  if (row["health"] !== "open" && attempt.probe) return
  const failures = Number(row["consecutive_failures"]) + 1
  const { failureThreshold } = manifest.health.breaker
  const { baseMs, maxMs, jitter } = manifest.health.backoff
  const ceiling = Math.min(maxMs, baseMs * BACKOFF_FACTOR ** (failures - 1))
  const state = failures >= failureThreshold ? "open" : "degraded"
  const jittered = jitter ? Math.floor(random() * ceiling) : ceiling
  const delay =
    state === "open"
      ? Math.max(jittered, manifest.health.breaker.halfOpenProbeAfterMs)
      : jittered
  db.prepare(
    `UPDATE connectors SET health = ?, consecutive_failures = ?,
       next_attempt_at = ?, last_error = ?, probe_started_at = NULL,
       probe_lease_id = NULL, health_generation = health_generation + 1
     WHERE name = ? AND health_generation = ?
       AND ((? = 1 AND health = 'open' AND probe_lease_id = ?)
         OR (? = 0 AND health != 'open' AND probe_started_at IS NULL))`
  ).run(
    state,
    failures,
    new Date(now + delay).toISOString(),
    errorCode,
    name,
    attempt.generation,
    Number(attempt.probe),
    attempt.probeLeaseId ?? "",
    Number(attempt.probe)
  )
}

/** Disable an enabled connector after auth is rejected; this is not a retryable health failure. */
export function disableConnectorAfterAuthFailure(
  db: DatabaseSync,
  name: string
): void {
  const result = db
    .prepare(
      `UPDATE connectors SET enabled = 0, health = 'open', last_error = 'auth_failed',
         next_attempt_at = NULL, probe_started_at = NULL, probe_lease_id = NULL,
         health_generation = health_generation + 1 WHERE name = ? AND enabled = 1`
    )
    .run(name)
  if (Number(result.changes) === 1) {
    append(db, {
      actor: "system",
      action: "connector.disabled_auth_failed",
      target: name,
      detailHash: payloadHash({ errorClass: "auth_failed" }),
    })
  }
}
