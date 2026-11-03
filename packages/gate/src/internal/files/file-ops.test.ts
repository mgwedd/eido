import type {
  GateFileHelperRequest,
  GateFileHelperResponse,
  GateFileRoots,
} from "@eido/schemas"
import { describe, expect, it } from "vitest"
import { verifyChain } from "../audit"
import { payloadHash } from "../canonical"
import { openControlDb } from "../control-db"
import { auditRows, loggedText, signedFileRoots } from "../test-fixtures"
import type { FileHelper } from "./file-helper"
import { createFile, moveFile, restoreFile, trashFile } from "./file-ops"

const DOCS = {
  path: "/srv/example/docs",
  dev: "2a",
  ino: "1001",
  trashDir: ".eido-trash",
}
const ROOTS: GateFileRoots = { roots: [{ id: "docs", root: DOCS }] }

/** Records every request and answers from a script, one reply per call. */
function scripted(...replies: (GateFileHelperResponse | Error)[]) {
  const requests: GateFileHelperRequest[] = []
  const helper: FileHelper = (request) => {
    requests.push(request)
    const reply = replies.shift()
    if (reply === undefined) throw new Error("unexpected helper call")
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply)
  }
  return { helper, requests }
}
const done = (op: "create" | "move" | "trash" | "restore") =>
  ({ ok: true, op }) as const
const refused = (code: "exists" | "root_changed" | "not_found") =>
  ({ ok: false, code, message: "refused" }) as const

async function approved() {
  const db = openControlDb(":memory:")
  await signedFileRoots(db, ROOTS)
  return db
}
const actions = (db: Parameters<typeof auditRows>[0]) =>
  auditRows(db)
    .slice(1)
    .map((r) => [r.actor, r.action, r.target])

