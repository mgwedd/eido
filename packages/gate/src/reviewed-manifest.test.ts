import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readReviewedManifest, REVIEWED_MANIFEST_DIR } from "./internal/repin"
import { FILE_OPS, manifest } from "./internal/test-fixtures"
import { DATA_DIR_ENV, placeReviewedManifest } from "./reviewed-manifest"

let dir: string
let out: string[]
let err: string[]
const output = {
  out: (line: string) => out.push(line),
  err: (line: string) => err.push(line),
}
const reviewed = manifest("files", FILE_OPS, 2)
const place = (text: string, args: string[] = ["m.json"]) =>
  placeReviewedManifest(args, { [DATA_DIR_ENV]: dir }, () => text, output)
const target = () => join(dir, REVIEWED_MANIFEST_DIR, "files.json")

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-reviewed-"))
  out = []
  err = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("reviewed-manifest", () => {
  it("writes the manifest where re-pin reads it, owner-only, and says what it placed", () => {
    expect(place(JSON.stringify(reviewed))).toBe(0)
    expect(readReviewedManifest(dir, "files")).toEqual(reviewed)
    expect(readdirSync(join(dir, REVIEWED_MANIFEST_DIR))).toEqual([
      "files.json",
    ])
    expect(out[0]).toBe(`Placed files version 2 at ${target()}`)
  })

  it.skipIf(process.platform === "win32")(
    "makes the file readable by the owner only",
    () => {
      place(JSON.stringify(reviewed))
      expect(statSync(target()).mode & 0o777).toBe(0o600)
    }
  )

  it("replaces an earlier reviewed manifest for the same connector", () => {
    place(JSON.stringify(reviewed))
    place(JSON.stringify(manifest("files", FILE_OPS, 3)))
    expect(readReviewedManifest(dir, "files")).toMatchObject({ version: 3 })
  })

  it("refuses a field the schema does not define, so a credential cannot ride along", () => {
    const withSecret = {
      ...reviewed,
      auth: { ...reviewed.auth, clientSecret: "not-a-real-secret" },
    }
    expect(place(JSON.stringify(withSecret))).toBe(1)
    expect(err[0]).toBe("The manifest is not a valid connector manifest:")
    expect(existsSync(target())).toBe(false)
  })

  it("refuses a manifest that fails the schema and writes nothing", () => {
    expect(place(JSON.stringify({ ...reviewed, version: 0 }))).toBe(1)
    expect(err[0]).toBe("The manifest is not a valid connector manifest:")
    expect(existsSync(join(dir, REVIEWED_MANIFEST_DIR))).toBe(false)
  })

  it("refuses text that is not JSON", () => {
    expect(place("{nope")).toBe(1)
    expect(err).toEqual(["The manifest could not be read as JSON"])
  })

  it("refuses a source that cannot be read", () => {
    const code = placeReviewedManifest(
      ["missing.json"],
      { [DATA_DIR_ENV]: dir },
      () => {
        throw new Error("ENOENT")
      },
      output
    )
    expect(code).toBe(1)
    expect(err).toEqual(["The manifest could not be read as JSON"])
  })

  it("exits 2 with usage when no source or more than one is given", () => {
    expect(place("", [])).toBe(2)
    expect(place("", ["a.json", "b.json"])).toBe(2)
    expect(err).toEqual([
      "usage: reviewed-manifest <manifest.json | ->",
      "usage: reviewed-manifest <manifest.json | ->",
    ])
  })

  it("exits 2 when the data directory is not configured", () => {
    expect(placeReviewedManifest(["m.json"], {}, () => "", output)).toBe(2)
    expect(err).toEqual([`${DATA_DIR_ENV} is not set`])
  })

  it("exits 1 when the file cannot be written", () => {
    const code = placeReviewedManifest(
      ["m.json"],
      { [DATA_DIR_ENV]: join(dir, "missing", "\0bad") },
      () => JSON.stringify(reviewed),
      output
    )
    expect(code).toBe(1)
    expect(err[0]).toContain("Could not write")
  })
})
