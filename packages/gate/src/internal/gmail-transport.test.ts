import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { PROTON_CONNECTOR } from "./bridge/config"
import { createExecutor } from "./executor"
import type { WriteTransport } from "./executor"
import { gmailWriteTransport } from "./gmail-transport"
import { BRIDGE_WRITERS } from "./bridge/writers"
import {
  GMAIL_BATCH_MODIFY_PATH,
  GMAIL_HOST,
  GMAIL_WRITERS,
  gmailMarkReadWriter,
} from "./gmail-writers"
import { propose } from "./intents"
import { MAIL_OPS, manifest, setup, signedPin } from "./test-fixtures"
import type { Setup } from "./test-fixtures"
import { InMemoryVault } from "./vault/vault"

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

const TOKEN = "write-token-for-tests"
const MESSAGE_PATH = "/gmail/v1/users/me/messages/{id}"

/** A pinned Gmail connector; `withRead` adds the pinned messages.get route on a read operation. */
function pinnedGmail(withRead: boolean): Setup {
  const gmail: ConnectorManifest = manifest("gmail", MAIL_OPS)
  gmail.egress.hosts = [
    {
      host: GMAIL_HOST,
      methods: withRead ? ["GET", "POST"] : ["POST"],
      pathPrefixes: ["/gmail/v1/users/me"],
    },
  ]
  // Mark read, label, archive and trash all write through the one batchModify route.
  for (const kind of [
    "email.markRead",
    "email.label",
    "email.archive",
    "email.trash",
  ]) {
    const operation = gmail.operations.find((op) => op.intentKind === kind)
    if (operation === undefined) throw new Error(`fixture lacks ${kind}`)
    operation.routes = [
      {
        host: GMAIL_HOST,
        method: "POST",
        pathPattern: GMAIL_BATCH_MODIFY_PATH,
      },
    ]
  }
  if (withRead) {
    gmail.operations.push({
      name: "get_message",
      effect: "read",
      reversibility: "reversible",
      defaultTier: "auto",
      sensitivity: "normal",
      untrustedOutput: true,
      authScopes: ["write"],
      routes: [{ host: GMAIL_HOST, method: "GET", pathPattern: MESSAGE_PATH }],
    })
  }
  s = setup([gmail])
  return s
}

/** A fake Gmail API behind fetch: message id to labels; only batchModify changes them. */
function fakeGmailApi(labels: Record<string, string[]>) {
  const mailbox = new Map(
    Object.entries(labels).map(([id, list]) => [id, new Set(list)])
  )
  const calls: Array<{ method: string; url: string; authorization: string }> =
    []
  const send = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    calls.push({
      method,
      url,
      authorization: headers.get("authorization") ?? "",
    })
    const parsed = new URL(url)
    const read = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(
      parsed.pathname
    )
    if (method === "GET" && read?.[1] !== undefined) {
      const labelIds = mailbox.get(decodeURIComponent(read[1]))
      if (labelIds === undefined)
        return Promise.resolve(new Response("{}", { status: 404 }))
      return Promise.resolve(
        Response.json({ id: read[1], labelIds: [...labelIds] })
      )
    }
    if (method === "POST" && parsed.pathname === GMAIL_BATCH_MODIFY_PATH) {
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : ""
      )
      if (typeof body !== "object" || body === null) throw new Error("no body")
      const ids = "ids" in body && Array.isArray(body.ids) ? body.ids : []
      const add =
        "addLabelIds" in body && Array.isArray(body.addLabelIds)
          ? body.addLabelIds
          : []
      const remove =
        "removeLabelIds" in body && Array.isArray(body.removeLabelIds)
          ? body.removeLabelIds
          : []
      for (const id of ids) {
        for (const label of add) mailbox.get(String(id))?.add(String(label))
        for (const label of remove)
          mailbox.get(String(id))?.delete(String(label))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    return Promise.resolve(new Response("{}", { status: 404 }))
  })
  return {
    send,
    calls,
    unread: (id: string) => mailbox.get(id)?.has("UNREAD") ?? false,
    labels: (id: string) => [...(mailbox.get(id) ?? [])].sort(),
  }
}

