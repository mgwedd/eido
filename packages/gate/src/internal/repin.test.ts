import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  listReviewedManifests,
  readReviewedManifest,
  REVIEWED_MANIFEST_DIR,
} from "./repin"

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

  it("falls back to the committed manifest when no file is placed", () => {
    expect(readReviewedManifest(dir, "files")).toMatchObject({
      name: "files",
      version: 1,
    })
  })

  it("returns undefined when neither a file nor a committed manifest exists", () => {
    expect(readReviewedManifest(dir, "notes")).toBeUndefined()
    expect(readReviewedManifest(dir, "constructor")).toBeUndefined()
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

describe("listReviewedManifests", () => {
  it("lists the placed manifest files with the committed ones, sorted and once each", () => {
    for (const file of ["gmail.json", "zulip.json", "notes.txt", ".x.json"])
      writeFileSync(join(dir, REVIEWED_MANIFEST_DIR, file), "{}")
    writeFileSync(join(dir, REVIEWED_MANIFEST_DIR, "gmail.json.1.tmp"), "{}")
    expect(listReviewedManifests(dir)).toEqual([
      "drive",
      "files",
      "gmail",
      "things",
      "zulip",
    ])
  })

  it("lists the committed manifests when none has been placed", () => {
    rmSync(join(dir, REVIEWED_MANIFEST_DIR), { recursive: true })
    expect(listReviewedManifests(dir)).toEqual([
      "drive",
      "files",
      "gmail",
      "things",
    ])
  })
})
