import { afterEach, describe, expect, it, vi } from "vitest"
import type { Intent } from "@eido/schemas"
import { issueNonce, verifyApproval } from "../approvals"
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
import type { FileHelper } from "./file-helper"

// Issue #416, file half: the phone Undo route over the real executor and file operations, against
// an in-memory disk double behind the native helper interface. Expected disks are hand-written;
// names and bytes are synthetic.

const ROOT = {
  path: "/synthetic/docs",
  dev: "1",
  ino: "2",
  trashDir: ".eido-trash",
}
const BYTES = "private-bytes-5e19"
const SOURCE = "private-source-name-a1.txt"
const RENAMED = "private-renamed-name-b2.txt"
const MOVED = "private-folder-c3/private-source-name-a1.txt"
const CREATED = "private-created-name-d4.txt"
const PRIVATE_TEXT = [BYTES, SOURCE, RENAMED, MOVED, CREATED, ROOT.path]

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
    if (request.op === "create") {
      if (disk.has(request.path))
        return Promise.resolve({ ok: false, code: "exists", message: "exists" })
      disk.set(
        request.path,
        Buffer.from(request.contentBase64, "base64").toString("utf8")
      )
      return Promise.resolve({ ok: true, op: "create" })
    }
    if (
      request.op !== "move" &&
      request.op !== "trash" &&
      request.op !== "restore"
    )
      throw new Error("unexpected read")
    const from =
      request.op === "move"
        ? request.from
        : request.op === "trash"
          ? request.path
          : `${request.root.trashDir}/${request.trashName}`
    const to =
      request.op === "move"
        ? request.to
        : request.op === "trash"
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

  function proposal(intent: Intent) {
    const proposed = propose(fixture.db, fixture.policy, {
      intent,
      origin: "reactive",
    })
    if (!proposed.ok) throw new Error(proposed.code)
    return proposed
  }
  async function execute(intent: Intent): Promise<string> {
    const proposed = proposal(intent)
    if (proposed.tier === "approval") {
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
          deviceChallenge(
            prepared.payloadHash,
            proposed.intentId,
            prepared.nonce
          )
        ),
      })
      if (!approved.ok) throw new Error("approval failed")
    }
    expect((await executor.execute(proposed.intentId)).ok).toBe(true)
    return proposed.intentId
  }
  const actions = () => auditRows(fixture.db).map((row) => row.action)
  /** The disk with the trash folder's entries listed under one stable name per entry. */
  const snapshot = () =>
    [...disk]
      .map(([path, bytes]) =>
        path.startsWith(`${ROOT.trashDir}/`)
          ? ([`${ROOT.trashDir}/<trashed>`, bytes] as const)
          : ([path, bytes] as const)
      )
      .sort(([a], [b]) => a.localeCompare(b))
  return {
    ...fixture,
    disk,
    helper,
    handler,
    cookie,
    execute,
    actions,
    snapshot,
  }
}

/** What the route returns, Activity says and the audit chain gains when `id` is undone twice. */
async function undoTwice(f: Awaited<ReturnType<typeof world>>, id: string) {
  expect((await projection(f.handler, f.cookie, id))?.undo).toBe("available")
  const before = f.actions()
  const callsBefore = f.helper.mock.calls.length
  const first = await call(f.handler, `/executions/${id}/undo`, f.cookie)
  expect(first.status).toBe(200)
  expect(first.body).toEqual({ id, undone: true })
  // The attempt marker written before the helper runs, then the one audited result.
  expect(f.actions().slice(before.length)).toEqual(["undo.started", "undo"])
  expect(f.helper).toHaveBeenCalledTimes(callsBefore + 1)
  expect((await projection(f.handler, f.cookie, id))?.undo).toBe("done")
  const rows = auditRows(f.db).filter((row) => row.action === "undo")
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ actor: "executor", target: id })
  const activity = JSON.stringify(
    (await call(f.handler, "/audit", f.cookie, "GET")).body
  )
  for (const text of PRIVATE_TEXT) {
    expect(loggedText(f.db)).not.toContain(text)
    expect(activity).not.toContain(text)
  }
  const rowCount = auditRows(f.db).length
  expect(
    (await call(f.handler, `/executions/${id}/undo`, f.cookie)).status
  ).toBe(409)
  expect(auditRows(f.db)).toHaveLength(rowCount)
  expect(f.helper).toHaveBeenCalledTimes(callsBefore + 1)
}

describe("phone Undo through the real executor and file operations", () => {
  it("undoes a create by moving the new file to the trash once", async () => {
    const f = await world()
    const id = await f.execute({
      kind: "file.create",
      args: { root: "docs", path: CREATED, content: BYTES },
    })
    expect(f.snapshot()).toEqual([
      [CREATED, BYTES],
      [SOURCE, BYTES],
    ])
    await undoTwice(f, id)
    expect(f.snapshot()).toEqual([
      [`${ROOT.trashDir}/<trashed>`, BYTES],
      [SOURCE, BYTES],
    ])
  })

  it("undoes a rename by moving the file back once", async () => {
    const f = await world()
    const id = await f.execute({
      kind: "file.rename",
      args: { root: "docs", path: SOURCE, newName: RENAMED },
    })
    expect(f.snapshot()).toEqual([[RENAMED, BYTES]])
    await undoTwice(f, id)
    expect(f.snapshot()).toEqual([[SOURCE, BYTES]])
  })

  it("undoes a move by moving the file back once", async () => {
    const f = await world()
    const id = await f.execute({
      kind: "file.move",
      args: { root: "docs", path: SOURCE, toPath: MOVED },
    })
    expect(f.snapshot()).toEqual([[MOVED, BYTES]])
    await undoTwice(f, id)
    expect(f.snapshot()).toEqual([[SOURCE, BYTES]])
  })

  it("undoes a signed delete by restoring the trashed file once", async () => {
    const f = await world()
    const id = await f.execute({
      kind: "file.delete",
      args: { root: "docs", path: SOURCE },
    })
    expect(f.snapshot()).toEqual([[`${ROOT.trashDir}/<trashed>`, BYTES]])
    await undoTwice(f, id)
    expect(f.snapshot()).toEqual([[SOURCE, BYTES]])
  })

  it("refuses a restore that would replace a file and leaves both copies", async () => {
    const f = await world()
    const id = await f.execute({
      kind: "file.delete",
      args: { root: "docs", path: SOURCE },
    })
    f.disk.set(SOURCE, "private-replacement-8a77")
    const response = await call(f.handler, `/executions/${id}/undo`, f.cookie)
    expect(response.status).toBe(409)
    expect(f.snapshot()).toEqual([
      [`${ROOT.trashDir}/<trashed>`, BYTES],
      [SOURCE, "private-replacement-8a77"],
    ])
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
  })
})
