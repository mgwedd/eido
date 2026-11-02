import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { getPinnedManifest } from "./connectors"
import { verifyChain } from "./audit"
import { canonicalize, payloadHash } from "./canonical"
import { openControlDb } from "./control-db"
import { createExecutor } from "./executor"
import type { UpstreamRequest, UpstreamWriter, WriteRequest } from "./executor"
import { intentHistory, intentStatus, propose } from "./intents"
import {
  MAIL_OPS,
  auditRows,
  loggedText,
  manifest,
  signedPin,
  sample,
  setup,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let s: Setup
const cleanups: (() => void)[] = []
afterEach(() => {
  s?.cleanup()
  cleanups.splice(0).forEach((fn) => fn())
})

const label: Intent = {
  kind: "email.label",
  args: { messageIds: ["msg-1"], add: ["work"] },
}
const inverse: Intent = {
  kind: "email.label",
  args: { messageIds: ["msg-1"], remove: ["work"] },
}
const url = "https://mail.example.com/v1/labels"

function fixture() {
  const mail = manifest("mail", MAIL_OPS)
  const labelsOperation = mail.operations.find(
    (operation) => operation.intentKind === "email.label"
  )
  if (labelsOperation === undefined) throw new Error("missing labels operation")
  labelsOperation.routes = [
    { host: "mail.example.com", method: "POST", pathPattern: "/v1/labels" },
  ]
  s = setup([mail])
  const labels = new Set<string>()
  const writer: UpstreamWriter = {
    kind: "email.label",
    connector: "mail",
    buildRequest(intent) {
      if (intent.kind !== "email.label") throw new Error("wrong kind")
      return { method: "POST", url, body: { provider_arguments: intent.args } }
    },
    intentFromRequest(request, connector) {
      if (
        request.url !== url ||
        request.method !== "POST" ||
        request.body === null ||
        typeof request.body !== "object" ||
        !("provider_arguments" in request.body)
      )
        throw new Error("wrong provider route")
      return {
        kind: "email.label",
        ...(connector === undefined ? {} : { connector }),
        args: request.body.provider_arguments,
      }
    },
    inverse: (intent) => ({
      ...inverse,
      ...("connector" in intent ? { connector: intent.connector } : {}),
    }),
  }
  const transport = vi.fn((request: WriteRequest) => {
    const data: unknown = JSON.parse(request.body)
    if (
      data === null ||
      typeof data !== "object" ||
      !("provider_arguments" in data)
    )
      throw new Error("invalid provider request")
    const args = data.provider_arguments
    if (args !== null && typeof args === "object" && "add" in args)
      labels.add("work")
    else labels.delete("work")
    return Promise.resolve({
      upstreamRef: "provider-ref-1",
      result: { labels: [...labels] },
    })
  })
  const proposed = propose(s.db, s.policy, {
    intent: label,
    origin: "reactive",
  })
  if (!proposed.ok) throw new Error(proposed.code)
  return {
    id: proposed.intentId,
    labels,
    writer,
    transport,
    executor: createExecutor(s.db, [writer], transport),
  }
}

function approved(id: string) {
  s.db.prepare("UPDATE intents SET tier='approval' WHERE id=?").run(id)
  s.db.exec(
    "INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES ('credential','synthetic-public-key',0,'now')"
  )
  s.db
    .prepare(
      "INSERT INTO approval_nonces(nonce,intent_id,issued_at,used_at) VALUES ('nonce',?,'then','now')"
    )
    .run(id)
  s.db
    .prepare(
      "INSERT INTO approvals(intent_id,bundle_hash,decision,signature,credential_id,sign_count,nonce,decided_at) SELECT id,payload_hash,'approved','synthetic-signature','credential',0,'nonce','now' FROM intents WHERE id=?"
    )
    .run(id)
}

function dualConnectorFixture() {
  const names = ["gmail", "proton-mail"] as const
  const manifests = names.map((name) => {
    const pinned = manifest(name, MAIL_OPS)
    const operation = pinned.operations.find(
      (op) => op.intentKind === "email.label"
    )
    if (operation === undefined) throw new Error("missing label operation")
    operation.routes = [
      {
        host: `${name}.example.com`,
        method: "POST",
        pathPattern: "/v1/labels",
      },
    ]
    if (name === "proton-mail") {
      operation.reversibility = "irreversible"
      operation.defaultTier = "approval"
    }
    return pinned
  })
  s = setup(manifests)
  const writers: UpstreamWriter[] = names.map((connector) => ({
    kind: "email.label",
    connector,
    buildRequest: (intent) => ({
      method: "POST",
      url: `https://${connector}.example.com/v1/labels`,
      body: intent,
    }),
    intentFromRequest: (request) => request.body,
    inverse: () => null,
  }))
  const transport = vi.fn((request: WriteRequest) =>
    Promise.resolve({ upstreamRef: request.connector, result: {} })
  )
  const executor = createExecutor(s.db, writers, transport)
  const proposeFor = (connector?: string) =>
    propose(s.db, s.policy, {
      intent: connector === undefined ? label : { ...label, connector },
      origin: "task",
    })
  return { executor, transport, proposeFor }
}

describe("executor", () => {
  it("tiers and dispatches the same kind through each selected pinned connector", async () => {
    const f = dualConnectorFixture()
    const gmail = f.proposeFor("gmail")
    const proton = f.proposeFor("proton-mail")
    if (!gmail.ok || !proton.ok) throw new Error("proposal refused")
    expect(gmail.tier).toBe("auto")
    expect(proton.tier).toBe("approval")
    approved(proton.intentId)
    s.db
      .prepare("UPDATE intents SET state='approved' WHERE id=?")
      .run(proton.intentId)
    expect((await f.executor.execute(gmail.intentId)).ok).toBe(true)
    expect((await f.executor.execute(proton.intentId)).ok).toBe(true)
    expect(
      f.transport.mock.calls.map(([request]) => request.connector)
    ).toEqual(["gmail", "proton-mail"])
    expect(f.transport.mock.calls.map(([request]) => request.url)).toEqual([
      "https://gmail.example.com/v1/labels",
      "https://proton-mail.example.com/v1/labels",
    ])
  })

  it("rejects an ambiguous or mismatched selector and never redirects a disabled selection", async () => {
    const f = dualConnectorFixture()
    const ambiguous = f.proposeFor()
    expect(ambiguous).toMatchObject({
      ok: false,
      code: "forbidden",
      errors: ["ambiguous_operation"],
    })
    const mismatched = f.proposeFor("other")
    expect(mismatched).toMatchObject({
      ok: false,
      code: "forbidden",
      errors: ["no_operation"],
    })
    const gmail = f.proposeFor("gmail")
    if (!gmail.ok) throw new Error("gmail proposal refused")
    s.db.exec("UPDATE connectors SET enabled=0 WHERE name='gmail'")
    expect(await f.executor.execute(gmail.intentId)).toEqual({
      ok: false,
      code: "connector_unavailable",
    })
    expect(f.transport).not.toHaveBeenCalled()
  })

  it("detects a changed selector after approval and fails closed for pre-binding stored intents", async () => {
    const f = dualConnectorFixture()
    const proton = f.proposeFor("proton-mail")
    if (!proton.ok) throw new Error("proton proposal refused")
    approved(proton.intentId)
    s.db
      .prepare("UPDATE intents SET state='approved', payload_json=? WHERE id=?")
      .run(canonicalize({ ...label, connector: "gmail" }), proton.intentId)
    expect(await f.executor.execute(proton.intentId)).toEqual({
      ok: false,
      code: "hash_mismatch",
    })
    const gmail = f.proposeFor("gmail")
    if (!gmail.ok) throw new Error("gmail proposal refused")
    // Simulate a row written before connector binding existed. Even after its old connector
    // disappears and another remains, it cannot acquire a different destination at execution.
    s.db
      .prepare("UPDATE intents SET payload_json=?, payload_hash=? WHERE id=?")
      .run(canonicalize(label), payloadHash(label), gmail.intentId)
    s.db.exec("UPDATE connectors SET enabled=0 WHERE name='gmail'")
    expect(await f.executor.execute(gmail.intentId)).toEqual({
      ok: false,
      code: "connector_unavailable",
    })
    expect(f.transport).not.toHaveBeenCalled()
  })
  it("executes an auto intent with no approval, records the result and inverse, and restores upstream state on undo", async () => {
    const f = fixture()
    const result = await f.executor.execute(f.id)
    expect(result).toEqual({
      ok: true,
      upstreamRef: "provider-ref-1",
      result: { labels: ["work"] },
    })
    expect(f.labels.has("work")).toBe(true)
    expect(s.db.prepare("SELECT count(*) n FROM approvals").get()?.["n"]).toBe(
      0
    )
    expect(
      s.db
        .prepare(
          "SELECT upstream_ref,result,inverse_op FROM executions WHERE intent_id=?"
        )
        .get(f.id)
    ).toEqual({
      upstream_ref: "provider-ref-1",
      result: '{"labels":["work"]}',
      inverse_op:
        '{"args":{"messageIds":["msg-1"],"remove":["work"]},"connector":"mail","kind":"email.label"}',
    })
    expect(await f.executor.undo(f.id)).toEqual({
      ok: true,
      upstreamRef: "provider-ref-1",
      result: { labels: [] },
    })
    expect(f.labels.has("work")).toBe(false)
    expect(intentStatus(s.db, f.id)).toEqual({
      state: "executed",
      tier: "auto",
    })
    expect(intentHistory(s.db, f.id).slice(-2)).toMatchObject([
      { from: "approved", to: "executed", actor: "executor" },
      { from: "executed", to: "executed", actor: "executor", reason: "undone" },
    ])
    expect(
      f.transport.mock.calls.map(([request]) => request.idempotencyKey)
    ).toEqual([f.id, `${f.id}:undo`])
    const events = auditRows(s.db).filter(
      (row) => row.action === "execute" || row.action === "undo"
    )
    expect(events.map((row) => row.detail_hash)).toEqual([
      payloadHash({
        upstream_ref: "provider-ref-1",
        result: { labels: ["work"] },
        inverse: { ...inverse, connector: "mail" },
      }),
      payloadHash({
        upstream_ref: "provider-ref-1",
        result: { labels: [] },
        inverse: { ...inverse, connector: "mail" },
      }),
    ])
    expect(verifyChain(s.db).ok).toBe(true)
    expect(loggedText(s.db)).not.toContain("work")
  })

  it("returns recorded execute and undo results without additional calls", async () => {
    const f = fixture()
    expect(await f.executor.execute(f.id)).toEqual(
      await f.executor.execute(f.id)
    )
    expect(await f.executor.undo(f.id)).toEqual(await f.executor.undo(f.id))
    expect(f.transport).toHaveBeenCalledTimes(2)
    expect(auditRows(s.db).map((row) => row.action)).toContain(
      "execute.replayed"
    )
  })

  it("invariant: executor refuses tampered approved payloads before transport", async () => {
    const f = fixture()
    approved(f.id)
    s.db.prepare("UPDATE intents SET payload_json=? WHERE id=?").run(
      canonicalize({
        ...label,
        args: { messageIds: ["other"], add: ["work"] },
      }),
      f.id
    )
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "hash_mismatch",
    })
    expect(f.transport).not.toHaveBeenCalled()
    expect(intentStatus(s.db, f.id)?.state).toBe("failed")
    expect(auditRows(s.db).at(-1)?.action).toBe("alert.hash_mismatch")
    expect(verifyChain(s.db).ok).toBe(true)
  })

  it.each(["body", "url", "method"])(
    "rejects a writer that changes the approved request %s",
    async (field) => {
      const f = fixture()
      const build = f.writer.buildRequest
      f.writer.buildRequest = async (intent) => {
        const request = await build(intent)
        if (field === "body")
          request.body = {
            provider_arguments: { messageIds: ["other"], add: ["work"] },
          }
        else if (field === "url")
          request.url = "https://mail.example.com/v1/send"
        else request.method = "DELETE"
        return request
      }
      expect(await f.executor.execute(f.id)).toEqual({
        ok: false,
        code: "hash_mismatch",
      })
      expect(f.transport).not.toHaveBeenCalled()
    }
  )

  it("rechecks stored authority after asynchronous request preparation", async () => {
    const f = fixture()
    const build = f.writer.buildRequest
    f.writer.buildRequest = async (intent) => {
      const request = await build(intent)
      s.db.prepare("UPDATE intents SET state='failed' WHERE id=?").run(f.id)
      return request
    }
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "invalid_state",
    })
    expect(f.transport).not.toHaveBeenCalled()
    expect(
      s.db.prepare("SELECT count(*) AS n FROM execution_attempts").get()?.["n"]
    ).toBe(0)
  })

  it("refuses approval revoked during asynchronous preparation", async () => {
    const f = fixture()
    approved(f.id)
    s.db.prepare("UPDATE intents SET state='approved' WHERE id=?").run(f.id)
    const build = f.writer.buildRequest
    f.writer.buildRequest = async (intent) => {
      const request = await build(intent)
      s.db
        .prepare(
          "UPDATE credentials SET revoked_at='now' WHERE credential_id='credential'"
        )
        .run()
      return request
    }
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "missing_approval",
    })
    expect(f.transport).not.toHaveBeenCalled()
  })

  it("claims only one write when asynchronous preparations race", async () => {
    const f = fixture()
    const build = f.writer.buildRequest
    f.writer.buildRequest = async (intent) => {
      await Promise.resolve()
      return build(intent)
    }
    const results = await Promise.all([
      f.executor.execute(f.id),
      f.executor.execute(f.id),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it("passes an immutable snapshot of the checked request to transport", async () => {
    const f = fixture()
    let built: UpstreamRequest | undefined
    const build = f.writer.buildRequest
    f.writer.buildRequest = async (intent) => {
      built = await build(intent)
      return built
    }
    const decode = f.writer.intentFromRequest
    f.writer.intentFromRequest = (request, connector) => {
      if (built !== undefined) built.url = "https://attacker.example.com"
      return decode(request, connector)
    }
    await f.executor.execute(f.id)
    expect(f.transport.mock.calls[0]?.[0]).toMatchObject({
      url,
      method: "POST",
      body: '{"provider_arguments":{"add":["work"],"messageIds":["msg-1"]}}',
    })
    expect(Object.isFrozen(f.transport.mock.calls[0]?.[0])).toBe(true)
  })

  it.each(["pending", "rejected", "failed"] as const)(
    "refuses %s intents",
    async (state) => {
      const f = fixture()
      s.db.prepare("UPDATE intents SET state=? WHERE id=?").run(state, f.id)
      expect(await f.executor.execute(f.id)).toEqual({
        ok: false,
        code: "invalid_state",
      })
      expect(f.transport).not.toHaveBeenCalled()
      expect(auditRows(s.db).at(-1)?.action).toBe(
        "execute.refused.invalid_state"
      )
    }
  )

  it("accepts proposed auto intents and refuses forbidden approved intents", async () => {
    const f = fixture()
    s.db.prepare("UPDATE intents SET state='proposed' WHERE id=?").run(f.id)
    expect((await f.executor.execute(f.id)).ok).toBe(true)
    const other = propose(s.db, s.policy, { intent: label, origin: "reactive" })
    if (!other.ok) throw new Error(other.code)
    s.db
      .prepare("UPDATE intents SET tier='forbidden' WHERE id=?")
      .run(other.intentId)
    expect(await f.executor.execute(other.intentId)).toEqual({
      ok: false,
      code: "invalid_state",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it("requires a matching consumed signed approval reference for approval-tier intents", async () => {
    const f = fixture()
    s.db.prepare("UPDATE intents SET tier='approval' WHERE id=?").run(f.id)
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "missing_approval",
    })
    approved(f.id)
    s.db
      .prepare("UPDATE approvals SET bundle_hash='wrong' WHERE intent_id=?")
      .run(f.id)
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "missing_approval",
    })
    s.db
      .prepare(
        "UPDATE approvals SET bundle_hash=(SELECT payload_hash FROM intents WHERE id=?) WHERE intent_id=?"
      )
      .run(f.id, f.id)
    expect((await f.executor.execute(f.id)).ok).toBe(true)
    expect(
      s.db
        .prepare("SELECT inverse_op FROM executions WHERE intent_id=?")
        .get(f.id)?.["inverse_op"]
    ).toBeNull()
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "undo_not_allowed",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it("refuses undo with no inverse and before execution", async () => {
    const f = fixture()
    f.writer.inverse = () => null
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "undo_not_allowed",
    })
    await f.executor.execute(f.id)
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "no_inverse",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it.each([
    "email.send",
    "email.forward",
    "email.reply",
    "email.trash",
    "file.delete",
  ] as const)("refuses dangerous inverse %s", async (kind) => {
    const f = fixture()
    f.writer.inverse = () => sample(kind)
    await f.executor.execute(f.id)
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "unsafe_inverse",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it("fails upstream errors once, with no details in the audit log and no retry", async () => {
    const f = fixture()
    f.transport.mockRejectedValue(new Error("synthetic-secret-payload"))
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "upstream_error",
    })
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "invalid_state",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(intentStatus(s.db, f.id)?.state).toBe("failed")
    expect(loggedText(s.db)).not.toContain("synthetic-secret-payload")
    expect(verifyChain(s.db).ok).toBe(true)
  })

  it.each(["money.transfer", "file.hardDelete", "email.archive"])(
    "refuses an unregistered kind %s",
    async (kind) => {
      const f = fixture()
      const value = { kind, args: { messageIds: ["msg-1"] } }
      s.db
        .prepare(
          "UPDATE intents SET kind=?,payload_json=?,payload_hash=? WHERE id=?"
        )
        .run(kind, canonicalize(value), payloadHash(value), f.id)
      expect((await f.executor.execute(f.id)).ok).toBe(false)
      expect(f.transport).not.toHaveBeenCalled()
    }
  )

  it("serializes simultaneous execute/undo calls across independent executors", async () => {
    const f = fixture()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const actual = f.transport.getMockImplementation()
    if (actual === undefined) throw new Error("missing fake")
    f.transport.mockImplementation(async (request) => {
      await gate
      return actual(request)
    })
    const second = createExecutor(s.db, [f.writer], f.transport)
    const first = f.executor.execute(f.id)
    expect(await second.execute(f.id)).toEqual({
      ok: false,
      code: "outcome_unresolved",
    })
    release?.()
    expect((await first).ok).toBe(true)
    let finishUndo: (() => void) | undefined
    const undoGate = new Promise<void>((resolve) => {
      finishUndo = resolve
    })
    f.transport.mockImplementation(async (request) => {
      await undoGate
      return actual(request)
    })
    const undo = second.undo(f.id)
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "outcome_unresolved",
    })
    finishUndo?.()
    expect((await undo).ok).toBe(true)
    expect(f.transport).toHaveBeenCalledTimes(2)
  })

  it("preserves claims across database handles and restart instead of replaying an uncertain external write", async () => {
    const f = fixture()
    const dir = mkdtempSync(join(tmpdir(), "eido-executor-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, "control.db")
    const db = openControlDb(path)
    const row = s.db.prepare("SELECT * FROM intents WHERE id=?").get(f.id)
    if (row === undefined) throw new Error("missing intent")
    db.prepare(
      "INSERT INTO intents(id,kind,payload_json,payload_hash,tier,state,origin,created_at) VALUES (?,?,?,?,'auto','approved','reactive','now')"
    ).run(
      f.id,
      "email.label",
      String(row["payload_json"]),
      String(row["payload_hash"])
    )
    db.prepare(
      "INSERT INTO execution_attempts VALUES (?,'execute','then')"
    ).run(f.id)
    db.close()
    const reopened = openControlDb(path)
    expect(
      await createExecutor(reopened, [f.writer], f.transport).execute(f.id)
    ).toEqual({ ok: false, code: "outcome_unresolved" })
    expect(f.transport).not.toHaveBeenCalled()
    reopened.close()
  })

  it("refuses tampered successful records rather than returning or executing an altered inverse", async () => {
    const f = fixture()
    await f.executor.execute(f.id)
    s.db.prepare("UPDATE executions SET inverse_op=? WHERE intent_id=?").run(
      canonicalize({
        ...inverse,
        args: { messageIds: ["other"], remove: ["work"] },
      }),
      f.id
    )
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "record_mismatch",
    })
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "record_mismatch",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(verifyChain(s.db).ok).toBe(true)
  })

  it("refuses unknown intents and duplicate registry entries", async () => {
    const f = fixture()
    expect(await f.executor.execute("missing")).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(await f.executor.undo("missing")).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(() =>
      createExecutor(s.db, [f.writer, f.writer], f.transport)
    ).toThrow("duplicate writer kind")
    expect(f.transport).not.toHaveBeenCalled()
  })
  it.each(["disabled", "open", "missing"])(
    "refuses a connector that became %s after proposal and before undo",
    async (mode) => {
      const f = fixture()
      const disable = () => {
        if (mode === "disabled")
          s.db.exec("UPDATE connectors SET enabled=0 WHERE name='mail'")
        else if (mode === "open")
          s.db.exec("UPDATE connectors SET health='open' WHERE name='mail'")
        else s.db.exec("DELETE FROM connectors WHERE name='mail'")
      }
      disable()
      expect(await f.executor.execute(f.id)).toEqual({
        ok: false,
        code: "connector_unavailable",
      })
      expect(f.transport).not.toHaveBeenCalled()
      if (mode === "missing") return
      s.db.exec(
        "UPDATE connectors SET enabled=1,health='healthy' WHERE name='mail'"
      )
      await f.executor.execute(f.id)
      disable()
      expect(await f.executor.undo(f.id)).toEqual({
        ok: false,
        code: "connector_unavailable",
      })
      expect(f.transport).toHaveBeenCalledTimes(1)
    }
  )

  it("refuses an inverse that selects another connector", async () => {
    const f = fixture()
    f.writer.inverse = () => ({ ...inverse, connector: "other" })
    expect((await f.executor.execute(f.id)).ok).toBe(true)
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "invalid_inverse",
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it("refuses a malformed or inconsistent stored intent", async () => {
    const f = fixture()
    s.db.prepare("UPDATE intents SET payload_json='{' WHERE id=?").run(f.id)
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "hash_mismatch",
    })
    expect(f.transport).not.toHaveBeenCalled()
  })

  it.each([
    "http://mail.example.com/v1",
    "https://user:password@mail.example.com/v1",
    "https://mail.example.com/v1#fragment",
  ])("refuses unsafe write URL %s", async (badUrl) => {
    const f = fixture()
    const build = f.writer.buildRequest
    f.writer.buildRequest = async (intent) => ({
      ...(await build(intent)),
      url: badUrl,
    })
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "hash_mismatch",
    })
    expect(f.transport).not.toHaveBeenCalled()
  })

  it("does not retry a failed undo or change the executed state", async () => {
    const f = fixture()
    await f.executor.execute(f.id)
    f.transport.mockRejectedValue(new Error("provider-body"))
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "upstream_error",
    })
    expect(await f.executor.undo(f.id)).toEqual({
      ok: false,
      code: "outcome_unresolved",
    })
    expect(intentStatus(s.db, f.id)?.state).toBe("executed")
    expect(f.transport).toHaveBeenCalledTimes(2)
    expect(loggedText(s.db)).not.toContain("provider-body")
  })

  it("fails closed if the stored intent changes during an external call", async () => {
    const f = fixture()
    f.transport.mockImplementation(() => {
      s.db
        .prepare("UPDATE intents SET payload_hash='tampered' WHERE id=?")
        .run(f.id)
      return Promise.resolve({
        upstreamRef: "ref",
        result: { labels: ["work"] },
      })
    })
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "changed_during_execution",
    })
    expect(intentStatus(s.db, f.id)?.state).toBe("failed")
    expect(
      s.db
        .prepare("SELECT intent_id FROM executions WHERE intent_id=?")
        .get(f.id)
    ).toBeUndefined()
    expect(f.transport).toHaveBeenCalledTimes(1)
  })

  it("records failure rather than an unsafe inverse from a broken adapter", async () => {
    const f = fixture()
    f.writer.inverse = () => ({ kind: "money.transfer", args: {} })
    expect(await f.executor.execute(f.id)).toEqual({
      ok: false,
      code: "upstream_error",
    })
    expect(intentStatus(s.db, f.id)?.state).toBe("failed")
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it.each([
    "https://other.example.com/v1/labels",
    "https://mail.example.com/private/labels",
    "https://mail.example.com/v1/other",
    "https://mail.example.com/v1/../v1/labels",
    "https://mail.example.com/v1/%2e%2e/v1/labels",
    "https://mail.example.com/v1/%2flabels",
    "https://mail.example.com/v1/%252flabels",
    "https://mail.example.com/v1/%",
    "https://mail.example.com:444/v1/labels",
    "https://mail.example.com/v1//labels",
  ])(
    "independently refuses unpinned or ambiguous target %s even if the adapter projection accepts it",
    async (target) => {
      const f = fixture()
      const build = f.writer.buildRequest
      f.writer.buildRequest = async (intent) => ({
        ...(await build(intent)),
        url: target,
      })
      f.writer.intentFromRequest = () => ({ ...label, connector: "mail" })
      expect(await f.executor.execute(f.id)).toEqual({
        ok: false,
        code: "hash_mismatch",
      })
      expect(f.transport).not.toHaveBeenCalled()
    }
  )

  it.each(["missing", "wrong_operation", "overlap", "wrong_method"])(
    "refuses pinned write route configuration %s",
    async (mode) => {
      const f = fixture()
      const mail = getPinnedManifest(s.db, "mail")
      if (mail === undefined) throw new Error("missing manifest")
      mail.version++
      const operation = mail.operations.find(
        (op) => op.intentKind === "email.label"
      )
      if (operation === undefined) throw new Error("missing labels")
      if (mode === "missing") delete operation.routes
      if (mode === "wrong_operation") {
        const other = mail.operations.find(
          (op) => op.intentKind === "email.archive"
        )
        if (other === undefined) throw new Error("missing archive")
        other.routes = operation.routes
        delete operation.routes
      }
      if (mode === "overlap")
        operation.routes?.push({
          host: "mail.example.com",
          method: "POST",
          pathPattern: "/v1/{resource}",
        })
      if (mode === "wrong_method") {
        mail.egress.hosts[0]?.methods.splice(0, 1, "GET")
        operation.routes = [
          {
            host: "mail.example.com",
            method: "GET",
            pathPattern: "/v1/labels",
          },
        ]
      }
      signedPin(s.db, mail, "system")
      expect(await f.executor.execute(f.id)).toEqual({
        ok: false,
        code: "hash_mismatch",
      })
      expect(f.transport).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["another write operation", "write", true],
    ["a read operation", "read", false],
  ] as const)(
    "with %s pinned on the same route, executes only when every sharer writes",
    async (_name, effect, executes) => {
      const f = fixture()
      const mail = getPinnedManifest(s.db, "mail")
      if (mail === undefined) throw new Error("missing manifest")
      mail.version++
      const shared = [
        { host: "mail.example.com", method: "POST", pathPattern: "/v1/labels" },
      ] satisfies ConnectorManifest["operations"][number]["routes"]
      if (effect === "write") {
        const archive = mail.operations.find(
          (op) => op.intentKind === "email.archive"
        )
        if (archive === undefined) throw new Error("missing archive")
        archive.routes = shared
      } else {
        mail.operations.push({
          name: "list_labels",
          effect: "read",
          reversibility: "reversible",
          defaultTier: "auto",
          sensitivity: "normal",
          untrustedOutput: true,
          authScopes: ["write"],
          routes: shared,
        })
      }
      signedPin(s.db, mail, "system")
      const result = await f.executor.execute(f.id)
      expect(result.ok).toBe(executes)
      expect(f.transport).toHaveBeenCalledTimes(executes ? 1 : 0)
      if (executes)
        expect(f.transport.mock.calls[0]?.[0]).toMatchObject({
          operation: "set_labels",
          url,
        })
    }
  )

  it("constructs pinned dynamic paths and query parameters before immutable transport dispatch", async () => {
    const f = fixture()
    const mail = getPinnedManifest(s.db, "mail")
    if (mail === undefined) throw new Error("missing manifest")
    mail.version++
    const operation = mail.operations.find(
      (op) => op.intentKind === "email.label"
    )
    if (operation === undefined) throw new Error("missing labels")
    operation.routes = [
      {
        host: "mail.example.com",
        method: "POST",
        pathPattern: "/v1/labels/{messageId}",
      },
    ]
    signedPin(s.db, mail, "system")
    const build = f.writer.buildRequest
    f.writer.buildRequest = async (intent) => ({
      ...(await build(intent)),
      url: "https://mail.example.com/v1/labels/msg-1?tag=work&format=json",
    })
    f.writer.intentFromRequest = () => ({ ...label, connector: "mail" })
    expect((await f.executor.execute(f.id)).ok).toBe(true)
    expect(f.transport.mock.calls[0]?.[0]).toMatchObject({
      connector: "mail",
      operation: "set_labels",
      intentKind: "email.label",
      url: "https://mail.example.com/v1/labels/msg-1?tag=work&format=json",
    })
  })
})
