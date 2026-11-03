import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { assertFileHelperInstall } from "./file-install"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})
function fixture() {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "eido-file-install-"))
  )
  dirs.push(dir)
  chmodSync(dir, 0o700)
  const path = join(dir, "helper")
  writeFileSync(path, "synthetic executable", { mode: 0o700 })
  return { dir, path }
}

describe("file helper install boundary", () => {
  it("accepts a private regular executable and rejects a missing or relative path", async () => {
    const f = fixture()
    await expect(assertFileHelperInstall(f.path)).resolves.toBeUndefined()
    await expect(assertFileHelperInstall("relative-helper")).rejects.toThrow(
      "owner-controlled"
    )
    await expect(
      assertFileHelperInstall(join(f.dir, "missing"))
    ).rejects.toThrow("owner-controlled")
  })

  it("rejects a directory in place of the executable", async () => {
    const f = fixture()
    const path = join(f.dir, "directory")
    mkdirSync(path)
    await expect(assertFileHelperInstall(path)).rejects.toThrow(
      "owner-controlled"
    )
  })

  it.skipIf(process.platform === "win32")(
    "rejects writable helper bytes and install directory",
    async () => {
      const f = fixture()
      chmodSync(f.path, 0o720)
      await expect(assertFileHelperInstall(f.path)).rejects.toThrow(
        "owner-controlled"
      )
      chmodSync(f.path, 0o700)
      chmodSync(f.dir, 0o770)
      await expect(assertFileHelperInstall(f.path)).rejects.toThrow(
        "owner-controlled"
      )
      chmodSync(f.dir, 0o700)
      chmodSync(f.path, 0o600)
      await expect(assertFileHelperInstall(f.path)).rejects.toThrow(
        "owner-controlled"
      )
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects a writable ancestor above a private install directory",
    async () => {
      const f = fixture()
      const install = join(f.dir, "install")
      mkdirSync(install, { mode: 0o700 })
      const path = join(install, "helper")
      writeFileSync(path, "synthetic executable", { mode: 0o700 })
      chmodSync(f.dir, 0o770)
      await expect(assertFileHelperInstall(path)).rejects.toThrow(
        "owner-controlled"
      )
    }
  )

  it.skipIf(process.platform === "win32")(
    "rejects a symlink executable or immediate install directory",
    async () => {
      const f = fixture()
      const alias = join(f.dir, "alias")
      symlinkSync(f.path, alias)
      await expect(assertFileHelperInstall(alias)).rejects.toThrow(
        "owner-controlled"
      )
      const dirAlias = join(f.dir, "dir-alias")
      symlinkSync(f.dir, dirAlias)
      await expect(
        assertFileHelperInstall(join(dirAlias, "helper"))
      ).rejects.toThrow("owner-controlled")
    }
  )
})
