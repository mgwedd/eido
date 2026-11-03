import type { GateFileRoot, GateFileRoots } from "@eido/schemas"
import { describe, expect, it } from "vitest"
import { openControlDb } from "./control-db"
import { prepareControlApproval } from "./control-approvals"
import { fileRootControlRoute } from "./file-root-routes"
import type { GateRequest } from "./http"
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
    const reply = await fileRootControlRoute(
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

  it("refuses a root the helper cannot identify", async () => {
    const db = openControlDb(":memory:")
    const reply = await fileRootControlRoute(
      request("POST", "/file-roots/prepare", REQUEST),
      {
        db,
        fileHelper: () =>
          Promise.resolve({
            ok: false,
            code: "not_found",
            message: "no such directory",
          }),
      }
    )
    expect(reply?.status).toBe(400)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM control_approvals").get()?.[
        "count"
      ]
    ).toBe(0)
    db.close()
  })

  it("treats response-shaped JSON as invalid request data", async () => {
    const db = openControlDb(":memory:")
    const crafted = { status: 200, body: { accepted: true } }
    const reply = await fileRootControlRoute(
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
      fileRootControlRoute(
        request("POST", "/file-roots/complete", { roots, authorization }),
        { db, webAuthn: WEBAUTHN }
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
    expect((await fileRootControlRoute(body("{not json"), state))?.status).toBe(
      400
    )
    expect((await fileRootControlRoute(oversize, state))?.status).toBe(413)
    db.close()
  })

  it("reports an unavailable helper or WebAuthn as 503 and ignores other routes", async () => {
    const db = openControlDb(":memory:")
    expect(
      (
        await fileRootControlRoute(
          request("POST", "/file-roots/prepare", REQUEST),
          { db }
        )
      )?.status
    ).toBe(503)
    const complete = { roots: ROOTS, authorization: {} }
    expect(
      (
        await fileRootControlRoute(
          request("POST", "/file-roots/complete", complete),
          { db }
        )
      )?.status
    ).toBe(503)
    expect(
      await fileRootControlRoute(request("GET", "/file-roots/prepare"), { db })
    ).toBeUndefined()
    db.close()
  })

  it("rejects a completion without roots, authorization or valid roots", async () => {
    const db = openControlDb(":memory:")
    const post = (value: unknown) =>
      fileRootControlRoute(request("POST", "/file-roots/complete", value), {
        db,
        webAuthn: WEBAUTHN,
      })
    expect((await post("text"))?.status).toBe(400)
    expect((await post({ roots: ROOTS }))?.status).toBe(400)
    expect(
      (await post({ roots: { roots: "x" }, authorization: {} }))?.status
    ).toBe(400)
    db.close()
  })
})
