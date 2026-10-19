import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request } from "node:http"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { payloadHash } from "./canonical"
import {
  GateRequestError,
  GateUnavailableError,
  createIntentClient,
} from "./client"
import type { IntentClient } from "./client"
import { close, createGateServer, listen, MAX_BODY_BYTES } from "./http"
import type { Handler } from "./http"
import { intentHistory, pendingIntents } from "./intents"
import { controlHandler, dataPlaneHandler } from "./routes"
import { runningGate, startGate, stopGate } from "./runtime"
import {
  BODY_MARKER,
  WEBAUTHN,
  auditRows,
  sample,
  setup,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

// The gate's listeners over real local sockets, in this process: routes, refusals, audit rows
// and field exclusions. The two-process tests are in packages/core/src/planes.

type Raw = { status: number; text: string }

function raw(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const headers =
      body === undefined ? {} : { "content-length": Buffer.byteLength(body) }
    const req = request({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        })
      )
    })
    req.on("error", reject)
    req.end(body)
  })
}

/** Every row of every table, so a test can show that nothing changed. */
function dump(db: DatabaseSync): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
    .all()
    .map((row) => String(row["name"]))
  return JSON.stringify(
    tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()])
  )
}

const silent = () => undefined

let dir: string
let s: Setup
let dataSocket: string
let controlSocket: string
let servers: Server[]
let client: IntentClient

async function serve(handler: Handler, path: string): Promise<Server> {
  const server = createGateServer("test", handler, silent)
  servers.push(server)
  await listen(server, path, 0o600)
  return server
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "eido-api-"))
  dataSocket = join(dir, "gate.sock")
  controlSocket = join(dir, "control.sock")
  servers = []
  s = setup()
  startGate(s.db, s.options, WEBAUTHN)
  baseline = auditRows(s.db).length
  await serve(dataPlaneHandler(runningGate), dataSocket)
  await serve(controlHandler(runningGate), controlSocket)
  client = createIntentClient({ socketPath: dataSocket })
})

afterEach(async () => {
  await Promise.all(servers.filter((x) => x.listening).map(close))
  stopGate()
  s.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

const send = sample("email.send")
const proposal = {
  intent: send,
  origin: "proactive" as const,
  taskId: "task-1",
  sources: { contextPackId: "pack-1", documentIds: ["doc-1", "doc-2"] },
}

let baseline = 0

/** Audit actions appended since the gate started, oldest first. */
function actions(): string[] {
  return auditRows(s.db)
    .slice(baseline)
    .map((row) => row.action)
}

describe("POST /intents", () => {
  it("stores an approval-tier intent as pending and audits one proposal row with its sources", async () => {
    const result = await client.propose(proposal)
    expect(result).toEqual({
      id: expect.any(String) as unknown,
      tier: "approval",
      state: "pending",
    })
    const proposed = auditRows(s.db).filter(
      (row) => row.action === "intent.proposed" && row.target === result.id
    )
    expect(proposed.map((row) => row.detail_hash)).toEqual([
      payloadHash({
        from: null,
        to: "proposed",
        reason: null,
        payload_hash: payloadHash(send),
        origin: "proactive",
        context_pack_id: "pack-1",
        document_ids: ["doc-1", "doc-2"],
      }),
    ])
    expect(
      s.db.prepare("SELECT task_id FROM intents WHERE id = ?").get(result.id)
    ).toEqual({ task_id: "task-1" })
  })

  it("lands an auto-tier intent in approved", async () => {
    const result = await client.propose({
      intent: sample("email.archive"),
      origin: "reactive",
    })
    expect(result).toMatchObject({ tier: "auto", state: "approved" })
    expect(await client.status(result.id)).toMatchObject({ state: "approved" })
  })

  it("resolves a forbidden proposal as rejected, with its reason, and audits it", async () => {
    const result = await client.propose({
      intent: sample("file.delete", { root: "secrets" }),
      origin: "reactive",
    })
    expect(result).toEqual({
      id: expect.any(String) as unknown,
      tier: "forbidden",
      state: "rejected",
      reason: "root_not_allowed",
    })
    expect(
      intentHistory(s.db, result.id).map((entry) => [entry.to, entry.reason])
    ).toEqual([
      ["proposed", undefined],
      ["rejected", "root_not_allowed"],
    ])
  })

  it("refuses a schema-invalid intent with 422 and its field paths, and audits it", async () => {
    const before = actions().length
    const refused = client.propose({
      intent: {
        kind: "email.send",
        args: { to: ["a@example.com"], subject: "x" },
      },
      origin: "reactive",
    })
    await expect(refused).rejects.toMatchObject({
      name: "GateRequestError",
      status: 422,
      code: "invalid_payload",
      errors: ["$.args.body: required"],
    })
    expect(actions().slice(before)).toEqual(["intent.invalid"])
  })

  it("refuses a body that is not a proposal, such as one carrying its own hash, with 400", async () => {
    const reply = await raw(
      dataSocket,
      "POST",
      "/intents",
      JSON.stringify({ ...proposal, payloadHash: "0".repeat(64) })
    )
    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.text)).toEqual({
      code: "invalid_request",
      message: "the body is not an intent proposal: $.payloadHash: unknown key",
    })
    expect(actions()).toEqual(["intent.request_refused.invalid_request"])
  })

  it("refuses malformed JSON with 400 without echoing the body, audits it and keeps serving", async () => {
    const reply = await raw(dataSocket, "POST", "/intents", `{"${BODY_MARKER}"`)
    expect(reply.status).toBe(400)
    expect(reply.text).not.toContain(BODY_MARKER)
    expect(actions()).toEqual(["intent.request_refused.malformed_json"])
    expect(await client.listPending()).toEqual([])
  })

  it("refuses a body over 1 MiB with 413, audits it and keeps serving", async () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 1, "a")
    const reply = await raw(dataSocket, "POST", "/intents", big)
    expect(reply.status).toBe(413)
    expect(actions()).toEqual(["intent.request_refused.too_large"])
    expect(await client.propose(proposal)).toMatchObject({ state: "pending" })
  })

  it("accepts a body of exactly 1 MiB as far as the size check goes", async () => {
    const padded = JSON.stringify(proposal).padEnd(MAX_BODY_BYTES, " ")
    const reply = await raw(dataSocket, "POST", "/intents", padded)
    expect(reply.status).toBe(201)
  })
})

