import { afterEach, describe, expect, it, vi } from "vitest"
import type { Intent } from "@eido/schemas"
import { createExecutor } from "../executor"
import { propose } from "../intents"
import { issueNonce, verifyApproval } from "../approvals"
import { verifyChain } from "../audit"
import {
  FILE_OPS,
  manifest,
  setup,
  signedFileRoots,
  assertion,
  deviceChallenge,
  testAuthenticator,
  WEBAUTHN,
  loggedText,
} from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import type { FileHelper } from "./file-helper"

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})
const ROOT = {
  path: "/synthetic/docs",
  dev: "1",
  ino: "2",
  trashDir: ".eido-trash",
}
const content = "synthetic-private-content"
async function fixture() {
  s = setup([manifest("files", FILE_OPS)])
  const fixture = s
  await signedFileRoots(fixture.db, { roots: [{ id: "docs", root: ROOT }] })
  const disk = new Map<string, string>([["a.txt", content]])
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
    } else {
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
    }
    return Promise.resolve({ ok: true, op: request.op })
  })
  const executor = createExecutor(
    fixture.db,
    [],
    () => Promise.reject(new Error("network forbidden")),
    helper
  )
  function proposal(intent: Intent) {
    const result = propose(fixture.db, fixture.policy, {
      intent,
      origin: "reactive",
    })
    if (!result.ok) throw new Error(result.code)
    return result
  }
  function approve(id: string) {
    const auth = testAuthenticator()
    fixture.db
      .prepare(
        "INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES (?,?,0,?)"
      )
      .run(auth.credentialId, auth.publicKey, new Date().toISOString())
    const prepared = issueNonce(fixture.db, id)
    if (!prepared.ok) throw new Error("prepare failed")
    expect(
      verifyApproval(fixture.db, WEBAUTHN, {
        intentId: id,
        nonce: prepared.nonce,
        assertion: assertion(
          auth,
          deviceChallenge(prepared.payloadHash, id, prepared.nonce)
        ),
      }).ok
    ).toBe(true)
  }
  return { ...fixture, disk, helper, executor, proposal, approve }
}

const automatic = [
  { kind: "file.create", args: { root: "docs", path: "new.txt", content } },
  {
    kind: "file.rename",
    args: { root: "docs", path: "a.txt", newName: "renamed.txt" },
  },
  {
    kind: "file.move",
    args: { root: "docs", path: "a.txt", toPath: "archive/a.txt" },
  },
] as const satisfies readonly Intent[]

