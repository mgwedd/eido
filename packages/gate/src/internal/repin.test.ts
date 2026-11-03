import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readReviewedManifest, REVIEWED_MANIFEST_DIR } from "./repin"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-repin-"))
  mkdirSync(join(dir, REVIEWED_MANIFEST_DIR))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("readReviewedManifest", () => {
  it("returns the parsed file for the named connector", () => {
    writeFileSync(
      join(dir, REVIEWED_MANIFEST_DIR, "files.json"),
      JSON.stringify({ name: "files" })
    )
    expect(readReviewedManifest(dir, "files")).toEqual({ name: "files" })
  })

  it("returns undefined when no file is placed", () => {
    expect(readReviewedManifest(dir, "files")).toBeUndefined()
  })

  it("returns null for a file that is not JSON", () => {
    writeFileSync(join(dir, REVIEWED_MANIFEST_DIR, "files.json"), "{nope")
    expect(readReviewedManifest(dir, "files")).toBeNull()
  })

  it("never reads outside the directory", () => {
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ leaked: true }))
    expect(readReviewedManifest(dir, "../secret")).toBeUndefined()
    expect(readReviewedManifest(dir, "a/b")).toBeUndefined()
  })
})
