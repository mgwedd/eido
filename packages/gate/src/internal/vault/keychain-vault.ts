import { isAbsolute } from "node:path"
import { lstat } from "node:fs/promises"
import { runKeychainCommand } from "./keychain-bridge"
import { vaultKeyId } from "./vault"
import type { Vault, VaultKey } from "./vault"

/** An explicitly selected, pre-existing gate-user keychain; never the default search list. */
export class KeychainVault implements Vault {
  private readonly path: string

  constructor(options: { path: string }) {
    if (process.platform !== "darwin")
      throw new Error("Keychain vault requires macOS")
    if (!isAbsolute(options.path) || options.path.includes("\0"))
      throw new Error("Keychain path must be absolute and contain no NUL")
    this.path = options.path
  }

  private async checkPath(): Promise<void> {
    try {
      const info = await lstat(this.path)
      const uid = process.getuid?.()
      if (
        !info.isFile() ||
        uid === undefined ||
        info.uid !== uid ||
        (info.mode & 0o077) !== 0
      )
        throw new Error()
    } catch {
      throw new Error(
        "Keychain file must exist, be private, and belong to the gate user"
      )
    }
  }

  async get(key: VaultKey): Promise<string | undefined> {
    await this.checkPath()
    const result = await runKeychainCommand({
      operation: "get",
      path: this.path,
      account: vaultKeyId(key),
    })
    if (result.status === -25300) return undefined
    if (result.status !== 0 || result.data === undefined)
      throw new Error("Keychain credential could not be read")
    const data = Buffer.from(result.data, "base64")
    if (data.toString("base64") !== result.data || data.length % 2 !== 0)
      throw new Error("Keychain credential encoding is invalid")
    // UTF-16 preserves every JavaScript string, including NUL and unpaired surrogates.
    return data.toString("utf16le")
  }

  async set(key: VaultKey, secret: string): Promise<void> {
    await this.checkPath()
    const result = await runKeychainCommand({
      operation: "set",
      path: this.path,
      account: vaultKeyId(key),
      data: Buffer.from(secret, "utf16le").toString("base64"),
    })
    if (result.status !== 0)
      throw new Error("Keychain credential could not be stored")
  }

  async delete(key: VaultKey): Promise<void> {
    await this.checkPath()
    const result = await runKeychainCommand({
      operation: "delete",
      path: this.path,
      account: vaultKeyId(key),
    })
    if (result.status !== 0 && result.status !== -25300)
      throw new Error("Keychain credential could not be deleted")
  }
}
