import { afterEach, describe, expect, it, vi } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import type {
  GateFileHelperResponse,
  GateFileRoots,
  GateLocalFileRequest,
} from "@eido/schemas"
import { openControlDb } from "../control-db"
import { verifyChain } from "../audit"
import { auditRows, loggedText, signedFileRoots } from "../test-fixtures"
import type { GateRequest } from "../http"
import { createFileReads, fileReadRoute } from "./file-reads"
import type { FileHelper } from "./file-helper"

const ROOT = {
  path: "/synthetic/private-directory",
  dev: "1",
  ino: "10",
  trashDir: ".eido-trash",
}
const ROOTS: GateFileRoots = { roots: [{ id: "docs", root: ROOT }] }
const READ: GateLocalFileRequest = {
  op: "read",
  root: "docs",
  path: "private-filename.txt",
  maxBytes: 100,
}
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
async function fixture(signed = true) {
  const db = openControlDb(":memory:")
  databases.push(db)
  if (signed) await signedFileRoots(db, ROOTS)
  const helper = vi.fn<FileHelper>().mockResolvedValue({
    ok: true,
    op: "read",
    contentBase64: Buffer.from("private-body-marker").toString("base64"),
  })
  const files = createFileReads(db, helper)
  return { db, helper, files }
}
function request(body: unknown = READ): GateRequest {
  return {
    method: "POST",
    path: "/files",
    query: new URLSearchParams(),
    headers: {},
    body: () => Promise.resolve({ ok: true, text: JSON.stringify(body) }),
  }
}

describe("gate local file reads", () => {
  it("binds reads and lists to the signed identity, auditing hashes without file names or bytes", async () => {
    const f = await fixture()
    expect(f.files.roots()).toEqual(ROOTS)
    expect((await f.files.perform(READ)).ok).toBe(true)
    expect(f.helper.mock.calls).toEqual([
      [{ op: "read", root: ROOT, path: "private-filename.txt", maxBytes: 100 }],
    ])
    f.helper.mockResolvedValue({
      ok: true,
      op: "list",
      entries: [{ name: "note.txt", kind: "file" }],
      truncated: false,
    })
    await f.files.perform({ op: "list", root: "docs", path: "" })
    expect(f.helper.mock.lastCall).toEqual([
      { op: "list", root: ROOT, path: "" },
    ])
    expect(auditRows(f.db).map(({ action }) => action)).toEqual([
      "files.roots.changed",
      "files.read",
      "files.list",
    ])
    expect(verifyChain(f.db).ok).toBe(true)
    const logs = loggedText(f.db)
    for (const secret of [
      ROOT.path,
      "private-filename.txt",
      "private-body-marker",
      Buffer.from("private-body-marker").toString("base64"),
    ])
      expect(logs).not.toContain(secret)
  })

  it("never calls the helper for unknown or tampered root authority", async () => {
    const f = await fixture()
    expect(await f.files.perform({ ...READ, root: "unknown" })).toMatchObject({
      ok: false,
      code: "invalid_path",
    })
    f.db
      .prepare(
        "UPDATE approved_file_roots SET payload_hash=? WHERE singleton=1"
      )
      .run("0".repeat(64))
    expect(f.files.roots()).toEqual({ roots: [] })
    expect(await f.files.perform(READ)).toMatchObject({
      ok: false,
      code: "invalid_path",
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it("refuses read authority when no roots were signed", async () => {
    const f = await fixture(false)
    expect(f.files.roots()).toEqual({ roots: [] })
    expect(await fileReadRoute(request(), f.files)).toEqual({
      status: 403,
      body: { code: "forbidden", message: "file path is not allowed" },
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it("serves only the read routes and fails closed without a configured helper", async () => {
    const f = await fixture()
    expect(
      await fileReadRoute(
        { ...request(), method: "GET", path: "/file-roots" },
        f.files
      )
    ).toEqual({ status: 200, body: ROOTS })
    expect(await fileReadRoute(request())).toEqual({
      status: 503,
      body: { code: "unavailable", message: "file helper is not configured" },
    })
    expect(
      await fileReadRoute({ ...request(), path: "/files/delete" }, f.files)
    ).toBeUndefined()
    expect(
      await fileReadRoute({ ...request(), method: "GET" }, f.files)
    ).toBeUndefined()
  })

  it.each([
    null,
    [],
    {},
    { ...READ, maxBytes: 8388609 },
    { ...READ, maxBytes: 0 },
    { ...READ, extra: "private-marker" },
    { op: "create", root: "docs", path: "file.txt", content: "body" },
  ])("rejects invalid read payload %j before native dispatch", async (body) => {
    const f = await fixture()
    expect(await fileReadRoute(request(body), f.files)).toEqual({
      status: 400,
      body: { code: "invalid_request", message: "invalid file read request" },
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it("bounds and validates request JSON without reflecting it", async () => {
    const f = await fixture()
    expect(
      await fileReadRoute(
        { ...request(), body: () => Promise.resolve({ ok: false }) },
        f.files
      )
    ).toEqual({
      status: 413,
      body: {
        code: "invalid_request",
        message: "file read request is too large",
      },
    })
    expect(
      await fileReadRoute(
        {
          ...request(),
          body: () => Promise.resolve({ ok: true, text: "private-marker{" }),
        },
        f.files
      )
    ).toEqual({
      status: 400,
      body: { code: "invalid_request", message: "invalid file read request" },
    })
    expect(f.helper).not.toHaveBeenCalled()
  })

  it.each([
    ["invalid_path", 403, "forbidden", "file path is not allowed"],
    ["symlink", 403, "forbidden", "file path is not allowed"],
    ["root_changed", 403, "forbidden", "file path is not allowed"],
    ["not_found", 404, "not_found", "file was not found"],
    ["io", 503, "unavailable", "file read could not be completed"],
  ] as const)(
    "maps helper refusal %s into a bounded API response",
    async (code, status, apiCode, message) => {
      const f = await fixture()
      f.helper.mockResolvedValue({
        ok: false,
        code,
        message: "private-native-marker",
      })
      expect(await fileReadRoute(request(), f.files)).toEqual({
        status,
        body: { code: apiCode, message },
      })
    }
  )

  it("sanitizes native exceptions and returns the validated successful response", async () => {
    const f = await fixture()
    f.helper.mockRejectedValueOnce(new Error("private-native-marker"))
    expect(await fileReadRoute(request(), f.files)).toEqual({
      status: 503,
      body: {
        code: "unavailable",
        message: "file read could not be completed",
      },
    })
    const response: GateFileHelperResponse = {
      ok: true,
      op: "read",
      contentBase64: "eA==",
    }
    f.helper.mockResolvedValue(response)
    expect(await fileReadRoute(request(), f.files)).toEqual({
      status: 200,
      body: response,
    })
  })
})
