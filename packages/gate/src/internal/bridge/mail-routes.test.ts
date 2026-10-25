import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import type { GateRequest, Reply } from "../http"
import { dataPlaneHandler } from "../routes"
import { auditRows, MAIL_OPS, manifest, setup } from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import { BridgeError } from "./errors"
import type { MailReads } from "./mail-routes"
import { PROTON_CONNECTOR } from "./config"

// The mail read routes through the data-plane handler, with a stub in place of Bridge. The
// adapter itself is tested against the fake Bridge in bridge.test.ts.

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

type Call = { read: string; args: unknown[] }

function stub(overrides: Partial<MailReads> = {}): {
  mail: MailReads
  calls: Call[]
} {
  const calls: Call[] = []
  const mail: MailReads = {
    listFolders: (...args) => {
      calls.push({ read: "folders", args })
      return (
        overrides.listFolders?.(...args) ?? Promise.resolve(["INBOX", "Sent"])
      )
    },
    folderState: (...args) => {
      calls.push({ read: "state", args })
      return (
        overrides.folderState?.(...args) ??
        Promise.resolve(
          args[0] === "INBOX"
            ? { uidValidity: "1700000001", uidNext: 8 }
            : undefined
        )
      )
    },
    fetchRaw: (...args) => {
      calls.push({ read: "messages", args })
      return (
        overrides.fetchRaw?.(...args) ??
        Promise.resolve(
          args[0] === "INBOX"
            ? {
                messages: [{ uid: 7, raw: Buffer.from("lorem") }],
                skipped: [9],
              }
            : undefined
        )
      )
    },
  }
  return { mail, calls }
}

function get(path: string, query = ""): GateRequest {
  return {
    method: "GET",
    path,
    query: new URLSearchParams(query),
    headers: {},
    body: () => Promise.reject(new Error("a GET has no body")),
  }
}

async function call(
  request: GateRequest,
  mail: MailReads | undefined
): Promise<Reply> {
  s = setup([manifest(PROTON_CONNECTOR, MAIL_OPS)])
  const state = { db: s.db, policy: s.policy }
  return dataPlaneHandler(() => state, mail)(request)
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function lastAudit(): { action: string; target: string; detail_hash: string } {
  const row = auditRows(s?.db ?? failSetup())
    .filter((entry) => entry.action.startsWith("mail."))
    .at(-1)
  if (row === undefined) throw new Error("no audit row")
  return {
    action: row.action,
    target: row.target,
    detail_hash: row.detail_hash,
  }
}

function failSetup(): never {
  throw new Error("no setup")
}

describe("GET /mail/proton/folders", () => {
  it("lists the folders and audits the count only", async () => {
    const { mail } = stub()
    const reply = await call(get("/mail/proton/folders"), mail)
    expect(reply).toEqual({ status: 200, body: { folders: ["INBOX", "Sent"] } })
    expect(lastAudit()).toEqual({
      action: "mail.read.folders",
      target: "proton-mail",
      detail_hash: sha256('{"folders":2}'),
    })
  })

  it("caps the listing at 1000 folders", async () => {
    const many = Array.from({ length: 1001 }, (_, index) => `F${index}`)
    const { mail } = stub({ listFolders: () => Promise.resolve(many) })
    const reply = await call(get("/mail/proton/folders"), mail)
    expect(reply.body).toEqual({ folders: many.slice(0, 1000) })
  })

  it("is not served when Bridge is not configured", async () => {
    const reply = await call(get("/mail/proton/folders"), undefined)
    expect(reply.status).toBe(404)
    const actions = auditRows(s?.db ?? failSetup()).map((row) => row.action)
    expect(actions.filter((action) => action.startsWith("mail."))).toEqual([])
  })

  it("is not served for another method", async () => {
    const { mail, calls } = stub()
    const reply = await call(
      { ...get("/mail/proton/folders"), method: "POST" },
      mail
    )
    expect(reply.status).toBe(404)
    expect(calls).toEqual([])
  })
})

describe("GET /mail/proton/folders/:folder/state", () => {
  it("returns the folder's UIDVALIDITY and UIDNEXT, decoding the name", async () => {
    const { mail, calls } = stub({
      folderState: (folder) =>
        Promise.resolve(
          folder === "Folders/Work"
            ? { uidValidity: "5", uidNext: 2 }
            : undefined
        ),
    })
    const reply = await call(
      get("/mail/proton/folders/Folders%2FWork/state"),
      mail
    )
    expect(reply).toEqual({
      status: 200,
      body: { uidValidity: "5", uidNext: 2 },
    })
    expect(calls).toEqual([{ read: "state", args: ["Folders/Work"] }])
    expect(lastAudit()).toMatchObject({
      action: "mail.read.state",
      detail_hash: sha256('{"folders":1}'),
    })
  })

  it("returns 404 for an unknown folder", async () => {
    const { mail } = stub()
    const reply = await call(get("/mail/proton/folders/Nope/state"), mail)
    expect(reply).toEqual({
      status: 404,
      body: { code: "not_found", message: "no such folder" },
    })
    expect(lastAudit()).toMatchObject({ action: "mail.read.state.not_found" })
  })

  it("refuses a name that is not valid percent-encoding without calling Bridge", async () => {
    const { mail, calls } = stub()
    const reply = await call(get("/mail/proton/folders/%E0%A4/state"), mail)
    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ code: "invalid_request" })
    expect(calls).toEqual([])
    expect(lastAudit()).toMatchObject({ action: "mail.read.state.refused" })
  })
})

