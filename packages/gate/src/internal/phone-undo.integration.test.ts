import { afterEach, describe, expect, it, vi } from "vitest"
import { validateGateAuditPage, validateGateLoginOptions } from "@eido/schemas"
import type { Intent } from "@eido/schemas"
import { createExecutor } from "./executor"
import type { WriteRequest, WriteTransport } from "./executor"
import {
  GMAIL_BATCH_MODIFY_PATH,
  GMAIL_HOST,
  gmailArchiveWriter,
  gmailLabelWriter,
  gmailMarkReadWriter,
} from "./gmail-writers"
import type { Handler, Reply } from "./http"
import { propose } from "./intents"
import { phoneHandler } from "./phone-routes"
import {
  assertion,
  auditRows,
  loggedText,
  MAIL_OPS,
  manifest,
  setup,
  testAuthenticator,
  WEBAUTHN,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

const HOST = "eido.example.invalid"
const NOW = new Date("2030-01-01T12:00:00Z")
const WRITERS = [gmailArchiveWriter, gmailLabelWriter, gmailMarkReadWriter]
let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  )
}

function pinnedMailbox() {
  const gmail = manifest("gmail", MAIL_OPS)
  gmail.egress.hosts = [
    {
      host: GMAIL_HOST,
      methods: ["POST"],
      pathPrefixes: ["/gmail/v1/users/me"],
    },
  ]
  for (const operation of gmail.operations) {
    if (
      ["email.archive", "email.label", "email.markRead"].includes(
        operation.intentKind ?? ""
      )
    ) {
      operation.routes = [
        {
          host: GMAIL_HOST,
          method: "POST",
          pathPattern: GMAIL_BATCH_MODIFY_PATH,
        },
      ]
    }
  }
  s = setup([gmail])
  const fixture = s
  const mailbox = new Map<string, Set<string>>([
    ["private-message-1", new Set(["INBOX", "UNREAD", "private-label-marker"])],
    ["private-message-2", new Set(["UNREAD", "private-label-marker"])],
  ])
  const transport = vi.fn<WriteTransport>((request: WriteRequest) => {
    const body: unknown = JSON.parse(request.body)
    if (
      typeof body !== "object" ||
      body === null ||
      !("ids" in body) ||
      !stringArray(body.ids)
    )
      throw new Error("unexpected batch request")
    const ids: string[] = body.ids
    const priorLabels = Object.fromEntries(
      ids.map((id) => [id, [...(mailbox.get(id) ?? [])]])
    )
    const previouslyUnread = ids.filter((id) => mailbox.get(id)?.has("UNREAD"))
    for (const id of ids) {
      const labels = mailbox.get(id)
      if (!labels) throw new Error("unknown message")
      if ("addLabelIds" in body && stringArray(body.addLabelIds)) {
        for (const label of body.addLabelIds) {
          if (typeof label !== "string") throw new Error("bad label")
          labels.add(label)
        }
      }
      if ("removeLabelIds" in body && stringArray(body.removeLabelIds)) {
        for (const label of body.removeLabelIds) {
          if (typeof label !== "string") throw new Error("bad label")
          labels.delete(label)
        }
      }
    }
    return Promise.resolve({
      upstreamRef: null,
      result: { priorLabels, previouslyUnread },
    })
  })
  const executor = createExecutor(fixture.db, WRITERS, transport)
  const handler = (undo = (id: string) => executor.undo(id)) =>
    phoneHandler({
      gate: () => ({
        db: fixture.db,
        policy: fixture.policy,
        webAuthn: WEBAUTHN,
      }),
      allowedHosts: [HOST],
      basePath: "/api/gate",
      now: () => NOW,
      undo,
    })
  const labels = () =>
    Object.fromEntries(
      [...mailbox].map(([id, values]) => [id, [...values].sort()])
    )
  async function execute(intent: Intent): Promise<string> {
    const proposed = propose(fixture.db, fixture.policy, {
      intent,
      origin: "reactive",
    })
    if (!proposed.ok) throw new Error(proposed.code)
    expect(proposed.tier).toBe("auto")
    expect((await executor.execute(proposed.intentId)).ok).toBe(true)
    return proposed.intentId
  }
  return { ...fixture, mailbox, transport, executor, handler, labels, execute }
}

