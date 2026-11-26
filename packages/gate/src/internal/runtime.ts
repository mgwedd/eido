import type { DatabaseSync } from "node:sqlite"
import { ControlStateError, requireControlState } from "./control-checkpoint"
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

// `policy` is undefined only while the gate started with the control checkpoint's Keychain
// locked (#870); `pending` is then the error a policy read throws once the checkpoint verifies.
type State = Omit<Running, "policy"> & {
  policy: Policy | undefined
  pending: unknown
}

let running: State | undefined

/**
 * Loads the policy and makes the gate serve requests. Returns overlay errors, if any. Throws
 * when the WebAuthn origin is not `https://<rpId>` or `https://<rpId>:<port>`. A Keychain that
 * locks the control checkpoint does not stop the start: the gate runs with no policy, every
 * policy read is denied with `keychain_locked`, and `resumeGate` loads it once the checkpoint
 * verifies. Every other denial still throws.
 */
export function startGate(
  db: DatabaseSync,
  options: PolicyOptions,
  webAuthn: WebAuthnConfig
): string[] {
  if (running !== undefined) throw new Error("the gate is already started")
  checkWebAuthnConfig(webAuthn)
  try {
    const { policy, errors } = loadPolicy(db, options)
    running = { db, options, policy, webAuthn, pending: undefined }
    return errors
  } catch (error) {
    if (!isKeychainLocked(error)) throw error
    running = { db, options, policy: undefined, webAuthn, pending: error }
    return []
  }
}

/** True while the gate runs without a policy because the control checkpoint was locked. */
export function policyPending(): boolean {
  return state().policy === undefined
}

/**
 * Loads the policy of a gate that started locked. Throws, and stays without a policy, when the
 * load fails; the next policy read then throws the same error.
 */
export function resumeGate(): string[] {
  const gate = state()
  if (gate.policy !== undefined)
    throw new Error("the gate already has its policy")
  try {
    const { policy, errors } = loadPolicy(gate.db, gate.options)
    running = { ...gate, policy, pending: undefined }
    return errors
  } catch (error) {
    running = { ...gate, pending: error }
    throw error
  }
}

/** Re-reads the approved policy and checks the proposal file. */
export function reloadPolicy(): string[] {
  const gate = runningGate()
  const { policy, errors } = loadPolicy(gate.db, gate.options, gate.policy)
  running = { ...state(), policy }
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

/**
 * The running gate. Reading `policy` before a locked start has loaded it throws the checkpoint's
 * current denial, or the error the last load failed with.
 */
export function runningGate(): Readonly<Running> {
  const gate = state()
  return {
    db: gate.db,
    options: gate.options,
    webAuthn: gate.webAuthn,
    get policy(): Policy {
      const current = state()
      if (current.policy !== undefined) return current.policy
      requireControlState(current.db)
      throw current.pending
    },
  }
}

function state(): State {
  if (running === undefined) throw new Error("the gate is not started")
  return running
}

function isKeychainLocked(error: unknown): boolean {
  return (
    error instanceof ControlStateError && error.reason === "keychain_locked"
  )
}
