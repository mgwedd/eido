import type { DatabaseSync } from "node:sqlite"
import { loadPolicy, setPolicyOverrides } from "./policy"
import type { Policy, PolicyOptions } from "./policy"
import { checkWebAuthnConfig } from "./webauthn"
import type { WebAuthnConfig } from "./webauthn"

// The running gate: its control database, loaded policy and WebAuthn relying-party config. The gate process starts it once
// (the process entry point is #42); the public functions in src/index.ts read it. Starting and
// reloading are gate-side admin actions and are not exported from src/index.ts, so the data
// plane has no path to change the permission table without a signed control approval.

type Running = {
  db: DatabaseSync
  options: PolicyOptions
  policy: Policy
  webAuthn: WebAuthnConfig
}

let running: Running | undefined

/**
 * Loads the policy and makes the gate serve requests. Returns overlay errors, if any. Throws
 * when the WebAuthn origin is not `https://<rpId>`.
 */
export function startGate(
  db: DatabaseSync,
  options: PolicyOptions,
  webAuthn: WebAuthnConfig
): string[] {
  if (running !== undefined) throw new Error("the gate is already started")
  checkWebAuthnConfig(webAuthn)
  const { policy, errors } = loadPolicy(db, options)
  running = { db, options, policy, webAuthn }
  return errors
}

/** Re-reads the approved policy and checks the proposal file. */
export function reloadPolicy(): string[] {
  const gate = runningGate()
  const { policy, errors } = loadPolicy(gate.db, gate.options, gate.policy)
  running = { ...gate, policy }
  return errors
}

/** Signed local-admin mutation, with immediate refresh of the running gate's policy. */
export function applyPolicyOverrides(
  value: unknown,
  actor: string,
  request: unknown
): string[] {
  const gate = runningGate()
  setPolicyOverrides(gate.db, value, actor, { config: gate.webAuthn, request })
  return reloadPolicy()
}

export function stopGate(): void {
  running = undefined
}

export function runningGate(): Readonly<Running> {
  if (running === undefined) throw new Error("the gate is not started")
  return running
}
