import { afterEach, describe, expect, it, vi } from "vitest"
import { issueNonce, verifyApproval } from "../approvals"
import { verifyChain } from "../audit"
import { createExecutor } from "../executor"
import { propose } from "../intents"
import { call, projection, signIn, undoHandler } from "../phone-undo-harness"
import {
  assertion,
  auditRows,
  deviceChallenge,
  FILE_OPS,
  loggedText,
  manifest,
  setup,
  signedFileRoots,
  testAuthenticator,
  WEBAUTHN,
} from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import { listDisk } from "./disk-listing-double"
import type { FileHelper } from "./file-helper"

// Issues #831 and #846, file half: what the Undo route answers and what Activity offers around a
// file restore, read side by side over the real executor, against an in-memory disk behind the
// native helper interface. A restore refused before its attempt is claimed can be retried; one
// whose helper call started and did not report is never repeated, and Activity stops offering it.

const ROOT = {
  path: "/synthetic/docs",
  dev: "1",
  ino: "2",
  trashDir: ".eido-trash",
}
const SOURCE = "synthetic-source-a1.txt"
const BYTES = "synthetic-bytes-1"
const REPLACEMENT = "synthetic-replacement-2"

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

async function world() {
  s = setup([manifest("files", FILE_OPS)])
  const fixture = s
  await signedFileRoots(fixture.db, { roots: [{ id: "docs", root: ROOT }] })
  const disk = new Map<string, string>([[SOURCE, BYTES]])
  const helper = vi.fn<FileHelper>((request) => {
    if (request.op === "identify")
      return Promise.resolve({
        ok: true,
        op: "identify",
        canonicalPath: ROOT.path,
        dev: ROOT.dev,
        ino: ROOT.ino,
      })
    if (request.op === "list")
      return Promise.resolve(listDisk(disk, ROOT.trashDir, request.path))
    if (request.op !== "trash" && request.op !== "restore")
      throw new Error("unexpected helper request")
    const from =
      request.op === "trash"
        ? request.path
        : `${request.root.trashDir}/${request.trashName}`
    const to =
      request.op === "trash"
        ? `${request.root.trashDir}/${request.trashName}`
        : request.path
    if (disk.has(to))
      return Promise.resolve({ ok: false, code: "exists", message: "exists" })
    const bytes = disk.get(from)
    if (bytes === undefined)
      return Promise.resolve({
        ok: false,
        code: "not_found",
        message: "not found",
      })
    disk.set(to, bytes)
    disk.delete(from)
    return Promise.resolve({ ok: true, op: request.op })
  })
  const executor = createExecutor(
    fixture.db,
    [],
    () => Promise.reject(new Error("network forbidden")),
    helper
  )
  const handler = undoHandler(fixture, (id) => executor.undo(id))
  const cookie = await signIn(fixture, handler)

  async function deleteSigned(): Promise<string> {
    const proposed = propose(fixture.db, fixture.policy, {
      intent: { kind: "file.delete", args: { root: "docs", path: SOURCE } },
      origin: "reactive",
    })
    if (!proposed.ok) throw new Error(proposed.code)
    const auth = testAuthenticator()
    fixture.db
      .prepare(
        "INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES (?,?,0,?)"
      )
      .run(auth.credentialId, auth.publicKey, new Date().toISOString())
    const prepared = issueNonce(fixture.db, proposed.intentId)
    if (!prepared.ok) throw new Error("prepare failed")
    const approved = verifyApproval(fixture.db, WEBAUTHN, {
      intentId: proposed.intentId,
      nonce: prepared.nonce,
      assertion: assertion(
        auth,
        deviceChallenge(prepared.payloadHash, proposed.intentId, prepared.nonce)
      ),
    })
    if (!approved.ok) throw new Error("approval failed")
    expect((await executor.execute(proposed.intentId)).ok).toBe(true)
    return proposed.intentId
  }
  /** The Undo audit actions so far, in order. */
  const undoActions = () =>
    auditRows(fixture.db)
      .map((row) => row.action)
      .filter((action) => action.startsWith("undo"))
  /** The helper verbs called so far, in order. */
  const helperOps = () => helper.mock.calls.map(([request]) => request.op)
  return {
    ...fixture,
    disk,
    helper,
    handler,
    cookie,
    deleteSigned,
    undoActions,
    helperOps,
  }
}

describe("Activity undo state around a file restore attempt", () => {
  it("offers Undo for a signed delete before any attempt", async () => {
    const f = await world()
    const id = await f.deleteSigned()
    expect((await projection(f.handler, f.cookie, id))?.undo).toBe("available")
  })

  it("keeps offering Undo after a restore refused for a taken name, and restores once it is free", async () => {
    const f = await world()
    const id = await f.deleteSigned()
    f.disk.set(SOURCE, REPLACEMENT)
    const refused = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({
      code: "already_decided",
      message: "this execution cannot be undone",
    })
    // Refused before the attempt is claimed: listed, nothing moved, one audit row.
    expect(f.helperOps()).toEqual(["trash", "list"])
    expect(f.disk.get(SOURCE)).toBe(REPLACEMENT)
    expect(f.undoActions()).toEqual(["undo.refused.file_exists"])
    expect((await projection(f.handler, f.cookie, id))?.undo).toBe("available")
    // The owner removes the colliding file and tries again.
    f.disk.delete(SOURCE)
    const retry = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual({ id, undone: true })
    expect(f.disk).toEqual(new Map([[SOURCE, BYTES]]))
    expect((await projection(f.handler, f.cookie, id))?.undo).toBe("done")
    expect(f.undoActions()).toEqual([
      "undo.refused.file_exists",
      "undo.started",
      "undo",
    ])
    expect(verifyChain(f.db).ok).toBe(true)
    const activity = JSON.stringify(
      (await call(f.handler, "/audit", f.cookie, "GET")).body
    )
    for (const text of [SOURCE, BYTES, REPLACEMENT, ROOT.path]) {
      expect(loggedText(f.db)).not.toContain(text)
      expect(activity).not.toContain(text)
    }
  })

  it("stops offering Undo after a restore that started and did not report, and refuses every retry", async () => {
    const f = await world()
    const id = await f.deleteSigned()
    const implementation = f.helper.getMockImplementation()
    if (!implementation) throw new Error("missing helper")
    f.helper.mockImplementation((request) =>
      request.op === "restore"
        ? Promise.reject(new Error("helper went away"))
        : implementation(request)
    )
    const first = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(first.status).toBe(409)
    // The helper is back and the restore would now succeed; the attempt is still never repeated.
    f.helper.mockImplementation(implementation)
    const retry = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(retry.status).toBe(409)
    expect(retry.body).toEqual({
      code: "already_decided",
      message: "this execution cannot be undone",
    })
    expect((await projection(f.handler, f.cookie, id))?.undo).toBe("none")
    expect(f.helperOps()).toEqual(["trash", "list", "restore"])
    expect([...f.disk.keys()]).toEqual([
      expect.stringMatching(/^\.eido-trash\//),
    ])
    expect(f.undoActions()).toEqual([
      "undo.started",
      "undo.failed.file_helper_failed",
      "undo.refused.outcome_unresolved",
    ])
    expect(verifyChain(f.db).ok).toBe(true)
  })
})
