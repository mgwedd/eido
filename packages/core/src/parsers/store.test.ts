import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  BlobConflictError,
  blobPath,
  isSha256,
  sha256Hex,
  storeOriginal,
} from "./store"

// sha256("abc"), from FIPS 180-2's test vectors.
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-store-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("storeOriginal", () => {
  it("writes the bytes at a path made from the hash alone", () => {
    const stored = storeOriginal(dir, new TextEncoder().encode("abc"))
    expect(stored).toEqual({
      sha256: ABC,
      blobPath: join(dir, "blobs", "ba", ABC),
    })
    expect(readFileSync(stored.blobPath, "utf8")).toBe("abc")
    expect(statSync(stored.blobPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, "blobs", "ba"))).toEqual([ABC])
  })

  it("is idempotent: storing the same bytes again keeps the one file", () => {
    const first = storeOriginal(dir, new TextEncoder().encode("abc"))
    const before = statSync(first.blobPath).ino
    const second = storeOriginal(dir, new TextEncoder().encode("abc"))
    expect(second).toEqual(first)
    expect(statSync(second.blobPath).ino).toBe(before)
    expect(readdirSync(join(dir, "blobs", "ba"))).toEqual([ABC])
  })

  it("refuses to overwrite a file at that path with different content", () => {
    const path = blobPath(dir, ABC)
    storeOriginal(dir, new TextEncoder().encode("abc"))
    rmSync(path)
    writeFileSync(path, "tampered")
    expect(() => storeOriginal(dir, new TextEncoder().encode("abc"))).toThrow(
      BlobConflictError
    )
    expect(readFileSync(path, "utf8")).toBe("tampered")
    expect(readdirSync(join(dir, "blobs", "ba"))).toEqual([ABC])
  })

  it("fails when the blob directory cannot be made", () => {
    writeFileSync(join(dir, "blobs"), "a file where the directory should be")
    expect(() => storeOriginal(dir, new TextEncoder().encode("abc"))).toThrow(
      /EEXIST|ENOTDIR/
    )
  })
})

describe("blobPath and isSha256", () => {
  it.each(["../../etc/passwd", ABC.toUpperCase(), ABC.slice(1), `${ABC}0`, ""])(
    "refuses %j",
    (value) => {
      expect(isSha256(value)).toBe(false)
      expect(() => blobPath(dir, value)).toThrow("not a SHA-256 hex digest")
    }
  )

  it("hashes bytes as lowercase hex", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(ABC)
  })
})
