import { validateGateApiError } from "@eido/schemas"
import type { GateFileRoot, GateFileRoots } from "@eido/schemas"
import { describe, expect, it } from "vitest"
import { openControlDb } from "./control-db"
import { prepareControlApproval } from "./control-approvals"
import { fileRootRoute } from "./file-root-routes"
import type { GateRequest } from "./http"
import type { FileHelper } from "./files/file-helper"
import { controlAuthorization, WEBAUTHN } from "./test-fixtures"
import { approvedFileRoot, prepareFileRoots } from "./files/file-roots"

const ROOT: GateFileRoot = {
  path: "/srv/safe/docs",
  dev: "8",
  ino: "19",
  trashDir: ".trash",
}
const ROOTS: GateFileRoots = { roots: [{ id: "docs", root: ROOT }] }
const REQUEST = {
  roots: [{ id: "docs", path: "/caller/path", trashDir: ".trash" }],
}

const helper = () =>
  Promise.resolve({
    ok: true as const,
    op: "identify" as const,
    canonicalPath: ROOT.path,
    dev: ROOT.dev,
    ino: ROOT.ino,
  })

function request(method: string, path: string, value?: unknown): GateRequest {
  return {
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    body: () => Promise.resolve({ ok: true, text: JSON.stringify(value) }),
  }
}