describe("the read routes", () => {
  it("return the same data as the gate's own functions", async () => {
    const pending = await client.propose(proposal)
    await client.propose({
      intent: sample("email.archive"),
      origin: "reactive",
    })
    expect(await client.listPending()).toEqual(pendingIntents(s.db))
    expect((await client.listPending()).map((p) => p.id)).toEqual([pending.id])
    expect(await client.history(pending.id)).toEqual(
      intentHistory(s.db, pending.id)
    )
    expect((await client.history(pending.id)).map((e) => e.to)).toEqual([
      "proposed",
      "pending",
    ])
    expect(await client.status(pending.id)).toEqual({
      id: pending.id,
      kind: "email.send",
      tier: "approval",
      state: "pending",
      edited_from: null,
    })
  })

  it("show edited_from for an edited intent", async () => {
    const original = await client.propose(proposal)
    const edited = await client.propose(proposal)
    s.db
      .prepare("UPDATE intents SET edited_from = ? WHERE id = ?")
      .run(original.id, edited.id)
    expect((await client.status(edited.id)).edited_from).toBe(original.id)
  })

  it("answer 404 for an unknown intent", async () => {
    await expect(client.status("nope")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
    await expect(client.history("nope")).rejects.toBeInstanceOf(
      GateRequestError
    )
  })

  it("carry no payload body, signature or nonce", async () => {
    const { id } = await client.propose(proposal)
    const texts = await Promise.all(
      [
        `/intents/${id}`,
        `/intents/${id}/history`,
        "/intents?state=pending",
      ].map(async (path) => (await raw(dataSocket, "GET", path)).text)
    )
    for (const text of texts) {
      for (const field of ["payload_json", "signature", "nonce", BODY_MARKER]) {
        expect(text).not.toContain(field)
      }
    }
  })
})

describe("everything else on the data-plane listener", () => {
  it("answers 404 and leaves the control database unchanged", async () => {
    const { id } = await client.propose(proposal)
    const before = dump(s.db)
    const requests: [string, string][] = [
      ["POST", "/approvals"],
      ["GET", "/audit"],
      ["GET", "/audit/chain"],
      ["PUT", `/intents/${id}`],
      ["DELETE", `/intents/${id}`],
      ["POST", `/intents/${id}`],
      ["GET", "/intents"],
      ["GET", "/intents?state=approved"],
      ["GET", "/intents?state=pending&limit=1"],
      ["GET", `/intents/${id}/payload`],
      ["GET", "/"],
    ]
    for (const [method, path] of requests) {
      const reply = await raw(
        dataSocket,
        method,
        path,
        method === "GET" ? undefined : "{}"
      )
      expect([method, path, reply.status]).toEqual([method, path, 404])
    }
    expect(dump(s.db)).toBe(before)
  })
})

describe("the control listener", () => {
  it("checks the audit chain, which the data-plane listener does not serve", async () => {
    await client.propose(proposal)
    const reply = await raw(controlSocket, "GET", "/audit/chain")
    expect(JSON.parse(reply.text)).toEqual({
      ok: true,
      rows: auditRows(s.db).length,
    })
    const pending = await raw(controlSocket, "GET", "/intents?state=pending")
    expect(pending.status).toBe(200)
    expect((await raw(controlSocket, "POST", "/intents", "{}")).status).toBe(
      404
    )
  })
})

describe("the server wrapper", () => {
  it("answers 500 when a handler throws and keeps serving", async () => {
    const path = join(dir, "broken.sock")
    let calls = 0
    await serve(() => {
      calls++
      if (calls === 1) throw new Error(BODY_MARKER)
      return { status: 200, body: { ok: true } }
    }, path)
    const first = await raw(path, "GET", "/")
    expect(first.status).toBe(500)
    expect(first.text).not.toContain(BODY_MARKER)
    expect((await raw(path, "GET", "/")).status).toBe(200)
  })

  it("replaces a stale socket file and applies the socket mode", async () => {
    const path = join(dir, "again.sock")
    const first = await serve(() => ({ status: 200, body: {} }), path)
    first.close()
    first.unref()
    await serve(() => ({ status: 204, body: {} }), path)
    expect((await raw(path, "GET", "/")).status).toBe(204)
  })

  it("leaves a path that is not a socket alone", async () => {
    const path = join(dir, "file.sock")
    writeFileSync(path, "")
    const server = createGateServer("test", () => NOT_A_REPLY, silent)
    await expect(listen(server, path, 0o600)).rejects.toThrow()
  })

  it("does not unlink on Windows, where sockets are named pipes", async () => {
    const path = join(dir, "pipe.sock")
    const first = await serve(() => ({ status: 200, body: {} }), path)
    expect(first.listening).toBe(true)
    const second = createGateServer("test", () => NOT_A_REPLY, silent)
    await expect(listen(second, path, 0o600, "win32")).rejects.toThrow(
      "EADDRINUSE"
    )
  })

  it("passes through an error other than a missing file", async () => {
    writeFileSync(join(dir, "plain"), "")
    const server = createGateServer("test", () => NOT_A_REPLY, silent)
    await expect(
      listen(server, join(dir, "plain", "x.sock"), 0o600)
    ).rejects.toThrow("ENOTDIR")
  })
})

const NOT_A_REPLY = { status: 200, body: {} }

describe("the client", () => {
  it("rejects every call with GateUnavailableError when no gate listens, within 2 s", async () => {
    const offline = createIntentClient({ socketPath: join(dir, "none.sock") })
    const started = Date.now()
    const calls = [
      offline.propose(proposal),
      offline.status("i-1"),
      offline.history("i-1"),
      offline.listPending(),
    ]
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(GateUnavailableError)
    }
    expect(Date.now() - started).toBeLessThan(2000)
    expect(actions()).toEqual([])
  })

  it("gives up on a gate that does not answer", async () => {
    const path = join(dir, "hung.sock")
    const hung = createServer(() => undefined)
    servers.push(hung)
    await listen(hung, path, 0o600)
    const slow = createIntentClient({ socketPath: path, timeoutMs: 100 })
    await expect(slow.listPending()).rejects.toThrow(
      "the gate is not reachable"
    )
    hung.closeAllConnections()
  })

  async function answering(
    status: number,
    body: string
  ): Promise<IntentClient> {
    const path = join(dir, `answer-${status}.sock`)
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(body)
    })
    servers.push(server)
    await listen(server, path, 0o600)
    return createIntentClient({ socketPath: path })
  }

  it("refuses a success body outside the contract", async () => {
    const odd = await answering(200, JSON.stringify({ intents: [{ id: 1 }] }))
    await expect(odd.listPending()).rejects.toMatchObject({
      code: "bad_response",
      message: "the gate's response is not a GatePendingIntentList",
    })
  })

  it("refuses an error body outside the contract and a body that is not JSON", async () => {
    const odd = await answering(500, "oops")
    await expect(odd.status("i-1")).rejects.toMatchObject({
      status: 500,
      code: "bad_response",
    })
  })

  it("refuses a 422 that is not a proposal refusal", async () => {
    const odd = await answering(422, JSON.stringify({ code: "x" }))
    await expect(odd.propose(proposal)).rejects.toMatchObject({
      code: "bad_response",
      message: "the gate's response is not a GateProposeRefusal",
    })
  })
})