async function vaultWithToken(): Promise<InMemoryVault> {
  const vault = new InMemoryVault()
  await vault.set(
    { connector: "gmail", kind: "access_token", client: "write" },
    TOKEN
  )
  return vault
}

function proposeMarkRead(
  { db, policy }: Setup,
  messageIds: string[],
  read = true
): string {
  const proposed = propose(db, policy, {
    intent: { kind: "email.markRead", args: { messageIds, read } },
    origin: "task",
  })
  if (!proposed.ok) throw new Error(proposed.code)
  return proposed.intentId
}

function inverseOp(setUp: Setup, intentId: string): unknown {
  return setUp.db
    .prepare("SELECT inverse_op FROM executions WHERE intent_id=?")
    .get(intentId)?.["inverse_op"]
}

describe("Gmail write transport: mark read", () => {
  it.each(["GET", "POST"])(
    "refreshes once after a %s 401 and uses the new write token",
    async (method) => {
      const setUp = pinnedGmail(true)
      const gmail = fakeGmailApi({ m: ["UNREAD"] })
      const vault = await vaultWithToken()
      await vault.set(
        { connector: "gmail", kind: "refresh_token", client: "write" },
        "test-refresh-token"
      )
      await vault.set(
        { connector: "gmail", kind: "api_key", client: "write" },
        "test-client-secret"
      )
      const calls: string[] = []
      let challenged = false
      const send = vi.fn(
        (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url
          const currentMethod = init?.method ?? "GET"
          if (url === "https://oauth2.googleapis.com/token") {
            const body =
              init?.body instanceof URLSearchParams
                ? init.body
                : new URLSearchParams()
            expect(body.get("client_secret")).toBe("test-client-secret")
            expect(body.get("refresh_token")).toBe("test-refresh-token")
            calls.push("refresh")
            return Promise.resolve(
              Response.json({ access_token: "test-new-token" })
            )
          }
          const authorization =
            new Headers(init?.headers).get("authorization") ?? ""
          calls.push(`${currentMethod}:${authorization}`)
          if (currentMethod === method && !challenged) {
            challenged = true
            return Promise.resolve(new Response(null, { status: 401 }))
          }
          return gmail.send(input, init)
        }
      )
      const executor = createExecutor(
        setUp.db,
        [gmailMarkReadWriter],
        gmailWriteTransport({
          db: setUp.db,
          vault,
          fetch: send,
          clientId: "test-client-id",
        })
      )
      const id = proposeMarkRead(setUp, ["m"])
      expect((await executor.execute(id)).ok).toBe(true)
      expect(calls.filter((call) => call === "refresh")).toHaveLength(1)
      expect(calls).toContain(`${method}:Bearer test-new-token`)
      expect(gmail.unread("m")).toBe(false)
      expect(inverseOp(setUp, id)).toBe(
        '{"args":{"messageIds":["m"],"read":false},"connector":"gmail","kind":"email.markRead"}'
      )
      expect(
        await vault.get({
          connector: "gmail",
          kind: "access_token",
          client: "write",
        })
      ).toBe("test-new-token")
    }
  )

  it("disables and audits a revoked Gmail grant without a second write", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ m: ["UNREAD"] })
    const vault = await vaultWithToken()
    await vault.set(
      { connector: "gmail", kind: "refresh_token", client: "write" },
      "test-refresh-token"
    )
    await vault.set(
      { connector: "gmail", kind: "api_key", client: "write" },
      "test-client-secret"
    )
    const calls: string[] = []
    const send = vi.fn((input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      calls.push(url)
      if (url === "https://oauth2.googleapis.com/token")
        return Promise.resolve(
          Response.json({ error: "invalid_grant" }, { status: 400 })
        )
      return Promise.resolve(new Response(null, { status: 401 }))
    })
    const executor = createExecutor(
      setUp.db,
      [gmailMarkReadWriter],
      gmailWriteTransport({
        db: setUp.db,
        vault,
        fetch: send,
        clientId: "test-client-id",
      })
    )
    expect(await executor.execute(proposeMarkRead(setUp, ["m"]))).toEqual({
      ok: false,
      code: "upstream_error",
    })
    expect(calls).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m?format=minimal",
      "https://oauth2.googleapis.com/token",
    ])
    expect(
      setUp.db
        .prepare("SELECT enabled,health FROM connectors WHERE name='gmail'")
        .get()
    ).toMatchObject({ enabled: 0, health: "open" })
    expect(
      setUp.db
        .prepare("SELECT action FROM audit_log WHERE target='gmail'")
        .all()
        .map((row) => row["action"])
    ).toContain("grant_revoked")
    expect(
      await vault.get({
        connector: "gmail",
        kind: "access_token",
        client: "write",
      })
    ).toBeUndefined()
    expect(gmail.unread("m")).toBe(true)
  })

  it("stores an inverse_op naming only the messages that were unread, and undo restores just those", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({
      wasUnread: ["INBOX", "UNREAD"],
      wasRead: ["INBOX"],
      noLabels: [],
    })
    const executor = createExecutor(
      setUp.db,
      [gmailMarkReadWriter],
      gmailWriteTransport({
        db: setUp.db,
        vault: await vaultWithToken(),
        fetch: gmail.send,
      })
    )
    const id = proposeMarkRead(setUp, ["wasUnread", "wasRead", "noLabels"])

    expect(await executor.execute(id)).toEqual({
      ok: true,
      upstreamRef: null,
      result: { previouslyUnread: ["wasUnread"] },
    })
    expect(gmail.unread("wasUnread")).toBe(false)
    expect(inverseOp(setUp, id)).toBe(
      '{"args":{"messageIds":["wasUnread"],"read":false},"connector":"gmail","kind":"email.markRead"}'
    )

    expect((await executor.undo(id)).ok).toBe(true)
    expect(gmail.unread("wasUnread")).toBe(true)
    expect(gmail.unread("wasRead")).toBe(false)
  })

  it("reads labels through the pinned route with the gate's write credential, before the write", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ "a/b": ["UNREAD"] })
    const executor = createExecutor(
      setUp.db,
      [gmailMarkReadWriter],
      gmailWriteTransport({
        db: setUp.db,
        vault: await vaultWithToken(),
        fetch: gmail.send,
      })
    )
    expect((await executor.execute(proposeMarkRead(setUp, ["a/b"]))).ok).toBe(
      true
    )
    expect(gmail.calls).toEqual([
      {
        method: "GET",
        url: `https://${GMAIL_HOST}/gmail/v1/users/me/messages/a%2Fb?format=minimal`,
        authorization: `Bearer ${TOKEN}`,
      },
      {
        method: "POST",
        url: `https://${GMAIL_HOST}${GMAIL_BATCH_MODIFY_PATH}`,
        authorization: `Bearer ${TOKEN}`,
      },
    ])
  })

  it("refuses without a pinned read route: no read, no write, and no credential sent", async () => {
    const setUp = pinnedGmail(false)
    const gmail = fakeGmailApi({ m: ["UNREAD"] })
    const executor = createExecutor(
      setUp.db,
      [gmailMarkReadWriter],
      gmailWriteTransport({
        db: setUp.db,
        vault: await vaultWithToken(),
        fetch: gmail.send,
      })
    )
    expect(await executor.execute(proposeMarkRead(setUp, ["m"]))).toEqual({
      ok: false,
      code: "upstream_error",
    })
    expect(gmail.calls).toEqual([])
    expect(gmail.unread("m")).toBe(true)
  })

  it("makes no call and fails when the gate holds no write credential", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ m: ["UNREAD"] })
    const executor = createExecutor(
      setUp.db,
      [gmailMarkReadWriter],
      gmailWriteTransport({
        db: setUp.db,
        vault: new InMemoryVault(),
        fetch: gmail.send,
      })
    )
    expect(await executor.execute(proposeMarkRead(setUp, ["m"]))).toEqual({
      ok: false,
      code: "upstream_error",
    })
    expect(gmail.calls).toEqual([])
  })

  it("does not write when a label read fails", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ known: ["UNREAD"] })
    const executor = createExecutor(
      setUp.db,
      [gmailMarkReadWriter],
      gmailWriteTransport({
        db: setUp.db,
        vault: await vaultWithToken(),
        fetch: gmail.send,
      })
    )
    expect(
      await executor.execute(proposeMarkRead(setUp, ["known", "missing"]))
    ).toEqual({ ok: false, code: "upstream_error" })
    expect(gmail.calls.every((call) => call.method === "GET")).toBe(true)
    expect(gmail.unread("known")).toBe(true)
  })
})

