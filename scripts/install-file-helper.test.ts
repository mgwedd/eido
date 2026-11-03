import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  helperFileName,
  installFileHelper,
  pinLines,
} from "./install-file-helper.ts"

const dirs: string[] = []
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eido-install-helper-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

// SHA-256 of the ASCII bytes "abc", from the FIPS 180 test vector.
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("install-file-helper", () => {
  test("installs the binary and returns the pin the gate configuration records", () => {
    const work = temp()
    const source = path.join(work, "built")
    writeFileSync(source, "abc")
    const install = installFileHelper(source, path.join(work, "bin"), "linux")
    expect(install.path).toBe(path.join(work, "bin", "eido-file-helper"))
    expect(install.sha256).toBe(ABC)
    expect(readFileSync(install.path, "utf8")).toBe("abc")
    expect(pinLines(install)).toBe(
      `EIDO_FILE_HELPER_PATH=${install.path}\nEIDO_FILE_HELPER_SHA256=${ABC}`
    )
  })

  test("an upgrade replaces the binary and the pin changes", () => {
    const work = temp()
    const source = path.join(work, "built")
    const dir = path.join(work, "bin")
    writeFileSync(source, "abc")
    const first = installFileHelper(source, dir, "linux")
    writeFileSync(source, "abd")
    const second = installFileHelper(source, dir, "linux")
    expect(second.path).toBe(first.path)
    expect(second.sha256).not.toBe(first.sha256)
    expect(readFileSync(second.path, "utf8")).toBe("abd")
  })

  test("refuses a relative install directory", () => {
    const work = temp()
    const source = path.join(work, "built")
    writeFileSync(source, "abc")
    expect(() => installFileHelper(source, "relative/bin", "linux")).toThrow(
      "absolute"
    )
  })

  test.skipIf(process.platform === "win32")(
    "refuses a directory that group or others can write and installs nothing",
    () => {
      const work = temp()
      const source = path.join(work, "built")
      writeFileSync(source, "abc")
      const dir = path.join(work, "bin")
      installFileHelper(source, dir, "linux")
      chmodSync(dir, 0o770)
      expect(() => installFileHelper(source, dir, "linux")).toThrow(
        "writable by group or others"
      )
      chmodSync(dir, 0o700)
    }
  )

  test("names the Windows binary with .exe", () => {
    expect(helperFileName("win32")).toBe("eido-file-helper.exe")
    expect(helperFileName("darwin")).toBe("eido-file-helper")
  })
})
