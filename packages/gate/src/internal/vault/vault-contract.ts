// Gate internals. Contract suite for any Vault; the Keychain adapter (#67) reuses it.
import { describe, expect, test } from "vitest"
import type { Vault, VaultKey } from "./vault"

const KEY: VaultKey = {
  connector: "google",
  kind: "refresh_token",
  client: "read",
}

export function vaultContract(
  name: string,
  makeVault: () => Promise<Vault> | Vault
): void {
  describe(`vault contract: ${name}`, () => {
    test("set/get/delete round trip", async () => {
      const vault = await makeVault()
      await vault.set(KEY, "test-refresh-token-1")
      expect(await vault.get(KEY)).toBe("test-refresh-token-1")
      await vault.delete(KEY)
      expect(await vault.get(KEY)).toBeUndefined()
    })

    test("missing key returns undefined", async () => {
      const vault = await makeVault()
      expect(await vault.get(KEY)).toBeUndefined()
    })

    test("deleting a missing key is not an error", async () => {
      const vault = await makeVault()
      await expect(vault.delete(KEY)).resolves.toBeUndefined()
    })

    test("overwrite replaces", async () => {
      const vault = await makeVault()
      await vault.set(KEY, "test-refresh-token-1")
      await vault.set(KEY, "test-refresh-token-2")
      expect(await vault.get(KEY)).toBe("test-refresh-token-2")
    })

    test("keys for different clients are independent", async () => {
      const vault = await makeVault()
      const write: VaultKey = { ...KEY, client: "write" }
      await vault.set(KEY, "test-read-token")
      await vault.set(write, "test-write-token")
      expect(await vault.get(KEY)).toBe("test-read-token")
      expect(await vault.get(write)).toBe("test-write-token")
      await vault.delete(KEY)
      expect(await vault.get(write)).toBe("test-write-token")
      expect(await vault.get({ ...KEY, client: "none" })).toBeUndefined()
    })

    test("keys for different connectors and kinds are independent", async () => {
      const vault = await makeVault()
      await vault.set(KEY, "test-a")
      expect(await vault.get({ ...KEY, connector: "proton" })).toBeUndefined()
      expect(await vault.get({ ...KEY, kind: "access_token" })).toBeUndefined()
    })

    test("concurrent writes are all kept", async () => {
      const vault = await makeVault()
      const kinds = [
        "refresh_token",
        "access_token",
        "api_key",
        "password",
      ] as const
      await Promise.all(
        kinds.map((kind, i) => vault.set({ ...KEY, kind }, `test-secret-${i}`))
      )
      for (const [i, kind] of kinds.entries()) {
        expect(await vault.get({ ...KEY, kind })).toBe(`test-secret-${i}`)
      }
    })
  })
}