/** Records a consumed signed approval for an approval-tier intent, as the approval flow would. */
function approve({ db }: Setup, id: string): void {
  db.exec(
    "INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES ('credential','synthetic-public-key',0,'now')"
  )
  db.prepare(
    "INSERT INTO approval_nonces(nonce,intent_id,issued_at,used_at) VALUES ('nonce',?,'then','now')"
  ).run(id)
  db.prepare(
    "INSERT INTO approvals(intent_id,bundle_hash,decision,signature,credential_id,sign_count,nonce,decided_at) SELECT id,payload_hash,'approved','synthetic-signature','credential',0,'nonce','now' FROM intents WHERE id=?"
  ).run(id)
  db.prepare("UPDATE intents SET state='approved' WHERE id=?").run(id)
}

function proposeIntent({ db, policy }: Setup, intent: Intent) {
  const proposed = propose(db, policy, { intent, origin: "task" })
  if (!proposed.ok) throw new Error(proposed.code)
  return proposed
}

async function gmailExecutor(
  setUp: Setup,
  gmail: ReturnType<typeof fakeGmailApi>
) {
  return createExecutor(
    setUp.db,
    GMAIL_WRITERS,
    gmailWriteTransport({
      db: setUp.db,
      vault: await vaultWithToken(),
      fetch: gmail.send,
    })
  )
}

