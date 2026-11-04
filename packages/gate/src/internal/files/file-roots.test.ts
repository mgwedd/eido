import type { GateFileRoots } from "@eido/schemas"
import type { FileHelper } from "./file-helper"
import { describe, expect, it } from "vitest"
import { verifyChain } from "../audit"
import { canonicalize, payloadHash } from "../canonical"
import { openControlDb } from "../control-db"
import { preparePolicyChange } from "../policy"
import {
  auditRows,
  controlAuthorization,
  identifyingHelper,
  signedFileRoots,
} from "../test-fixtures"
import {
  approvedFileRoot,
  checkedFileRoots,
  FileRootUnidentified,
  prepareFileRoots,
  setFileRoots,
} from "./file-roots"

const DOCS = {
  path: "/srv/example/docs",
  dev: "2a",
  ino: "1001",
  trashDir: ".eido-trash",
}
const ARCHIVE = {
  path: "C:\\example\\archive",
  dev: "3141",
  ino: "00ff00ff",
  trashDir: "trash",
}
const ROOTS: GateFileRoots = {
  roots: [
    { id: "docs", root: DOCS },
    { id: "archive", root: ARCHIVE },
  ],
}
const REQUEST = {
  roots: [
    { id: "docs", path: DOCS.path, trashDir: DOCS.trashDir },
    { id: "archive", path: ARCHIVE.path, trashDir: ARCHIVE.trashDir },
  ],
}