function call(
  handler: Handler,
  path: string,
  cookie?: string,
  method = "POST"
): Promise<Reply> {
  return Promise.resolve(
    handler({
      method,
      path: `/api/gate${path}`,
      query: new URLSearchParams(),
      headers: {
        host: HOST,
        contentType: "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: () => Promise.resolve({ ok: true, text: "{}" }),
    })
  )
}

async function signIn(
  f: ReturnType<typeof pinnedMailbox>,
  handler: Handler
): Promise<string> {
  const auth = testAuthenticator()
  f.db
    .prepare(
      "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
    )
    .run(auth.credentialId, auth.publicKey, NOW.toISOString())
  const options = validateGateLoginOptions(
    (await call(handler, "/auth/login/options")).body
  )
  if (!options.ok) throw new Error("invalid login options")
  const response = await handler({
    method: "POST",
    path: "/api/gate/auth/login",
    query: new URLSearchParams(),
    headers: { host: HOST, contentType: "application/json" },
    body: () =>
      Promise.resolve({
        ok: true,
        text: JSON.stringify({
          assertion: assertion(auth, options.value.challenge),
        }),
      }),
  })
  const cookie = response.headers?.["set-cookie"]?.split(";")[0]
  if (!cookie) throw new Error("login failed")
  return cookie
}

async function projection(handler: Handler, cookie: string, id: string) {
  const page = validateGateAuditPage(
    (await call(handler, "/audit", cookie, "GET")).body
  )
  if (!page.ok) throw new Error("invalid audit page")
  return page.value.entries.find(
    (entry) => entry.action === "execute" && entry.target === id
  )
}

const ids = ["private-message-1", "private-message-2"]
const BEFORE = {
  "private-message-1": ["INBOX", "UNREAD", "private-label-marker"],
  "private-message-2": ["UNREAD", "private-label-marker"],
}

describe("phone Undo through real executor and Gmail writers", () => {
  it.each([
    {
      intent: {
        kind: "email.archive",
        connector: "gmail",
        args: { messageIds: ids },
      } satisfies Intent,
      after: {
        "private-message-1": ["UNREAD", "private-label-marker"],
        "private-message-2": ["UNREAD", "private-label-marker"],
      },
    },
    {
      intent: {
        kind: "email.markRead",
        connector: "gmail",
        args: { messageIds: ids, read: true },
      } satisfies Intent,
      after: {
        "private-message-1": ["INBOX", "private-label-marker"],
        "private-message-2": ["private-label-marker"],
      },
    },
    {
      intent: {
        kind: "email.label",
        connector: "gmail",
        args: { messageIds: ids, add: ["work"], remove: ["UNREAD"] },
      } satisfies Intent,
      after: {
        "private-message-1": ["INBOX", "private-label-marker", "work"],
        "private-message-2": ["private-label-marker", "work"],
      },
    },
  ])(
    "restores $intent.kind and changes Activity from available to done",
    async ({ intent, after }) => {
      const f = pinnedMailbox()
      const handler = f.handler()
      const cookie = await signIn(f, handler)
      const id = await f.execute(intent)
      expect(f.labels()).toEqual(after)
      expect((await projection(handler, cookie, id))?.undo).toBe("available")
      const response = await call(handler, `/executions/${id}/undo`, cookie)
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ id, undone: true })
      expect(f.labels()).toEqual(BEFORE)
      expect((await projection(handler, cookie, id))?.undo).toBe("done")
      const successful = auditRows(f.db).filter((row) => row.action === "undo")
      expect(successful).toHaveLength(1)
      expect(successful[0]).toMatchObject({ actor: "executor", target: id })
      expect(loggedText(f.db)).not.toContain("private-message-")
      expect(loggedText(f.db)).not.toContain("private-label-marker")
      expect(
        (await call(handler, `/executions/${id}/undo`, cookie)).status
      ).toBe(409)
      expect(f.transport).toHaveBeenCalledTimes(2)
      expect(
        auditRows(f.db).filter((row) => row.action === "undo")
      ).toHaveLength(1)
    }
  )

  it("allows only one concurrent HTTP undo across handler/executor instances", async () => {
    const f = pinnedMailbox()
    const first = f.handler()
    const cookie = await signIn(f, first)
    const id = await f.execute({
      kind: "email.markRead",
      args: { messageIds: ids, read: true },
    })
    const apply = f.transport.getMockImplementation()
    if (!apply) throw new Error("transport missing")
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    f.transport.mockImplementation(async (request) => {
      entered?.()
      await held
      return apply(request)
    })
    const secondExecutor = createExecutor(f.db, WRITERS, f.transport)
    const second = f.handler((id) => secondExecutor.undo(id))
    const pending = call(first, `/executions/${id}/undo`, cookie)
    await started
    expect((await call(second, `/executions/${id}/undo`, cookie)).status).toBe(
      409
    )
    release?.()
    expect((await pending).status).toBe(200)
    expect(f.transport).toHaveBeenCalledTimes(2)
    expect(f.labels()).toEqual(BEFORE)
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toHaveLength(
      1
    )
  })

  it("refuses a tampered stored inverse without another upstream call", async () => {
    const f = pinnedMailbox()
    const handler = f.handler()
    const cookie = await signIn(f, handler)
    const id = await f.execute({
      kind: "email.archive",
      args: { messageIds: ids },
    })
    f.db.prepare("UPDATE executions SET inverse_op=? WHERE intent_id=?").run(
      JSON.stringify({
        kind: "email.label",
        connector: "gmail",
        args: { messageIds: ["unrelated-message"], add: ["INBOX"] },
      }),
      id
    )
    expect((await call(handler, `/executions/${id}/undo`, cookie)).status).toBe(
      409
    )
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.labels()).toEqual({
      "private-message-1": ["UNREAD", "private-label-marker"],
      "private-message-2": ["UNREAD", "private-label-marker"],
    })
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
  })

  it("refuses an unchanged message with no reversible effect", async () => {
    const f = pinnedMailbox()
    for (const labels of f.mailbox.values()) labels.delete("UNREAD")
    const handler = f.handler()
    const cookie = await signIn(f, handler)
    const id = await f.execute({
      kind: "email.markRead",
      args: { messageIds: ids, read: true },
    })
    expect((await projection(handler, cookie, id))?.undo).toBe("none")
    expect((await call(handler, `/executions/${id}/undo`, cookie)).status).toBe(
      409
    )
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
  })

  it("preserves the executor's unsafe-inverse refusal even with an audit-bound inverse", async () => {
    const f = pinnedMailbox()
    const executor = createExecutor(
      f.db,
      [
        {
          ...gmailMarkReadWriter,
          inverse: () => ({
            kind: "email.trash",
            connector: "gmail",
            args: { messageIds: ids },
          }),
        },
      ],
      f.transport
    )
    const handler = f.handler((id) => executor.undo(id))
    const cookie = await signIn(f, handler)
    const proposed = propose(f.db, f.policy, {
      intent: { kind: "email.markRead", args: { messageIds: ids, read: true } },
      origin: "reactive",
    })
    if (!proposed.ok) throw new Error(proposed.code)
    expect((await executor.execute(proposed.intentId)).ok).toBe(true)
    expect(
      (await call(handler, `/executions/${proposed.intentId}/undo`, cookie))
        .status
    ).toBe(409)
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(auditRows(f.db).map((row) => row.action)).toContain(
      "undo.refused.unsafe_inverse"
    )
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
  })

  it("never repeats an undo whose upstream outcome is unresolved", async () => {
    const f = pinnedMailbox()
    const handler = f.handler()
    const cookie = await signIn(f, handler)
    const id = await f.execute({
      kind: "email.archive",
      args: { messageIds: ids },
    })
    f.transport.mockRejectedValueOnce(new Error("synthetic-upstream-secret"))
    const failed = await call(handler, `/executions/${id}/undo`, cookie)
    expect(failed.status).toBe(503)
    expect(JSON.stringify(failed.body)).not.toContain(
      "synthetic-upstream-secret"
    )
    expect((await call(handler, `/executions/${id}/undo`, cookie)).status).toBe(
      409
    )
    expect(f.transport).toHaveBeenCalledTimes(2)
    expect(auditRows(f.db).filter((row) => row.action === "undo")).toEqual([])
    expect(
      f.db.prepare("SELECT state FROM intents WHERE id=?").get(id)?.["state"]
    ).toBe("executed")
  })
})