describe("native file executor lifecycle", () => {
  it.each(automatic)(
    "$kind proposes without changing files, executes, replays, then undoes once",
    async (intent) => {
      const f = await fixture()
      const proposed = f.proposal(intent)
      expect(proposed.tier).toBe("auto")
      expect(f.disk).toEqual(new Map([["a.txt", content]]))
      expect(f.helper).not.toHaveBeenCalled()
      expect((await f.executor.execute(proposed.intentId)).ok).toBe(true)
      const destination =
        intent.kind === "file.create"
          ? "new.txt"
          : intent.kind === "file.rename"
            ? "renamed.txt"
            : "archive/a.txt"
      expect(f.disk.get(destination)).toBe(content)
      expect((await f.executor.execute(proposed.intentId)).ok).toBe(true)
      expect(f.helper).toHaveBeenCalledTimes(1)
      expect((await f.executor.undo(proposed.intentId)).ok).toBe(true)
      if (intent.kind === "file.create") {
        expect(f.disk.has("new.txt")).toBe(false)
        expect([...f.disk.values()]).toEqual([content, content])
      } else expect(f.disk).toEqual(new Map([["a.txt", content]]))
      expect((await f.executor.undo(proposed.intentId)).ok).toBe(true)
      expect(f.helper).toHaveBeenCalledTimes(2)
      expect(verifyChain(f.db).ok).toBe(true)
      expect(loggedText(f.db)).not.toContain(content)
      expect(loggedText(f.db)).not.toContain(ROOT.path)
    }
  )

  it("Trash needs signed approval and Undo restores its exact stored name", async () => {
    const f = await fixture()
    const p = f.proposal({
      kind: "file.delete",
      args: { root: "docs", path: "a.txt" },
    })
    expect(p).toMatchObject({ tier: "approval", state: "pending" })
    expect((await f.executor.execute(p.intentId)).ok).toBe(false)
    expect(f.helper).not.toHaveBeenCalled()
    f.approve(p.intentId)
    const executed = await f.executor.execute(p.intentId)
    expect(executed.ok).toBe(true)
    expect(f.disk.has("a.txt")).toBe(false)
    expect([...f.disk.values()]).toEqual([content])
    expect((await f.executor.undo(p.intentId)).ok).toBe(true)
    expect(f.disk).toEqual(new Map([["a.txt", content]]))
    expect(f.helper.mock.calls.map(([request]) => request.op)).toEqual([
      "trash",
      "restore",
    ])
  })

  it("does not trust a forged approved state without a consumed signature", async () => {
    const f = await fixture()
    const p = f.proposal({
      kind: "file.delete",
      args: { root: "docs", path: "a.txt" },
    })
    f.db
      .prepare("UPDATE intents SET state='approved' WHERE id=?")
      .run(p.intentId)
    expect(await f.executor.execute(p.intentId)).toEqual({
      ok: false,
      code: "missing_approval",
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it("refuses file execution without configured helper", async () => {
    const f = await fixture()
    const p = f.proposal(automatic[0])
    const executor = createExecutor(f.db, [], () =>
      Promise.reject(new Error("network forbidden"))
    )
    expect(await executor.execute(p.intentId)).toEqual({
      ok: false,
      code: "file_helper_unavailable",
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it("rechecks signed roots before execution and before Undo", async () => {
    const f = await fixture()
    const p = f.proposal(automatic[0])
    await signedFileRoots(f.db, { roots: [] })
    expect(await f.executor.execute(p.intentId)).toEqual({
      ok: false,
      code: "root_not_allowed",
    })
    expect(f.helper).not.toHaveBeenCalled()
    await signedFileRoots(f.db, { roots: [{ id: "docs", root: ROOT }] })
    expect((await f.executor.execute(p.intentId)).ok).toBe(true)
    await signedFileRoots(f.db, {
      roots: [{ id: "docs", root: { ...ROOT, ino: "3" } }],
    })
    expect(await f.executor.undo(p.intentId)).toEqual({
      ok: false,
      code: "invalid_inverse",
    })
    expect(f.helper).toHaveBeenCalledTimes(1)
  })

  it("refuses a tampered inverse before invoking helper", async () => {
    const f = await fixture()
    const p = f.proposal(automatic[0])
    await f.executor.execute(p.intentId)
    f.db.prepare("UPDATE executions SET inverse_op=? WHERE intent_id=?").run(
      JSON.stringify({
        op: "trash",
        root: ROOT,
        path: "a.txt",
        trashName: "tampered",
      }),
      p.intentId
    )
    expect(await f.executor.undo(p.intentId)).toEqual({
      ok: false,
      code: "record_mismatch",
    })
    expect(f.helper).toHaveBeenCalledTimes(1)
  })

  it("restore collisions preserve both the replacement and trashed bytes", async () => {
    const f = await fixture()
    const p = f.proposal({
      kind: "file.delete",
      args: { root: "docs", path: "a.txt" },
    })
    f.approve(p.intentId)
    await f.executor.execute(p.intentId)
    f.disk.set("a.txt", "replacement")
    expect(await f.executor.undo(p.intentId)).toEqual({
      ok: false,
      code: "file_exists",
    })
    expect([...f.disk.values()].sort()).toEqual(["replacement", content].sort())
    expect((await f.executor.undo(p.intentId)).ok).toBe(false)
    expect(f.helper).toHaveBeenCalledTimes(2)
  })

  it("permits at most one in-flight native mutation across executor instances", async () => {
    const f = await fixture()
    const p = f.proposal(automatic[0])
    const implementation = f.helper.getMockImplementation()
    if (!implementation) throw new Error("missing helper")
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    f.helper.mockImplementation(async (request) => {
      await pending
      return implementation(request)
    })
    const first = f.executor.execute(p.intentId)
    const second = createExecutor(
      f.db,
      [],
      () => Promise.reject(new Error("network forbidden")),
      f.helper
    )
    expect(await second.execute(p.intentId)).toEqual({
      ok: false,
      code: "outcome_unresolved",
    })
    release?.()
    expect((await first).ok).toBe(true)
    expect(f.helper).toHaveBeenCalledTimes(1)
  })

  it("an uncertain native failure is not retried or logged verbatim", async () => {
    const f = await fixture()
    f.helper.mockRejectedValue(new Error("private failure payload"))
    const p = f.proposal(automatic[0])
    expect((await f.executor.execute(p.intentId)).ok).toBe(false)
    expect((await f.executor.execute(p.intentId)).ok).toBe(false)
    expect(f.helper).toHaveBeenCalledTimes(1)
    expect(loggedText(f.db)).not.toContain("private failure payload")
  })
  it("refuses to execute a delete that was never approved and to undo one that never ran", async () => {
    const f = await fixture()
    const p = f.proposal({
      kind: "file.delete",
      args: { root: "docs", path: "a.txt" },
    })
    expect((await f.executor.execute(p.intentId)).ok).toBe(false)
    expect((await f.executor.undo(p.intentId)).ok).toBe(false)
    expect(f.helper).not.toHaveBeenCalled()
    expect(f.disk).toEqual(new Map([["a.txt", content]]))
  })

  it("refuses file work while the files connector is unhealthy", async () => {
    const f = await fixture()
    const p = f.proposal(automatic[0])
    f.db.prepare("UPDATE connectors SET health='open' WHERE name='files'").run()
    expect(await f.executor.execute(p.intentId)).toEqual({
      ok: false,
      code: "connector_unavailable",
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it("reports a missing source on execute and a missing moved file on Undo without inventing a result", async () => {
    const f = await fixture()
    const missing = f.proposal({
      kind: "file.move",
      args: { root: "docs", path: "absent.txt", toPath: "x/absent.txt" },
    })
    expect(await f.executor.execute(missing.intentId)).toEqual({
      ok: false,
      code: "file_not_found",
    })
    const moved = f.proposal(automatic[2])
    expect((await f.executor.execute(moved.intentId)).ok).toBe(true)
    f.disk.delete("archive/a.txt")
    expect(await f.executor.undo(moved.intentId)).toEqual({
      ok: false,
      code: "file_not_found",
    })
  })

  it("never turns a rename into a path: a separator in the new name is not executed", async () => {
    const f = await fixture()
    const result = propose(f.db, f.policy, {
      intent: {
        kind: "file.rename",
        args: { root: "docs", path: "a.txt", newName: "sub/b.txt" },
      },
      origin: "reactive",
    })
    if (!result.ok) throw new Error(result.code)
    expect((await f.executor.execute(result.intentId)).ok).toBe(false)
    expect(f.disk).toEqual(new Map([["a.txt", content]]))
  })
})
