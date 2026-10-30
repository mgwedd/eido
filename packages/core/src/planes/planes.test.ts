import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ingestBatch } from "../index/ingest"
import { insertObligation } from "../ledger/store"
import { DATA_PLANE_ENV, OS_ADDED_ENV } from "../main"
import { spawnPlanes } from "./spawn-planes"
import type { Planes } from "./spawn-planes"

// Two real processes (the gate and the data plane) on temp databases and sockets. The data
// plane's side of each call runs in a data-plane process (probe.ts), so the process boundary is
// what is tested.

const SEND = {
  intent: {
    kind: "email.send",
    args: {
      to: ["someone@example.invalid"],
      subject: "Lorem ipsum",
      body: "Lorem ipsum dolor sit amet",
    },
  },
  origin: "reactive",
}

// Synthetic values a parent might hold; none may reach the data plane.
const POLLUTED = {
  GMAIL_REFRESH_TOKEN: "synthetic-refresh",
  EIDO_KEYCHAIN_SECRET: "synthetic-secret",
  OPENAI_API_KEY: "synthetic-key",
  EIDO_VAULT_PASSWORD: "synthetic-password",
  EIDO_GATE_DATA_DIR: "/elsewhere/gate",
  EIDO_GATE_CONTROL_SOCKET: "/elsewhere/gate/eido-control.sock",
  EIDO_CONTROL_DB: "/elsewhere/gate/eido-control.db",
}

const CREDENTIAL_NAME = /TOKEN|SECRET|KEY|PASSWORD|REFRESH/

// Synthetic profile values that must never reach the gate in clear.
const CLEAR = {
  name: "Lorem Holdings",
  renamed: "Ipsum Holdings",
  tag: "LOREMTAG",
  connector: "mailconnector",
  accountRef: "box@example.invalid",
}

/** Hex SHA-256 of the JSON of `value`: the hash the audit entry carries (#181). */
const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** GET /audit/chain on the gate's control listener. */
function auditChain(): Promise<{ ok: boolean; rows: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: planes.paths.controlSocket, path: "/audit/chain" },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
          resolve({
            ok: field(body, "ok") === true,
            rows: Number(field(body, "rows")),
          })
        })
      }
    )
    req.on("error", reject)
    req.end()
  })
}

let tmp: string
let planes: Planes

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "eido-planes-"))
  planes = await spawnPlanes({ tmpDir: tmp, parentEnv: POLLUTED })
}, 30_000)

afterAll(async () => {
  await planes.close()
  rmSync(tmp, { recursive: true, force: true })
}, 30_000)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The value of a settled probe call that succeeded. */
function settledValue(result: unknown): unknown {
  if (!isRecord(result) || result["ok"] !== true) {
    throw new Error(`the probe call failed: ${JSON.stringify(result)}`)
  }
  return result["value"]
}

function field(value: unknown, name: string): unknown {
  if (!isRecord(value))
    throw new Error(`not an object: ${JSON.stringify(value)}`)
  return value[name]
}

function auditActions(
  view: unknown
): Array<{ action: unknown; target: unknown }> {
  const audit = field(view, "audit")
  if (!Array.isArray(audit)) throw new Error("no audit rows")
  return audit.map((row: unknown) => ({
    action: field(row, "action"),
    target: field(row, "target"),
  }))
}

function rowCounts(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all()
      .map((row) => String(row["name"]))
    return Object.fromEntries(
      tables.map((name) => [
        name,
        Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get()?.["n"]),
      ])
    )
  } finally {
    db.close()
  }
}

function loggedEnvNames(logPath: string): string[] {
  const started = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
    .find((entry) => field(entry, "event") === "started")
  const env = field(started, "env")
  if (typeof env !== "string") throw new Error("no env names in the start line")
  return env.split(",")
}