describe("Gmail write transport: label, archive and trash against a fake Gmail", () => {
  it("labels, records what changed, and undo restores each message's prior labels", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({
      a: ["INBOX", "UNREAD"],
      b: ["INBOX"],
    })
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId, tier } = proposeIntent(setUp, {
      kind: "email.label",
      connector: "gmail",
      args: { messageIds: ["a", "b"], add: ["Label_7"], remove: ["INBOX"] },
    })
    expect(tier).toBe("auto")
    expect(await executor.execute(intentId)).toEqual({
      ok: true,
      upstreamRef: null,
      result: { priorLabels: { a: ["INBOX", "UNREAD"], b: ["INBOX"] } },
    })
    expect(gmail.labels("a")).toEqual(["Label_7", "UNREAD"])
    expect(gmail.labels("b")).toEqual(["Label_7"])
    expect(inverseOp(setUp, intentId)).toBe(
      '{"args":{"add":["INBOX"],"messageIds":["a","b"],"remove":["Label_7"]},"connector":"gmail","kind":"email.label"}'
    )
    expect((await executor.undo(intentId)).ok).toBe(true)
    expect(gmail.labels("a")).toEqual(["INBOX", "UNREAD"])
    expect(gmail.labels("b")).toEqual(["INBOX"])
  })

  it("archives, and undo puts INBOX back only where it was", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ inInbox: ["INBOX"], elsewhere: ["Label_7"] })
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId, tier } = proposeIntent(setUp, {
      kind: "email.archive",
      connector: "gmail",
      args: { messageIds: ["inInbox", "elsewhere"] },
    })
    expect(tier).toBe("auto")
    expect((await executor.execute(intentId)).ok).toBe(true)
    expect(gmail.labels("inInbox")).toEqual([])
    expect(gmail.calls.at(-1)).toMatchObject({
      method: "POST",
      url: `https://${GMAIL_HOST}${GMAIL_BATCH_MODIFY_PATH}`,
    })
    expect(inverseOp(setUp, intentId)).toBe(
      '{"args":{"add":["INBOX"],"messageIds":["inInbox"]},"connector":"gmail","kind":"email.label"}'
    )
    expect((await executor.undo(intentId)).ok).toBe(true)
    expect(gmail.labels("inInbox")).toEqual(["INBOX"])
    expect(gmail.labels("elsewhere")).toEqual(["Label_7"])
  })

  it("trashes only with a signed approval, by the TRASH label, and records no undo", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ m: ["INBOX"] })
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId, tier } = proposeIntent(setUp, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["m"] },
    })
    expect(tier).toBe("approval")
    setUp.db
      .prepare("UPDATE intents SET state='approved' WHERE id=?")
      .run(intentId)
    expect(await executor.execute(intentId)).toEqual({
      ok: false,
      code: "missing_approval",
    })
    expect(gmail.calls).toEqual([])
    approve(setUp, intentId)
    expect(await executor.execute(intentId)).toEqual({
      ok: true,
      upstreamRef: null,
      result: {},
    })
    expect(gmail.labels("m")).toEqual(["INBOX", "TRASH"])
    // Trash reads nothing first: the one call is the write.
    expect(gmail.calls.map((call) => call.method)).toEqual(["POST"])
    expect(inverseOp(setUp, intentId)).toBeNull()
    expect(await executor.undo(intentId)).toEqual({
      ok: false,
      code: "undo_not_allowed",
    })
  })

  it("sends no DELETE and calls no delete endpoint across every write and undo", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({ m: ["INBOX", "UNREAD"] })
    const executor = await gmailExecutor(setUp, gmail)
    const intents: Intent[] = [
      {
        kind: "email.markRead",
        connector: "gmail",
        args: { messageIds: ["m"], read: true },
      },
      {
        kind: "email.label",
        connector: "gmail",
        args: { messageIds: ["m"], add: ["Label_7"] },
      },
      {
        kind: "email.archive",
        connector: "gmail",
        args: { messageIds: ["m"] },
      },
    ]
    for (const intent of intents) {
      const { intentId } = proposeIntent(setUp, intent)
      expect((await executor.execute(intentId)).ok).toBe(true)
      expect((await executor.undo(intentId)).ok).toBe(true)
    }
    const trash = proposeIntent(setUp, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["m"] },
    })
    approve(setUp, trash.intentId)
    expect((await executor.execute(trash.intentId)).ok).toBe(true)
    expect(gmail.calls.length).toBeGreaterThan(0)
    for (const call of gmail.calls) {
      expect(call.method).not.toBe("DELETE")
      expect(new URL(call.url).pathname).not.toMatch(/delete|emptyTrash/i)
    }
  })
})

