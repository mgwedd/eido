import { afterEach, describe, expect, it, vi } from "vitest"
import { issueNonce, verifyApproval } from "../approvals"
import { createExecutor } from "../executor"
import { propose } from "../intents"
import { call, projection, signIn, undoHandler } from "../phone-undo-harness"
import {
  assertion,
  auditRows,
  deviceChallenge,
  FILE_OPS,
  manifest,
  setup,
  signedFileRoots,
  testAuthenticator,
  WEBAUTHN,
} from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import type { FileHelper } from "./file-helper"

// Issue #831, file half: after a refused restore the executor never retries the Undo (the attempt
// is claimed once), so Activity must stop offering it. The route and the projection are read side
// by side over the real executor, against an in-memory disk behind the native helper interface.

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
  return { ...fixture, disk, helper, handler, cookie, deleteSigned }
}

describe("Activity undo state after a file restore attempt", () => {
  it("offers Undo for a signed delete before any attempt", async () => {
    const f = await world()
    const id = await f.deleteSigned()
    expect((await projection(f.handler, f.cookie, id))?.undo).toBe("available")
  })

  it("stops offering Undo after a refused restore, as the route refuses every retry", async () => {
    const f = await world()
    const id = await f.deleteSigned()
    f.disk.set(SOURCE, REPLACEMENT)
    const refused = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(refused.status).toBe(409)
    // The owner removes the colliding file; the executor still never repeats the attempt.
    f.disk.delete(SOURCE)
    const retry = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(retry.status).toBe(409)
    expect(retry.body).toEqual({
      code: "already_decided",
      message: "this execution cannot be undone",
    })
    expect((await projection(f.handler, f.cookie, id))?.undo).toBe("none")
    expect([...f.disk.keys()]).toEqual([
      expect.stringMatching(/^\.eido-trash\//),
    ])
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
  })
})
