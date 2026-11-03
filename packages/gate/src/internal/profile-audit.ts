import { createHash, createHmac, randomBytes } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { GateAuditRecordRequest } from "@eido/schemas"
import { atomically } from "./transaction"
import type { Vault, VaultKey } from "./vault/vault"

const ERROR = "Profile audit key is unavailable or invalid"
const EPOCH_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type ProfileAudit = {
  tag(entry: GateAuditRecordRequest): Promise<{
    subjectHash: string
    beforeHash: string | null
    afterHash: string | null
  }>
}

function vaultKey(epoch: string): VaultKey {
  return {
    connector: `eido-profile-audit:${epoch}`,
    kind: "api_key",
    client: "none",
  }
}

function fingerprint(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex")
}

function readMarker(db: DatabaseSync, epoch: string): string | undefined {
  const row = db
    .prepare("SELECT key_hash FROM profile_audit_keys WHERE epoch = ?")
    .get(epoch)
  const value = row?.["key_hash"]
  return typeof value === "string" ? value : undefined
}

function parseSecret(secret: string | undefined): Uint8Array | undefined {
  if (secret === undefined || !/^[0-9a-f]{64}$/.test(secret)) return undefined
  return Buffer.from(secret, "hex")
}

async function readSecret(
  vault: Vault,
  key: VaultKey
): Promise<string | undefined> {
  try {
    return await vault.get(key)
  } catch {
    throw new Error(ERROR)
  }
}

function verifiedKey(
  marker: string | undefined,
  secret: string | undefined
): Uint8Array {
  const key = parseSecret(secret)
  if (!key || (marker !== undefined && fingerprint(key) !== marker))
    throw new Error(ERROR)
  return key
}

/** Creates or opens the epoch's persistent profile audit pseudonymization key. */
export async function initializeProfileAudit(
  db: DatabaseSync,
  vault: Vault,
  epoch: string
): Promise<ProfileAudit> {
  if (!EPOCH_PATTERN.test(epoch)) throw new Error(ERROR)
  const keyRef = vaultKey(epoch)
  const marker = readMarker(db, epoch)
  let secret = await readSecret(vault, keyRef)

  if (marker !== undefined) {
    verifiedKey(marker, secret)
  } else {
    if (secret === undefined) {
      const generated = randomBytes(32).toString("hex")
      try {
        await vault.set(keyRef, generated)
      } catch {
        throw new Error(ERROR)
      }
      secret = await readSecret(vault, keyRef)
      if (secret !== generated) throw new Error(ERROR)
    }
    const candidate = verifiedKey(undefined, secret)
    const keyHash = fingerprint(candidate)
    try {
      atomically(db, () => {
        const concurrentMarker = readMarker(db, epoch)
        if (concurrentMarker !== undefined && concurrentMarker !== keyHash)
          throw new Error(ERROR)
        if (concurrentMarker === undefined) {
          db.prepare(
            "INSERT INTO profile_audit_keys (epoch, key_hash) VALUES (?, ?)"
          ).run(epoch, keyHash)
        }
      })
    } catch {
      throw new Error(ERROR)
    }
  }

  return {
    async tag(entry) {
      const currentMarker = readMarker(db, epoch)
      const currentSecret = await readSecret(vault, keyRef)
      const key = verifiedKey(currentMarker, currentSecret)
      if (currentMarker === undefined) throw new Error(ERROR)
      const keyHash = fingerprint(key)
      const tagHash = (
        role: "subject" | "before" | "after",
        value: string | null
      ): string | null => {
        if (value === null) return null
        const canonicalTuple = JSON.stringify([
          "eido.profile-audit.v1",
          epoch,
          role,
          value,
        ])
        const digest = createHmac("sha256", key)
          .update(canonicalTuple)
          .digest("hex")
        return `hmac:v1:${epoch}:${keyHash}:${digest}`
      }
      const subjectHash = tagHash("subject", entry.subjectHash)
      if (subjectHash === null) throw new Error(ERROR)
      return {
        subjectHash,
        beforeHash: tagHash("before", entry.beforeHash),
        afterHash: tagHash("after", entry.afterHash),
      }
    },
  }
}
