import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { openControlDb } from "../control-db"
import { controlAuthorization } from "../test-fixtures"
import { fileHelper } from "./file-helper"
import { createFile, moveFile, restoreFile, trashFile } from "./file-ops"
import { approvedFileRoot, prepareFileRoots, setFileRoots } from "./file-roots"

// Runs the real helper built by `cargo build --release --locked` (CI's file-helper job sets
// EIDO_FILE_HELPER). Without it the unit tests cover the wrapper with a mocked spawn.
const binary = process.env["EIDO_FILE_HELPER"]
const base = mkdtempSync(join(tmpdir(), "eido-files-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe.skipIf(binary === undefined)("the native file helper", () => {
  const path = binary ?? ""
  const helper = () =>
    fileHelper({
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    })

  test("runs every verb through signed roots and refuses a replaced root", async () => {
    const rootPath = join(realpathSync.native(base), "docs")
    mkdirSync(rootPath)
    const db = openControlDb(":memory:")
    const run = helper()
    const prepared = await prepareFileRoots(db, run, {
      roots: [{ id: "docs", path: rootPath, trashDir: ".eido-trash" }],
    })
    const roots: unknown = JSON.parse(prepared.payload)
    setFileRoots(db, roots, controlAuthorization(db, prepared))
    expect(approvedFileRoot(db, "docs")?.path).toBe(rootPath)

    const content = new TextEncoder().encode("lorem ipsum")
    expect(
      await createFile(db, run, { rootId: "docs", path: "a.txt", content })
    ).toEqual({ ok: true })
    expect(
      await createFile(db, run, {
        rootId: "docs",
        path: "a.txt",
        content: new Uint8Array([1]),
      })
    ).toEqual({ ok: false, code: "exists" })
    expect(readFileSync(join(rootPath, "a.txt"), "utf8")).toBe("lorem ipsum")
    const approved = approvedFileRoot(db, "docs")
    if (approved === undefined) throw new Error("missing approved root")
    expect(
      await run({ op: "read", root: approved, path: "a.txt", maxBytes: 100 })
    ).toEqual({ ok: true, op: "read", contentBase64: "bG9yZW0gaXBzdW0=" })
    expect(
      await run({ op: "read", root: approved, path: "a.txt", maxBytes: 2 })
    ).toMatchObject({ ok: false, code: "io" })
    expect(await run({ op: "list", root: approved, path: "" })).toEqual({
      ok: true,
      op: "list",
      entries: [{ name: "a.txt", kind: "file" }],
      truncated: false,
    })

    writeFileSync(join(rootPath, "b.txt"), "kept")
    expect(
      await moveFile(db, run, { rootId: "docs", from: "a.txt", to: "b.txt" })
    ).toEqual({ ok: false, code: "exists" })
    expect(readFileSync(join(rootPath, "b.txt"), "utf8")).toBe("kept")
    expect(
      await moveFile(db, run, { rootId: "docs", from: "a.txt", to: "c.txt" })
    ).toEqual({ ok: true })

    const trashed = await trashFile(db, run, { rootId: "docs", path: "c.txt" })
    if (!trashed.ok) throw new Error(`trash refused: ${trashed.code}`)
    expect(
      readFileSync(join(rootPath, ".eido-trash", trashed.trashName), "utf8")
    ).toBe("lorem ipsum")
    expect(
      await restoreFile(db, run, {
        rootId: "docs",
        trashName: trashed.trashName,
        path: "b.txt",
      })
    ).toEqual({ ok: false, code: "exists" })
    expect(
      await restoreFile(db, run, {
        rootId: "docs",
        trashName: trashed.trashName,
        path: "d.txt",
      })
    ).toEqual({ ok: true })
    expect(readFileSync(join(rootPath, "d.txt"), "utf8")).toBe("lorem ipsum")

    // Swap the approved directory for a different one at the same path.
    renameSync(rootPath, join(base, "docs-old"))
    mkdirSync(rootPath)
    expect(
      await createFile(db, run, { rootId: "docs", path: "e.txt", content })
    ).toEqual({ ok: false, code: "root_changed" })
    expect(readdirSync(rootPath)).toEqual([])
    db.close()
  })
})
