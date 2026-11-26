// Gate internals: only packages/gate may import this file.

export type VaultKeyKind =
  "refresh_token" | "access_token" | "api_key" | "password"
export type VaultClient = "read" | "write" | "none"

export type VaultKey = {
  connector: string
  kind: VaultKeyKind
  client: VaultClient
}

/** Secret storage. Holds secrets only; scope policy lives in the connector manifest (#10). */
export interface Vault {
  get(key: VaultKey): Promise<string | undefined>
  set(key: VaultKey, secret: string): Promise<void>
  delete(key: VaultKey): Promise<void>
}

/** A read refused because the keychain that holds the secret is locked (#878). */
export class KeychainLockedError extends Error {
  constructor() {
    super("Keychain is locked")
    this.name = "KeychainLockedError"
  }
}

/**
 * The same vault, calling `onLocked` each time a read fails because the keychain is locked, then
 * rethrowing. The gate uses it to move the control checkpoint into `keychain_locked` (#878).
 */
export function reportingLocks(vault: Vault, onLocked: () => void): Vault {
  return {
    get: async (key) => {
      try {
        return await vault.get(key)
      } catch (error) {
        if (error instanceof KeychainLockedError) onLocked()
        throw error
      }
    },
    set: (key, secret) => vault.set(key, secret),
    delete: (key) => vault.delete(key),
  }
}

/** Stable map key. JSON keeps connector names with any characters from colliding. */
export function vaultKeyId(key: VaultKey): string {
  return JSON.stringify([key.connector, key.kind, key.client])
}

export class InMemoryVault implements Vault {
  private readonly secrets = new Map<string, string>()

  get(key: VaultKey): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(vaultKeyId(key)))
  }

  set(key: VaultKey, secret: string): Promise<void> {
    this.secrets.set(vaultKeyId(key), secret)
    return Promise.resolve()
  }

  delete(key: VaultKey): Promise<void> {
    this.secrets.delete(vaultKeyId(key))
    return Promise.resolve()
  }
}