describe("Gmail and Proton pinned together", () => {
  function pinProton(setUp: Setup): void {
    const operations = MAIL_OPS.filter((op) =>
      [
        "email.draft",
        "email.send",
        "email.reply",
        "email.forward",
        "email.trash",
      ].includes(op.intentKind ?? "")
    )
    signedPin(setUp.db, {
      ...manifest(PROTON_CONNECTOR, operations),
      auth: { type: "password", scopes: ["write"] },
      egress: { hosts: [] },
    })
  }

  it.each([
    ["gmail", 1, 0],
    [PROTON_CONNECTOR, 0, 1],
  ] as const)(
    "a trash proposed for %s reaches that connector's writer only",
    async (connector, gmailWrites, protonWrites) => {
      const setUp = pinnedGmail(true)
      pinProton(setUp)
      const gmail = fakeGmailApi({ m: ["INBOX"] })
      const viaGmail = gmailWriteTransport({
        db: setUp.db,
        vault: await vaultWithToken(),
        fetch: gmail.send,
      })
      const proton = vi.fn<WriteTransport>(() =>
        Promise.resolve({ upstreamRef: null, result: {} })
      )
      const executor = createExecutor(
        setUp.db,
        [...BRIDGE_WRITERS, ...GMAIL_WRITERS],
        (request) =>
          request.connector === "gmail" ? viaGmail(request) : proton(request)
      )
      // Without a connector the kind is ambiguous between the two.
      expect(
        propose(setUp.db, setUp.policy, {
          intent: { kind: "email.trash", args: { messageIds: ["m"] } },
          origin: "task",
        })
      ).toMatchObject({ ok: false })
      const { intentId } = proposeIntent(setUp, {
        kind: "email.trash",
        connector,
        args: { messageIds: ["m"] },
      })
      approve(setUp, intentId)
      expect((await executor.execute(intentId)).ok).toBe(true)
      expect(gmail.calls.filter((call) => call.method === "POST")).toHaveLength(
        gmailWrites
      )
      expect(proton).toHaveBeenCalledTimes(protonWrites)
      if (protonWrites === 1)
        expect(proton.mock.calls[0]?.[0]).toMatchObject({
          connector: PROTON_CONNECTOR,
          url: "bridge:imap/move-to-trash",
        })
    }
  )
})
