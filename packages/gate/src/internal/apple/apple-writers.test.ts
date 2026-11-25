import { afterEach, describe, expect, test, vi } from "vitest"
import { REVIEWED_MANIFESTS, validateConnectorManifest } from "@eido/schemas"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import {
  APPLE_DESTINATIONS,
  APPLE_WRITERS,
  appleDestination,
  createAppleTransport,
} from "./apple-writers"
import { APPLE_CONNECTOR } from "./apple-routes"
import { createExecutor } from "../executor"
import type { UpstreamWriter, WriteRequest } from "../executor"
import { propose } from "../intents"
import { kindTier } from "../policy"
import { sample, setup } from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import type { GateAppleRequest } from "@eido/schemas"

let state: Setup | undefined
afterEach(() => {
  state?.cleanup()
  state = undefined
})
const kinds = [
  "apple.event_create",
  "apple.event_update",
  "apple.reminder_create",
  "apple.reminder_complete",
] as const
function manifest(): ConnectorManifest {
  const checked = validateConnectorManifest(
    structuredClone(REVIEWED_MANIFESTS[APPLE_CONNECTOR])
  )
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value
}
function fixture(
  kind: (typeof kinds)[number],
  connector = manifest(),
  writers = APPLE_WRITERS
) {
  state = setup([connector])
  const proposed = propose(state.db, state.policy, {
    intent: sample(kind),
    origin: "reactive",
  })
  if (!proposed.ok) throw new Error(proposed.code)
  const run = vi.fn(() => Promise.resolve({ id: "created-1" }))
  const executor = createExecutor(state.db, writers, createAppleTransport(run))
  return { s: state, id: proposed.intentId, executor, run }
}
function storedApproval(s: Setup, id: string) {
  // The approvals module tests signature verification; this models its verified stored result.
  s.db.prepare("UPDATE intents SET state='approved' WHERE id=?").run(id)
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
function writeRequest(intent: Intent): WriteRequest {
  return {
    connector: APPLE_CONNECTOR,
    operation: (appleDestination(intent.kind) ?? "").slice("eventkit:".length),
    method: "POST",
    url: appleDestination(intent.kind) ?? "",
    body: JSON.stringify(intent),
    intentKind: intent.kind,
    idempotencyKey: "intent-1",
  }
}

describe("Apple approval-only native writes", () => {
  test.each(kinds)(
    "%s cannot be downgraded by policy or executed without verified approval",
    async (kind) => {
      const { s, id, executor, run } = fixture(kind)
      s.policy.shipped.tiers[kind] = "auto"
      expect(kindTier(s.db, s.policy, kind)).toEqual({ tier: "approval" })
      s.policy.overlay = { version: 1, tiers: { [kind]: "auto" } }
      expect(kindTier(s.db, s.policy, kind)).toEqual({ tier: "approval" })
      await expect(executor.execute(id)).resolves.toEqual({
        ok: false,
        code: "invalid_state",
      })
      s.db.prepare("UPDATE intents SET state='approved' WHERE id=?").run(id)
      await expect(executor.execute(id)).resolves.toEqual({
        ok: false,
        code: "missing_approval",
      })
      s.db.prepare("UPDATE intents SET tier='auto' WHERE id=?").run(id)
      await expect(executor.execute(id)).resolves.toEqual({
        ok: false,
        code: "invalid_state",
      })
      expect(run).not.toHaveBeenCalled()
    }
  )
  test.each(kinds)(
    "%s executes its exact approved native operation once",
    async (kind) => {
      const { s, id, executor, run } = fixture(kind)
      storedApproval(s, id)
      await expect(executor.execute(id)).resolves.toEqual({
        ok: true,
        upstreamRef: "created-1",
        result: { id: "created-1" },
      })
      expect(run).toHaveBeenCalledWith({
        operation: APPLE_DESTINATIONS[kind].slice("eventkit:".length),
        args: sample(kind).args,
      })
      expect(run).toHaveBeenCalledTimes(1)
      await executor.execute(id)
      expect(run).toHaveBeenCalledTimes(1)
      await expect(executor.undo(id)).resolves.toEqual({
        ok: false,
        code: "undo_not_allowed",
      })
      expect(
        s.db
          .prepare("SELECT inverse_op FROM executions WHERE intent_id=?")
          .get(id)?.["inverse_op"]
      ).toBeNull()
    }
  )
  test("preserves a manifest's forbidden tier", () => {
    const blocked = manifest()
    const op = blocked.operations.find(
      (entry) => entry.intentKind === "apple.event_create"
    )
    if (op === undefined) throw new Error("missing event operation")
    op.defaultTier = "forbidden"
    state = setup([blocked])
    expect(kindTier(state.db, state.policy, "apple.event_create")).toEqual({
      tier: "forbidden",
      reason: "manifest_forbidden",
    })
  })
  test.each(["method", "destination", "operation"])(
    "rejects a changed native %s before transport",
    async (variant) => {
      const writers: UpstreamWriter[] = APPLE_WRITERS.map((writer) => ({
        ...writer,
        buildRequest: (intent) => ({
          method: variant === "method" ? "DELETE" : "POST",
          url:
            variant === "destination"
              ? "eventkit:complete_reminder"
              : variant === "operation"
                ? "eventkit:create_event/extra"
                : (appleDestination(intent.kind) ?? ""),
          body: intent,
        }),
      }))
      const { s, id, executor, run } = fixture(
        "apple.event_create",
        manifest(),
        writers
      )
      storedApproval(s, id)
      await expect(executor.execute(id)).resolves.toEqual({
        ok: false,
        code: "hash_mismatch",
      })
      expect(run).not.toHaveBeenCalled()
    }
  )
  test.each(["auth", "host", "local", "connector"])(
    "refuses an incompatible native connector (%s)",
    async (variant) => {
      const changed = manifest()
      if (variant === "auth") changed.auth.type = "none"
      if (variant === "host")
        changed.egress.hosts = [
          { host: "example.invalid", methods: ["POST"], pathPrefixes: ["/v1"] },
        ]
      if (variant === "local")
        changed.egress.local = [
          { protocol: "smtp", host: "127.0.0.1", port: 1025 },
        ]
      if (variant === "connector") changed.name = "other-calendar"
      const writers = APPLE_WRITERS.map((writer) => ({
        ...writer,
        connector: changed.name,
      }))
      const { s, id, executor, run } = fixture(
        "apple.event_create",
        changed,
        writers
      )
      storedApproval(s, id)
      await expect(executor.execute(id)).resolves.toEqual({
        ok: false,
        code: "connector_misconfigured",
      })
      expect(run).not.toHaveBeenCalled()
    }
  )
  test("transport rejects mismatched kinds, operations and output", async () => {
    const requests: GateAppleRequest[] = []
    const transport = createAppleTransport((request) => {
      requests.push(request)
      return Promise.resolve({ wrong: true })
    })
    const good = writeRequest(sample("apple.event_create"))
    await expect(transport(good)).rejects.toMatchObject({ code: "unavailable" })
    expect(requests).toHaveLength(1)
    const variants = [
      { ...good, connector: "other" },
      { ...good, method: "DELETE" },
      { ...good, body: "not json" },
      { ...good, body: "{}" },
      { ...good, operation: "delete_event" },
      { ...good, url: "eventkit:update_event" },
      { ...good, intentKind: "apple.event_update" as const },
      writeRequest(sample("email.draft")),
    ]
    for (const request of variants)
      await expect(transport(request)).rejects.toMatchObject({
        code: "invalid_request",
      })
    expect(requests).toHaveLength(1)
    expect(appleDestination("email.draft")).toBeUndefined()
  })
})
