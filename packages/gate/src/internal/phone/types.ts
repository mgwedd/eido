import type { DatabaseSync } from "node:sqlite"
import type { Policy } from "../policy"
import type { ConnectorProbes } from "../connector-connect"
import type { Vault } from "../vault/vault"
import type { GoogleConnect } from "../google-connect"
import type { FileHelper } from "../files/file-helper"
import type { WebSessionKeyPair } from "../sessions"
import type { SupervisorClient } from "../supervisor-client"
import type { WebAuthnConfig } from "../webauthn"

export type PhoneState = {
  db: DatabaseSync
  policy: Policy
  webAuthn: WebAuthnConfig
  webSessionKeyPair?: WebSessionKeyPair
  nudge?: { threshold: number; windowMs: number }
  push?: {
    publicKey: () => Promise<string>
    notifyPending: () => void
    /** Alerts every verified subscription that a passkey recovery started (issue 682). */
    notifyRecovery: () => Promise<void>
  }
  backupStampPath?: string
  /** The owner's re-reviewed manifest for a drifted connector (#97); undefined when none is placed. */
  reviewedManifest?: (connector: string) => unknown
  /** The connector names with a reviewed manifest placed (#627); none when undefined. */
  reviewedManifests?: () => string[]
  /** The gate-side native helper that identifies a requested file root (#574); never the phone's. */
  fileHelper?: FileHelper
  /** The stack supervisor's socket client (#659); undefined when the gate runs outside the stack. */
  supervisor?: SupervisorClient
  /** The gate vault the Admin page's signed secret routes seal into (#661); undefined without one. */
  vault?: Vault
  /** The Bridge pin the gate runs with and its certificate file (#661); undefined without Bridge. */
  bridge?: { certificateSha256: string; certificatePath: string }
  /** Each connector's health probe, run after a new secret is sealed (#661). */
  probes?: ConnectorProbes
  /** How the gate claims a SimpleFIN access URL (#661); the global fetch by default. */
  fetch?: typeof fetch
  /** Google sign-in through the gate (#662); undefined without a vault and a redirect URI. */
  google?: GoogleConnect
}
