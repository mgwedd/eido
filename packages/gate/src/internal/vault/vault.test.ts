import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { FileVault, devFlagFromEnv } from "./file-vault"
import { InMemoryVault } from "./vault"
import { vaultContract } from "./vault-contract"

const dirs: string[] = []
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eido-vault-test-"))
  dirs.push(dir)
  return join(dir, "vault.json")
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

vaultContract("InMemoryVault", () => new InMemoryVault())
vaultContract(
  "FileVault",
  async () => new FileVault({ path: await tempPath(), devFlag: true })
)

const KEY = {
  connector: "google",
  kind: "refresh_token",
  client: "read",
} as const

describe("FileVault", () => {
  test("refuses to start without the dev flag", () => {
    expect(
      () =>
        new FileVault({
          path: join(tmpdir(), "eido-vault-unused.json"),
          devFlag: false,
        })
    ).toThrow(/development only/)
  })

  test("refuses relative paths and paths inside a git checkout", () => {
    expect(() => new FileVault({ path: "vault.json", devFlag: true })).toThrow(
      /absolute/
    )
    expect(
      () =>
        new FileVault({
          path: join(process.cwd(), "vault.json"),
          devFlag: true,
        })
    ).toThrow(/outside any git checkout/)
  })

  test("devFlagFromEnv reads EIDO_DEV_VAULT=1 only", () => {
    expect(devFlagFromEnv({ EIDO_DEV_VAULT: "1" })).toBe(true)
    expect(devFlagFromEnv({ EIDO_DEV_VAULT: "true" })).toBe(false)
    expect(devFlagFromEnv({})).toBe(false)
  })

  // Windows has no POSIX file modes, so the 0600 assertion only runs elsewhere.
  test.skipIf(process.platform === "win32")(
    "writes the file with mode 0600",
    async () => {
      const path = await tempPath()
      await new FileVault({ path, devFlag: true }).set(
        KEY,
        "test-refresh-token-1"
      )
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  )

  test("persists across instances", async () => {
    const path = await tempPath()
    await new FileVault({ path, devFlag: true }).set(
      KEY,
      "test-refresh-token-1"
    )
    expect(await new FileVault({ path, devFlag: true }).get(KEY)).toBe(
      "test-refresh-token-1"
    )
  })

  test("a corrupt file errors without leaking its contents", async () => {
    const path = await tempPath()
    await writeFile(path, "test-secret-in-bad-file")
    const vault = new FileVault({ path, devFlag: true })
    const error = await vault.get(KEY).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain(
      "test-secret-in-bad-file"
    )
  })

  test.each(["[]", "null", '{"a":1}'])(
    "rejects malformed store %s",
    async (content) => {
      const path = await tempPath()
      await writeFile(path, content)
      await expect(
        new FileVault({ path, devFlag: true }).get(KEY)
      ).rejects.toThrow(/could not be read/)
    }
  )

  test("delete removes the entry from disk", async () => {
    const path = await tempPath()
    const vault = new FileVault({ path, devFlag: true })
    await vault.set(KEY, "test-refresh-token-1")
    await vault.delete(KEY)
    expect(await readFile(path, "utf8")).not.toContain("test-refresh-token-1")
  })
})