describe(
  "the gate and the data plane as two processes",
  { timeout: 30_000 },
  () => {
    let id = ""

    it("proposes through the client and sees the gate's later state change", async () => {
      const proposed = settledValue(
        await planes.probe("propose", JSON.stringify(SEND))
      )
      expect(proposed).toMatchObject({ tier: "approval", state: "pending" })
      const proposedId = field(proposed, "id")
      expect(typeof proposedId).toBe("string")
      id = String(proposedId)

      expect(settledValue(await planes.probe("status", id))).toEqual({
        id,
        kind: "email.send",
        tier: "approval",
        state: "pending",
        edited_from: null,
      })
      expect(settledValue(await planes.probe("pending"))).toMatchObject([
        { id, kind: "email.send", tier: "approval" },
      ])

      await planes.rejectInGate(id)
      expect(settledValue(await planes.probe("status", id))).toMatchObject({
        id,
        state: "rejected",
      })
      expect(settledValue(await planes.probe("history", id))).toMatchObject([
        { from: null, to: "proposed" },
        { from: "proposed", to: "pending" },
        { from: "pending", to: "rejected", actor: "approver" },
      ])

      const proposedRows = auditActions(await planes.inspectControlDb()).filter(
        (row) => row.action === "intent.proposed" && row.target === id
      )
      expect(proposedRows).toHaveLength(1)
    })

    it("gives the data plane only its allowlisted variables and no control DB path", async () => {
      const view = await planes.probe("env")
      const names = field(view, "env")
      if (!Array.isArray(names)) throw new Error("no env names")
      const allowed: readonly string[] = [...DATA_PLANE_ENV, ...OS_ADDED_ENV]
      expect(names.filter((name) => !allowed.includes(String(name)))).toEqual(
        []
      )
      expect(
        names.filter((name) => CREDENTIAL_NAME.test(String(name)))
      ).toEqual([])
      const config = JSON.stringify(field(view, "config"))
      expect(config).not.toContain("eido-control")
      expect(config).not.toContain(`${planes.paths.gateDir}${sep}`)
      expect(config).not.toContain(planes.paths.controlSocket)
    })

    it("re-runs the long-lived data plane without the variables its parent held", () => {
      expect(Object.keys(planes.dataPlaneStartEnv)).toEqual(
        expect.arrayContaining(Object.keys(POLLUTED))
      )
      const names = loggedEnvNames(planes.paths.dataPlaneLog)
      expect(names).toContain("EIDO_GATE_SOCKET")
      expect(names.filter((name) => name in POLLUTED)).toEqual([])
      expect(names.filter((name) => CREDENTIAL_NAME.test(name))).toEqual([])
      expect(readFileSync(planes.paths.dataPlaneLog, "utf8")).not.toContain(
        "eido-control"
      )
    })

    it("audits every profile change in the gate's chain, as hashes only", async () => {
      const before = await auditChain()
      const write = async (
        method: string,
        path: string,
        body?: unknown
      ): Promise<unknown> => {
        const response = await fetch(`${planes.coreUrl}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        })
        expect([method, path, response.status]).toEqual([
          method,
          path,
          method === "POST" ? 201 : method === "DELETE" ? 204 : 200,
        ])
        return response.status === 204 ? null : response.json()
      }
      const entity = await write("POST", "/entities", {
        kind: "company",
        name: CLEAR.name,
        tag: CLEAR.tag,
      })
      const entityId = String(field(entity, "id"))
      await write("PATCH", `/entities/${entityId}`, { name: CLEAR.renamed })
      await write("PUT", "/entity-assignments", {
        connector: CLEAR.connector,
        accountRef: CLEAR.accountRef,
        entityId,
      })
      await write(
        "DELETE",
        `/entity-assignments?connector=${CLEAR.connector}&accountRef=${encodeURIComponent(CLEAR.accountRef)}`
      )
      await write("DELETE", `/entities/${entityId}`)

      expect(await auditChain()).toEqual({ ok: true, rows: before.rows + 5 })
      const control = await planes.inspectControlDb()
      const account = hashOf([CLEAR.connector, CLEAR.accountRef])
      expect(
        auditActions(control).filter((row) =>
          String(row.action).startsWith("audit.profile.")
        )
      ).toEqual([
        { action: "audit.profile.entity.create", target: hashOf(entityId) },
        { action: "audit.profile.entity.update", target: hashOf(entityId) },
        { action: "audit.profile.account.assign", target: account },
        { action: "audit.profile.account.unassign", target: account },
        { action: "audit.profile.entity.delete", target: hashOf(entityId) },
      ])
      const stored = JSON.stringify(control)
      for (const clear of [...Object.values(CLEAR), entityId]) {
        expect(stored).not.toContain(clear)
      }
    })

    it("audits a local obligation state change in the gate's chain, as hashes only (#104)", async () => {
      const entity = await fetch(`${planes.coreUrl}/entities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "company",
          name: "Dolor Holdings",
          tag: "DOLORTAG",
        }),
      })
      const entityId = String(field(await entity.json(), "id"))
      const data = new DatabaseSync(planes.paths.dataDb, { timeout: 2000 })
      let obligationId: number
      try {
        const sha256 = hashOf("obligation source")
        ingestBatch(data, {
          connector: "gmail",
          stream: "inbox",
          documents: [
            {
              sha256,
              source: "gmail",
              sourceRef: "ref-obligation",
              mime: "message/rfc822",
              body: "Lorem ipsum",
              entityId,
            },
          ],
          nextCursor: "c-obligation",
        })
        obligationId = insertObligation(data, {
          entityId,
          action: "Lorem ipsum action",
          status: "open",
          docId: sha256,
          span: { start: 0, end: 5 },
        })
      } finally {
        data.close()
      }
      const before = await auditChain()
      for (const [change, status] of [
        ["done", "done"],
        ["reopen", "open"],
        ["resolve", "done"],
      ]) {
        const response = await fetch(
          `${planes.coreUrl}/obligations/${String(obligationId)}/${change}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }
        )
        expect([change, response.status]).toEqual([change, 200])
        expect(await response.json()).toEqual({ id: obligationId, status })
      }
      expect(await auditChain()).toEqual({ ok: true, rows: before.rows + 3 })
      const control = await planes.inspectControlDb()
      const subject = hashOf(`obl:${String(obligationId)}`)
      expect(
        auditActions(control).filter((row) =>
          String(row.action).startsWith("audit.ledger.")
        )
      ).toEqual([
        { action: "audit.ledger.obligation.done", target: subject },
        { action: "audit.ledger.obligation.reopen", target: subject },
        { action: "audit.ledger.obligation.resolve", target: subject },
      ])
      expect(JSON.stringify(control)).not.toContain("Lorem ipsum action")
    })

    // Last: it stops the gate.
    it("rejects every call within 2 s with GateUnavailableError once the gate is stopped", async () => {
      const entitiesBefore: unknown = await (
        await fetch(`${planes.coreUrl}/entities`)
      ).json()
      await planes.stopGate()
      const controlBefore = await planes.inspectControlDb()
      const dataBefore = rowCounts(planes.paths.dataDb)

      const result = await planes.probe("offline", id)
      for (const call of ["propose", "status", "history", "listPending"]) {
        const settled = field(result, call)
        expect(settled, call).toMatchObject({
          ok: false,
          error: { name: "GateUnavailableError" },
        })
        expect(Number(field(settled, "ms")), call).toBeLessThan(2000)
      }

      const started = performance.now()
      const refused = await fetch(`${planes.coreUrl}/entities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "personal", name: CLEAR.name, tag: "X" }),
      })
      expect(refused.status).toBe(503)
      expect(await refused.json()).toEqual({
        error: { code: "gate_unavailable", message: "gate unavailable" },
      })
      expect(performance.now() - started).toBeLessThan(2500)
      const listed = await fetch(`${planes.coreUrl}/entities`)
      expect(await listed.json()).toEqual(entitiesBefore)

      expect(await planes.inspectControlDb()).toEqual(controlBefore)
      expect(rowCounts(planes.paths.dataDb)).toEqual(dataBefore)
    })
  }
)

const CORE_SRC = fileURLToPath(new URL("..", import.meta.url))

// The harness is the one core file that names the gate's control DB and control socket: it
// starts the gate. It runs only in tests and never in the data plane.
const HARNESS = "planes/spawn-planes.ts"

const CONTROL_DB_ACCESS = [
  "eido-control.db",
  "openControlDb",
  "EIDO_GATE_CONTROL_SOCKET",
  "EIDO_GATE_DATA_DIR",
  "@eido/gate/",
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : []
  })
}

describe("the data-plane source tree", () => {
  it("has no handle to, or path for, the gate's control DB", () => {
    const hits = sourceFiles(CORE_SRC)
      .filter((path) => relative(CORE_SRC, path) !== HARNESS)
      .flatMap((path) => {
        const text = readFileSync(path, "utf8")
        return CONTROL_DB_ACCESS.filter((needle) => text.includes(needle)).map(
          (needle) => `${relative(CORE_SRC, path)}: ${needle}`
        )
      })
    expect(hits).toEqual([])
  })
})