describe("signed file roots", () => {
  it("captures each root's identity from the helper and binds the ceremony to it", async () => {
    const db = openControlDb(":memory:")
    const prepared = await prepareFileRoots(
      db,
      identifyingHelper(ROOTS),
      REQUEST
    )
    expect(prepared.purpose).toBe("policy.set")
    expect(prepared.target).toBe("file-roots")
    expect(prepared.payloadHash).toBe(payloadHash(ROOTS))
    expect(prepared.payload).toBe(canonicalize(ROOTS))
    setFileRoots(db, ROOTS, controlAuthorization(db, prepared))
    expect(approvedFileRoot(db, "docs")).toEqual(DOCS)
    expect(approvedFileRoot(db, "archive")).toEqual(ARCHIVE)
    expect(approvedFileRoot(db, "other")).toBeUndefined()
    const rows = auditRows(db)
    expect(rows.map((r) => [r.actor, r.action, r.target])).toEqual([
      ["approver", "files.roots.changed", "file-roots"],
    ])
    expect(JSON.stringify(rows)).not.toContain("/srv/example")
    expect(verifyChain(db).ok).toBe(true)
    db.close()
  })

  it("refuses an unsigned change without storing or auditing anything", () => {
    const db = openControlDb(":memory:")
    expect(() => setFileRoots(db, ROOTS)).toThrow("control approval refused")
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    expect(auditRows(db)).toEqual([])
    db.close()
  })

  it("refuses roots that differ from the signed payload", async () => {
    const db = openControlDb(":memory:")
    const prepared = await prepareFileRoots(
      db,
      identifyingHelper(ROOTS),
      REQUEST
    )
    const authorization = controlAuthorization(db, prepared)
    const swapped = {
      roots: [{ id: "docs", root: { ...DOCS, ino: "1002" } }, ROOTS.roots[1]],
    }
    expect(() => setFileRoots(db, swapped, authorization)).toThrow(
      "control approval refused"
    )
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    expect(auditRows(db)).toEqual([])
    db.close()
  })

  it("refuses a replayed approval", async () => {
    const db = openControlDb(":memory:")
    const prepared = await prepareFileRoots(
      db,
      identifyingHelper(ROOTS),
      REQUEST
    )
    const authorization = controlAuthorization(db, prepared)
    setFileRoots(db, ROOTS, authorization)
    const before = auditRows(db)
    expect(() => setFileRoots(db, ROOTS, authorization)).toThrow(
      "control approval refused"
    )
    expect(auditRows(db)).toEqual(before)
    db.close()
  })

  it("refuses an approval signed for another target", () => {
    const db = openControlDb(":memory:")
    const prepared = preparePolicyChange(db, { version: 1, tiers: {} })
    expect(() =>
      setFileRoots(db, ROOTS, controlAuthorization(db, prepared))
    ).toThrow("control approval refused")
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.close()
  })

  it("refuses a card superseded by a newer prepare", async () => {
    const db = openControlDb(":memory:")
    const first = await prepareFileRoots(db, identifyingHelper(ROOTS), REQUEST)
    const authorization = controlAuthorization(db, first)
    await prepareFileRoots(db, identifyingHelper(ROOTS), REQUEST)
    expect(() => setFileRoots(db, ROOTS, authorization)).toThrow(
      "control approval refused"
    )
    db.close()
  })

  it("fails closed when the stored row is tampered with", async () => {
    const db = openControlDb(":memory:")
    await signedFileRoots(db, ROOTS)
    const tampered = {
      roots: [{ id: "docs", root: { ...DOCS, path: "/srv/example/other" } }],
    }
    db.prepare(
      "UPDATE approved_file_roots SET payload_json = ?, payload_hash = ?"
    ).run(canonicalize(tampered), payloadHash(tampered))
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.prepare("UPDATE approved_file_roots SET payload_json = ?").run(
      JSON.stringify(ROOTS, null, 1)
    )
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.prepare("UPDATE approved_file_roots SET payload_json = ?").run("{")
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.close()
  })

  it("fails closed when an older signed set is put back", async () => {
    const db = openControlDb(":memory:")
    await signedFileRoots(db, ROOTS)
    const old = db.prepare("SELECT * FROM approved_file_roots").get()
    const newer = { roots: [{ id: "docs", root: DOCS }] }
    await signedFileRoots(db, newer)
    expect(approvedFileRoot(db, "archive")).toBeUndefined()
    db.prepare(
      "UPDATE approved_file_roots SET payload_json = ?, payload_hash = ?, approval_id = ?"
    ).run(
      String(old?.["payload_json"]),
      String(old?.["payload_hash"]),
      String(old?.["approval_id"])
    )
    expect(approvedFileRoot(db, "archive")).toBeUndefined()
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.close()
  })

  it("fails closed when the audit chain is broken", async () => {
    const db = openControlDb(":memory:")
    await signedFileRoots(db, ROOTS)
    db.exec("DROP TRIGGER IF EXISTS audit_log_no_update")
    db.prepare("UPDATE audit_log SET detail_hash = ?").run("0".repeat(64))
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.close()
  })

  it("refuses to prepare a root the helper cannot identify", async () => {
    const db = openControlDb(":memory:")
    const helper = identifyingHelper({ roots: ROOTS.roots.slice(0, 1) })
    // archive, the second root, is the one the helper cannot find: the error names it.
    const missing = await prepareFileRoots(db, helper, REQUEST).catch(
      (error: unknown) => error
    )
    expect(missing).toBeInstanceOf(FileRootUnidentified)
    expect(missing).toHaveProperty("rootId", "archive")
    await expect(
      prepareFileRoots(db, helper, {
        roots: [{ id: "Docs", path: "/x", trashDir: "t" }],
      })
    ).rejects.toThrow("invalid file roots")
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM control_approvals").get()?.["n"]
    ).toBe(0)
    db.close()
  })

  it("treats a helper reply for another operation as a helper fault, not a missing root", async () => {
    const db = openControlDb(":memory:")
    const wrongOp: FileHelper = () =>
      Promise.resolve({ ok: true, op: "create" })
    const fault = await prepareFileRoots(db, wrongOp, REQUEST).catch(
      (error: unknown) => error
    )
    expect(fault).toBeInstanceOf(Error)
    expect(fault).not.toBeInstanceOf(FileRootUnidentified)
    db.close()
  })

  it.each([
    [
      "a duplicate id",
      { roots: [ROOTS.roots[0], { id: "docs", root: ARCHIVE }] },
    ],
    [
      "the same directory twice",
      {
        roots: [
          ROOTS.roots[0],
          { id: "copy", root: { ...DOCS, path: "/srv/example/link" } },
        ],
      },
    ],
    [
      "a relative path",
      { roots: [{ id: "docs", root: { ...DOCS, path: "docs" } }] },
    ],
    [
      "a trash dir with a separator",
      { roots: [{ id: "docs", root: { ...DOCS, trashDir: "a/b" } }] },
    ],
    [
      "an identity that is not hex",
      { roots: [{ id: "docs", root: { ...DOCS, ino: "-1" } }] },
    ],
  ])("rejects %s", (_, value) => {
    expect(() => checkedFileRoots(value)).toThrow("invalid file roots")
  })
})
