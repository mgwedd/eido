// Gate internals: only packages/gate may import this file.
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, parse } from "node:path"
import { randomBytes } from "node:crypto"
import { vaultKeyId, type Vault, type VaultKey } from "./vault"

export type FileVaultOptions = {
  /** Absolute path of the JSON file. Must be outside any git checkout. */
  path: string
  /** Explicit development opt-in. FileVault stores secrets in plain text. */
  devFlag: boolean
}

/** Reads the development opt-in from an environment: `EIDO_DEV_VAULT=1`. */
export function devFlagFromEnv(
  env: Record<string, string | undefined>
): boolean {
  return env["EIDO_DEV_VAULT"] === "1"
}

function insideGitCheckout(path: string): boolean {
  let dir = dirname(path)
  const root = parse(dir).root
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true
    if (dir === root) return false
    dir = dirname(dir)
  }
}

function parseStore(text: string): Map<string, string> {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("vault file is not a JSON object")
  }
  const secrets = new Map<string, string>()
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string")
      throw new Error("vault file has a non-string entry")
    secrets.set(id, value)
  }
  return secrets
}

/**
 * Development-only vault: plain JSON, mode 0600. Production uses the Keychain adapter (#67).
 * Error messages never include secret values or file contents.
 */
export class FileVault implements Vault {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: FileVaultOptions) {
    if (!options.devFlag) {
      throw new Error(
        "FileVault is for development only: set the explicit dev flag to use it"
      )
    }
    if (!isAbsolute(options.path)) {
      throw new Error("FileVault path must be absolute")
    }
    if (insideGitCheckout(options.path)) {
      throw new Error("FileVault path must be outside any git checkout")
    }
    this.path = options.path
  }

  /** Serializes operations so concurrent writes cannot lose updates. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<Map<string, string>> {
    try {
      return parseStore(await readFile(this.path, "utf8"))
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return new Map()
      }
      throw new Error("vault file could not be read")
    }
  }

  private async save(secrets: Map<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(temp, JSON.stringify(Object.fromEntries(secrets)), {
      mode: 0o600,
    })
    await chmod(temp, 0o600) // writeFile's mode is masked by umask; no-op on Windows
    await rename(temp, this.path)
  }

  get(key: VaultKey): Promise<string | undefined> {
    return this.run(async () => (await this.load()).get(vaultKeyId(key)))
  }

  set(key: VaultKey, secret: string): Promise<void> {
    return this.run(async () => {
      const secrets = await this.load()
      secrets.set(vaultKeyId(key), secret)
      await this.save(secrets)
    })
  }

  delete(key: VaultKey): Promise<void> {
    return this.run(async () => {
      const secrets = await this.load()
      if (secrets.delete(vaultKeyId(key))) await this.save(secrets)
    })
  }
}