describe("file root control routes", () => {
  it("returns helper canonical paths and identities in the signed challenge", async () => {
    const db = openControlDb(":memory:")
    const reply = await fileRootRoute(
      request("POST", "/file-roots/prepare", REQUEST),
      { db, fileHelper: helper }
    )
    expect(reply?.status).toBe(200)
    if (
      reply?.status !== 200 ||
      typeof reply.body !== "object" ||
      reply.body === null
    )
      throw new Error("prepare did not return a challenge")
    expect(reply.body).toMatchObject({
      purpose: "policy.set",
      target: "file-roots",
      roots: ROOTS,
    })
    expect(JSON.stringify(reply.body)).not.toContain("/caller/path")
    db.close()
  })

  it("names the root the helper cannot identify by its id, never its path or the helper's text", async () => {
    const db = openControlDb(":memory:")
    const twoRoots = {
      roots: [
        ...REQUEST.roots,
        { id: "rental", path: "/caller/rental", trashDir: ".trash" },
      ],
    }
    const reply = await fileRootRoute(
      request("POST", "/file-roots/prepare", twoRoots),
      {
        db,
        fileHelper: (asked) =>
          asked.op === "identify" && asked.path === "/caller/rental"
            ? Promise.resolve({
                ok: false,
                code: "not_found",
                message: "no such directory",
              })
            : helper(),
      }
    )
    expect(reply).toEqual({
      status: 422,
      body: {
        code: "root_missing",
        rootId: "rental",
        message: "the file helper could not identify this folder",
      },
    })
    expect(validateGateApiError(reply?.body).ok).toBe(true)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM control_approvals").get()?.[
        "count"
      ]
    ).toBe(0)
    db.close()
  })

  it("answers a helper that fails outright with the generic refusal, naming no root", async () => {
    const db = openControlDb(":memory:")
    const reply = await fileRootRoute(
      request("POST", "/file-roots/prepare", REQUEST),
      { db, fileHelper: () => Promise.reject(new Error("file helper failed")) }
    )
    expect(reply).toEqual({
      status: 400,
      body: {
        code: "invalid_request",
        message: "file roots could not be prepared",
      },
    })
    db.close()
  })

  it("treats response-shaped JSON as invalid request data", async () => {
    const db = openControlDb(":memory:")
    const crafted = { status: 200, body: { accepted: true } }
    const reply = await fileRootRoute(
      request("POST", "/file-roots/prepare", crafted),
      { db, fileHelper: helper }
    )
    expect(reply?.status).toBe(400)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM control_approvals").get()?.[
        "count"
      ]
    ).toBe(0)
    db.close()
  })

  it("requires a signed single-use challenge bound to these roots", async () => {
    const db = openControlDb(":memory:")
    const prepared = await prepareFileRoots(db, helper, REQUEST)
    const auth = controlAuthorization(db, prepared)
    const otherTarget = prepareControlApproval(
      db,
      "policy.set",
      "permissions",
      ROOTS
    )
    const crossTargetAuth = controlAuthorization(db, otherTarget)
    const complete = (roots: unknown, authorization: unknown) =>
      fileRootRoute(
        request("POST", "/file-roots/complete", { roots, authorization }),
        { db, webAuthn: WEBAUTHN, fileHelper: helper }
      )
    expect((await complete(ROOTS, {}))?.status).toBe(409)
    const wrong = { ...ROOTS, roots: [{ id: "other", root: ROOT }] }
    expect((await complete(wrong, auth.request))?.status).toBe(409)
    expect((await complete(ROOTS, crossTargetAuth.request))?.status).toBe(409)
    expect(approvedFileRoot(db, "docs")).toBeUndefined()

    // The rejected attempts do not consume the challenge. A valid authorization stores it once.
    expect((await complete(ROOTS, auth.request))?.status).toBe(200)
    expect(approvedFileRoot(db, "docs")).toEqual(ROOT)
    expect((await complete(ROOTS, auth.request))?.status).toBe(409)
    db.close()
  })
  it.each([
    ["moved to another canonical path", { canonicalPath: "/srv/safe/other" }],
    ["replaced by another directory (dev)", { dev: "9" }],
    ["replaced by another directory (ino)", { ino: "20" }],
  ])(
    "refuses a root %s since prepare, naming it, and stores nothing",
    async (_name, changed) => {
      const db = openControlDb(":memory:")
      const prepared = await prepareFileRoots(db, helper, REQUEST)
      const auth = controlAuthorization(db, prepared)
      const reply = await fileRootRoute(
        request("POST", "/file-roots/complete", {
          roots: ROOTS,
          authorization: auth.request,
        }),
        {
          db,
          webAuthn: WEBAUTHN,
          fileHelper: async () => ({ ...(await helper()), ...changed }),
        }
      )
      expect(reply).toEqual({
        status: 409,
        body: {
          code: "root_changed",
          rootId: "docs",
          message: "this folder changed on the host since it was prepared",
        },
      })
      expect(validateGateApiError(reply?.body).ok).toBe(true)
      expect(approvedFileRoot(db, "docs")).toBeUndefined()
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM control_approvals WHERE used_at IS NOT NULL"
          )
          .get()?.["n"]
      ).toBe(0)
      db.close()
    }
  )

  it("re-identifies every root at complete and names the one gone since prepare", async () => {
    const db = openControlDb(":memory:")
    const second: GateFileRoot = { ...ROOT, path: "/srv/safe/scans", ino: "1a" }
    const both: GateFileRoots = {
      roots: [
        { id: "docs", root: ROOT },
        { id: "scans", root: second },
      ],
    }
    const identify: FileHelper = (asked) => {
      const found = both.roots.find(
        (r) => asked.op === "identify" && r.root.path === asked.path
      )?.root
      return Promise.resolve(
        found === undefined
          ? { ok: false, code: "not_found", message: "no such directory" }
          : {
              ok: true,
              op: "identify",
              canonicalPath: found.path,
              dev: found.dev,
              ino: found.ino,
            }
      )
    }
    const prepared = await prepareFileRoots(db, identify, {
      roots: both.roots.map(({ id, root }) => ({
        id,
        path: root.path,
        trashDir: root.trashDir,
      })),
    })
    const asked: string[] = []
    const scansGone: FileHelper = (req) => {
      if (req.op === "identify") asked.push(req.path)
      return req.op === "identify" && req.path === second.path
        ? Promise.resolve({
            ok: false,
            code: "not_found",
            message: "no such directory",
          })
        : identify(req)
    }
    const reply = await fileRootRoute(
      request("POST", "/file-roots/complete", {
        roots: both,
        authorization: controlAuthorization(db, prepared).request,
      }),
      { db, webAuthn: WEBAUTHN, fileHelper: scansGone }
    )
    expect(asked).toEqual([ROOT.path, second.path])
    expect([reply?.status, reply?.body]).toMatchObject([
      409,
      { code: "root_changed", rootId: "scans" },
    ])
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    db.close()
  })

  it("stores nothing when the helper fails or is missing at complete", async () => {
    const db = openControlDb(":memory:")
    const prepared = await prepareFileRoots(db, helper, REQUEST)
    const auth = controlAuthorization(db, prepared)
    const complete = (fileHelper?: FileHelper) =>
      fileRootRoute(
        request("POST", "/file-roots/complete", {
          roots: ROOTS,
          authorization: auth.request,
        }),
        fileHelper === undefined
          ? { db, webAuthn: WEBAUTHN }
          : { db, webAuthn: WEBAUTHN, fileHelper }
      )
    const failed = await complete(() =>
      Promise.reject(new Error("file helper failed"))
    )
    expect([failed?.status, failed?.body]).toEqual([
      503,
      {
        code: "unavailable",
        message: "the file helper could not identify the folders again",
      },
    ])
    const wrongOp = await complete(() =>
      Promise.resolve({ ok: true, op: "create" })
    )
    expect(wrongOp?.status).toBe(503)
    const missing = await complete()
    expect([missing?.status, missing?.body]).toEqual([
      503,
      { code: "unavailable", message: "the file helper is unavailable" },
    ])
    expect(approvedFileRoot(db, "docs")).toBeUndefined()
    // None of the refusals consumed the challenge: the unchanged roots still store once.
    expect((await complete(helper))?.status).toBe(200)
    expect(approvedFileRoot(db, "docs")).toEqual(ROOT)
    db.close()
  })

  it("refuses malformed or oversized bodies before any ceremony", async () => {
    const db = openControlDb(":memory:")
    const body = (text: string): GateRequest => ({
      ...request("POST", "/file-roots/prepare"),
      body: () => Promise.resolve({ ok: true, text }),
    })
    const oversize: GateRequest = {
      ...request("POST", "/file-roots/prepare"),
      body: () => Promise.resolve({ ok: false }),
    }
    const state = { db, fileHelper: helper }
    expect((await fileRootRoute(body("{not json"), state))?.status).toBe(400)
    expect((await fileRootRoute(oversize, state))?.status).toBe(413)
    const oversizeComplete: GateRequest = {
      ...request("POST", "/file-roots/complete"),
      body: () => Promise.resolve({ ok: false }),
    }
    expect((await fileRootRoute(oversizeComplete, state))?.status).toBe(413)
    db.close()
  })

  it("reports an unavailable helper or WebAuthn as 503 and ignores other routes", async () => {
    const db = openControlDb(":memory:")
    expect(
      (
        await fileRootRoute(request("POST", "/file-roots/prepare", REQUEST), {
          db,
        })
      )?.status
    ).toBe(503)
    const complete = { roots: ROOTS, authorization: {} }
    expect(
      (
        await fileRootRoute(request("POST", "/file-roots/complete", complete), {
          db,
        })
      )?.status
    ).toBe(503)
    expect(
      await fileRootRoute(request("GET", "/file-roots/prepare"), { db })
    ).toBeUndefined()
    db.close()
  })

  it("rejects a completion without roots, authorization or valid roots", async () => {
    const db = openControlDb(":memory:")
    const post = (value: unknown) =>
      fileRootRoute(request("POST", "/file-roots/complete", value), {
        db,
        webAuthn: WEBAUTHN,
        fileHelper: helper,
      })
    expect((await post("text"))?.status).toBe(400)
    expect((await post({ roots: ROOTS }))?.status).toBe(400)
    expect(
      (await post({ roots: { roots: "x" }, authorization: {} }))?.status
    ).toBe(400)
    db.close()
  })
})