describe("confined file operations", () => {
  it("creates with the signed root identity and audits hashes only", async () => {
    const db = await approved()
    const { helper, requests } = scripted(done("create"))
    const content = new TextEncoder().encode("lorem-ipsum-file-body")
    const outcome = await createFile(db, helper, {
      rootId: "docs",
      path: "notes/secret-plan.txt",
      content,
    })
    expect(outcome).toEqual({ ok: true })
    expect(requests).toEqual([
      {
        op: "create",
        root: DOCS,
        path: "notes/secret-plan.txt",
        contentBase64: "bG9yZW0taXBzdW0tZmlsZS1ib2R5",
      },
    ])
    expect(actions(db)).toEqual([
      ["executor", "files.create.requested", "files:docs"],
      ["executor", "files.create.done", "files:docs"],
    ])
    const rows = auditRows(db)
    const requestHash = payloadHash({
      verb: "create",
      rootId: "docs",
      pathHash: payloadHash("notes/secret-plan.txt"),
      contentHash: payloadHash("bG9yZW0taXBzdW0tZmlsZS1ib2R5"),
    })
    expect(rows[1]?.detail_hash).toBe(requestHash)
    expect(rows[2]?.detail_hash).toBe(
      payloadHash({ requestHash, outcome: "done" })
    )
    const logged = loggedText(db)
    expect(logged).not.toContain("secret-plan")
    expect(logged).not.toContain("lorem-ipsum")
    expect(logged).not.toContain("bG9yZW0t")
    expect(verifyChain(db).ok).toBe(true)
    db.close()
  })

  it("refuses an unapproved root without running the helper", async () => {
    const db = openControlDb(":memory:")
    const { helper, requests } = scripted()
    const outcome = await moveFile(db, helper, {
      rootId: "docs",
      from: "a",
      to: "b",
    })
    expect(outcome).toEqual({ ok: false, code: "root_not_approved" })
    expect(requests).toEqual([])
    expect(auditRows(db).map((r) => r.action)).toEqual([
      "files.move.requested",
      "files.move.refused",
    ])
    db.close()
  })

  it("refuses when the signed roots were tampered with after approval", async () => {
    const db = await approved()
    db.prepare("UPDATE approved_file_roots SET payload_hash = ?").run(
      "0".repeat(64)
    )
    const { helper, requests } = scripted()
    const outcome = await createFile(db, helper, {
      rootId: "docs",
      path: "a.txt",
      content: new Uint8Array(),
    })
    expect(outcome).toEqual({ ok: false, code: "root_not_approved" })
    expect(requests).toEqual([])
    db.close()
  })

  it("passes the helper's refusal code through and audits it", async () => {
    const db = await approved()
    const { helper, requests } = scripted(refused("exists"))
    const outcome = await moveFile(db, helper, {
      rootId: "docs",
      from: "a.txt",
      to: "b.txt",
    })
    expect(outcome).toEqual({ ok: false, code: "exists" })
    expect(requests).toEqual([
      { op: "move", root: DOCS, from: "a.txt", to: "b.txt" },
    ])
    const last = auditRows(db).at(-1)
    expect(last?.action).toBe("files.move.refused")
    expect(last?.detail_hash).toBe(
      payloadHash({
        requestHash: payloadHash({
          verb: "move",
          rootId: "docs",
          fromHash: payloadHash("a.txt"),
          toHash: payloadHash("b.txt"),
        }),
        outcome: "exists",
      })
    )
    db.close()
  })

  it("reports a helper failure or a mismatched reply as helper_failed", async () => {
    const db = await approved()
    const thrown = scripted(new Error("private-marker"))
    expect(
      await restoreFile(db, thrown.helper, {
        rootId: "docs",
        trashName: "t",
        path: "a.txt",
      })
    ).toEqual({ ok: false, code: "helper_failed" })
    const wrong = scripted(done("move"))
    expect(
      await restoreFile(db, wrong.helper, {
        rootId: "docs",
        trashName: "t",
        path: "a.txt",
      })
    ).toEqual({ ok: false, code: "helper_failed" })
    expect(wrong.requests).toEqual([
      { op: "restore", root: DOCS, trashName: "t", path: "a.txt" },
    ])
    expect(loggedText(db)).not.toContain("private-marker")
    db.close()
  })

  it("trashes under a fresh name and returns it for restore", async () => {
    const db = await approved()
    const { helper, requests } = scripted(done("trash"))
    const outcome = await trashFile(db, helper, {
      rootId: "docs",
      path: "a.txt",
    })
    expect(outcome.ok).toBe(true)
    const request = requests[0]
    expect(request?.op).toBe("trash")
    if (!outcome.ok || request?.op !== "trash") return
    expect(request.trashName).toBe(outcome.trashName)
    expect(request.trashName).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(request.path).toBe("a.txt")
    db.close()
  })

  it("retries a trash-name collision with a new name, then gives up", async () => {
    const db = await approved()
    const retried = scripted(refused("exists"), done("trash"))
    const outcome = await trashFile(db, retried.helper, {
      rootId: "docs",
      path: "a.txt",
    })
    const names = retried.requests.map((r) =>
      r.op === "trash" ? r.trashName : ""
    )
    expect(outcome).toEqual({ ok: true, trashName: names[1] })
    expect(names[0]).not.toBe(names[1])

    const stuck = scripted(
      refused("exists"),
      refused("exists"),
      refused("exists")
    )
    expect(
      await trashFile(db, stuck.helper, { rootId: "docs", path: "a.txt" })
    ).toEqual({ ok: false, code: "exists" })
    expect(stuck.requests).toHaveLength(3)
    db.close()
  })

  it("does not retry a trash refusal other than a collision", async () => {
    const db = await approved()
    const { helper, requests } = scripted(refused("root_changed"))
    expect(
      await trashFile(db, helper, { rootId: "docs", path: "a.txt" })
    ).toEqual({ ok: false, code: "root_changed" })
    expect(requests).toHaveLength(1)
    db.close()
  })
})