describe("GET /mail/proton/folders/:folder/messages", () => {
  const messages = (query: string) =>
    get("/mail/proton/folders/INBOX/messages", query)

  it("returns raw messages base64 with the skipped UIDs, and audits counts only", async () => {
    const { mail, calls } = stub()
    const reply = await call(messages("fromUid=3"), mail)
    expect(reply).toEqual({
      status: 200,
      body: { messages: [{ uid: 7, raw: "bG9yZW0=" }], skipped: [9] },
    })
    expect(calls).toEqual([{ read: "messages", args: ["INBOX", 3, 50] }])
    expect(lastAudit()).toEqual({
      action: "mail.read.messages",
      target: "proton-mail",
      detail_hash: sha256('{"bytes":5,"messages":1,"skipped":1}'),
    })
  })

  it.each([
    ["1", 1],
    ["100", 100],
    ["101", 100],
    ["9999999999", 100],
  ])("passes limit=%s to Bridge as %i", async (limit, expected) => {
    const { mail, calls } = stub()
    const reply = await call(messages(`fromUid=1&limit=${limit}`), mail)
    expect(reply.status).toBe(200)
    expect(calls[0]?.args).toEqual(["INBOX", 1, expected])
  })

  it.each([
    ["no fromUid", ""],
    ["fromUid 0", "fromUid=0"],
    ["fromUid above 2^32-1", "fromUid=4294967296"],
    ["a fractional fromUid", "fromUid=1.5"],
    ["a negative fromUid", "fromUid=-1"],
    ["limit 0", "fromUid=1&limit=0"],
    ["a non-numeric limit", "fromUid=1&limit=ten"],
  ])("refuses %s with 400 and does not call Bridge", async (_name, query) => {
    const { mail, calls } = stub()
    const reply = await call(messages(query), mail)
    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ code: "invalid_request" })
    expect(calls).toEqual([])
    expect(lastAudit()).toMatchObject({
      action: "mail.read.messages.refused",
      detail_hash: sha256("{}"),
    })
  })

  it("accepts the highest UID", async () => {
    const { mail, calls } = stub()
    await call(messages("fromUid=4294967295"), mail)
    expect(calls[0]?.args).toEqual(["INBOX", 4294967295, 50])
  })

  it("returns 404 for an unknown folder", async () => {
    const { mail } = stub()
    const reply = await call(
      get("/mail/proton/folders/Nope/messages", "fromUid=1"),
      mail
    )
    expect(reply.status).toBe(404)
    expect(lastAudit()).toMatchObject({
      action: "mail.read.messages.not_found",
    })
  })
})

describe("Bridge failures", () => {
  it.each([
    ["handshake_failed", 502],
    ["auth_failed", 502],
  ] as const)("returns %s as %i with that code", async (code, status) => {
    const error = new BridgeError(code, "synthetic")
    const { mail } = stub({ listFolders: () => Promise.reject(error) })
    const reply = await call(get("/mail/proton/folders"), mail)
    expect(reply).toEqual({ status, body: { code, message: "synthetic" } })
    expect(lastAudit()).toMatchObject({
      action: `mail.read.folders.failed.${code}`,
    })
  })

  it("answers a busy refusal as 503 with Retry-After and an audit row", async () => {
    const { mail } = stub({
      fetchRaw: () => Promise.reject(new BridgeError("busy", "synthetic")),
    })
    const reply = await call(
      get("/mail/proton/folders/INBOX/messages", "fromUid=1"),
      mail
    )
    expect(reply).toEqual({
      status: 503,
      body: { code: "busy", message: "the gate is busy reading mail" },
      headers: { "retry-after": "5" },
    })
    expect(lastAudit()).toMatchObject({
      action: "mail.read.messages.failed.busy",
    })
  })

  it("returns any other failure as 500 without the library's message", async () => {
    const { mail } = stub({
      fetchRaw: () =>
        Promise.reject(new Error("server said: secret folder name")),
    })
    const reply = await call(
      get("/mail/proton/folders/INBOX/messages", "fromUid=1"),
      mail
    )
    expect(reply).toEqual({
      status: 500,
      body: { code: "unavailable", message: "Bridge could not answer" },
    })
    expect(lastAudit()).toMatchObject({
      action: "mail.read.messages.failed.bridge_error",
    })
  })

  it("maps a state failure the same way", async () => {
    const { mail } = stub({
      folderState: () =>
        Promise.reject(new BridgeError("auth_failed", "refused")),
    })
    const reply = await call(get("/mail/proton/folders/INBOX/state"), mail)
    expect(reply.status).toBe(502)
    expect(lastAudit()).toMatchObject({
      action: "mail.read.state.failed.auth_failed",
    })
  })
})
