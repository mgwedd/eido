import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { simpleParser } from "mailparser"
import MailComposer from "nodemailer/lib/mail-composer"
import type { AddressObject } from "mailparser"
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
const PROFILE_PATH = "/gmail/v1/users/me/profile"
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const parsedAddresses = (
  value: AddressObject | AddressObject[] | undefined
): string[] => {
  const groups =
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  return groups.flatMap((group) =>
    group.value.map((entry) => entry.address ?? "")
  )
}

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
  for (const [kind, routes] of [
    ["email.draft", ["/gmail/v1/users/me/drafts"]],
    [
      "email.send",
      ["/gmail/v1/users/me/messages/send", "/gmail/v1/users/me/drafts/send"],
    ],
  ] as const) {
    const operation = gmail.operations.find((op) => op.intentKind === kind)
    if (operation === undefined) throw new Error(`fixture lacks ${kind}`)
    operation.routes = routes.map((pathPattern) => ({
      host: GMAIL_HOST,
      method: "POST",
      pathPattern,
    }))
  }
  const sendRoute = {
    host: GMAIL_HOST,
    method: "POST",
    pathPattern: "/gmail/v1/users/me/messages/send",
  } as const
  const reply = gmail.operations.find((op) => op.intentKind === "email.reply")
  if (reply === undefined) throw new Error("fixture lacks email.reply")
  reply.routes = [sendRoute]
  const forward = gmail.operations.find(
    (op) => op.intentKind === "email.forward"
  )
  if (forward === undefined) throw new Error("fixture lacks email.forward")
  forward.routes = [sendRoute]
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
    gmail.operations.push({
      name: "get_profile",
      effect: "read",
      reversibility: "reversible",
      defaultTier: "auto",
      sensitivity: "normal",
      untrustedOutput: true,
      authScopes: ["write"],
      routes: [{ host: GMAIL_HOST, method: "GET", pathPattern: PROFILE_PATH }],
    })
  }
  s = setup([gmail])
  return s
}

/** A fake Gmail API behind fetch: message id to labels; only batchModify changes them. */
function fakeGmailApi(
  labels: Record<string, string[]>,
  originals: Record<
    string,
    { id?: string; threadId?: unknown; raw?: unknown }
  > = {},
  profileEmail: string | null = "signed-sender@example.invalid",
  sendResponseId: string | null = "sent-message-1"
) {
  const mailbox = new Map(
    Object.entries(labels).map(([id, list]) => [id, new Set(list)])
  )
  const calls: Array<{ method: string; url: string; authorization: string }> =
    []
  const postedBodies: unknown[] = []
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
    if (method === "GET" && parsed.pathname === PROFILE_PATH)
      return Promise.resolve(
        Response.json(
          profileEmail === null ? {} : { emailAddress: profileEmail }
        )
      )
    const read = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(
      parsed.pathname
    )
    if (method === "GET" && read?.[1] !== undefined) {
      const id = decodeURIComponent(read[1])
      const original = originals[id]
      if (parsed.searchParams.get("format") === "raw" && original !== undefined)
        return Promise.resolve(
          Response.json({
            id: original.id ?? id,
            ...(original.threadId === undefined
              ? {}
              : { threadId: original.threadId }),
            ...(original.raw === undefined ? {} : { raw: original.raw }),
          })
        )
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
    if (
      method === "POST" &&
      [
        "/gmail/v1/users/me/drafts",
        "/gmail/v1/users/me/messages/send",
        "/gmail/v1/users/me/drafts/send",
      ].includes(parsed.pathname)
    ) {
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : ""
      )
      postedBodies.push(body)
      if (parsed.pathname.endsWith("/drafts"))
        return Promise.resolve(
          Response.json({ id: "draft-1", message: { id: "message-1" } })
        )
      return Promise.resolve(
        Response.json(sendResponseId === null ? {} : { id: sendResponseId })
      )
    }
    return Promise.resolve(new Response("{}", { status: 404 }))
  })
  return {
    send,
    calls,
    postedBodies,
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

async function originalMessageBytes(): Promise<Buffer> {
  const composer = new MailComposer({
    from: "Sender <sender@example.invalid>",
    to: "Signed sender <signed-sender@example.invalid>, Teammate <teammate@example.invalid>",
    cc: "Observer <observer@example.invalid>",
    replyTo: "Replies <replies@example.invalid>",
    subject: "Planning",
    text: "Original body text.",
    messageId: "<original-249@example.invalid>",
    references: "<earlier-249@example.invalid>",
    attachments: [
      {
        filename: "agenda.txt",
        content: "Original attachment text.",
        contentType: "text/plain",
      },
    ],
  }).compile()
  return Buffer.from(await composer.build())
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

describe("Gmail draft and send through fake Gmail", () => {
  it("creates a draft with the authenticated sender, returns both ids and records no inverse", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({})
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.draft",
      connector: "gmail",
      args: {
        to: ["person@example.invalid"],
        cc: ["copy@example.invalid"],
        bcc: ["blind@example.invalid"],
        subject: "A subject",
        body: "Draft body",
      },
    })
    const result = await executor.execute(intentId)
    expect(result).toEqual({
      ok: true,
      upstreamRef: "draft-1",
      result: { id: "draft-1", messageId: "message-1" },
    })
    expect(inverseOp(setUp, intentId)).toBeNull()
    const body = gmail.postedBodies[0]
    if (
      !isRecord(body) ||
      !isRecord(body["message"]) ||
      typeof body["message"]["raw"] !== "string"
    )
      throw new Error("fake Gmail did not receive draft MIME")
    const parsed = await simpleParser(
      Buffer.from(body["message"]["raw"], "base64url")
    )
    expect(parsedAddresses(parsed.from)).toEqual([
      "signed-sender@example.invalid",
    ])
    expect(parsedAddresses(parsed.to)).toEqual(["person@example.invalid"])
    expect(parsedAddresses(parsed.cc)).toEqual(["copy@example.invalid"])
    expect(parsedAddresses(parsed.bcc)).toEqual(["blind@example.invalid"])
    expect(parsed.text?.trim()).toBe("Draft body")
  })

  it("sends an existing draft with the approved MIME and records no inverse", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({})
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.send",
      connector: "gmail",
      args: {
        to: ["person@example.invalid"],
        subject: "Approved subject",
        body: "Approved body",
        draftId: "draft-approved",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(true)
    expect(inverseOp(setUp, intentId)).toBeNull()
    expect(gmail.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
    })
    const body = gmail.postedBodies[0]
    if (
      !isRecord(body) ||
      typeof body["id"] !== "string" ||
      !isRecord(body["message"]) ||
      typeof body["message"]["raw"] !== "string"
    )
      throw new Error("fake Gmail did not receive existing draft MIME")
    expect(body["id"]).toBe("draft-approved")
    const parsed = await simpleParser(
      Buffer.from(body["message"]["raw"], "base64url")
    )
    expect(parsedAddresses(parsed.from)).toEqual([
      "signed-sender@example.invalid",
    ])
    expect(parsedAddresses(parsed.to)).toEqual(["person@example.invalid"])
    expect(parsed.text?.trim()).toBe("Approved body")
  })

  it("replies in the verified original thread with approved recipients and RFC reply headers", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: true,
        to: ["replies@example.invalid"],
        cc: ["teammate@example.invalid", "observer@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(true)
    expect(inverseOp(setUp, intentId)).toBeNull()
    const send = gmail.calls.at(-1)
    expect(send).toMatchObject({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    })
    const sent = gmail.postedBodies.at(-1)
    if (!isRecord(sent) || typeof sent["raw"] !== "string")
      throw new Error("fake Gmail did not receive reply MIME")
    expect(sent["threadId"]).toBe("thread-249")
    const parsed = await simpleParser(Buffer.from(sent["raw"], "base64url"))
    expect(parsedAddresses(parsed.from)).toEqual([
      "signed-sender@example.invalid",
    ])
    expect(parsedAddresses(parsed.to)).toEqual(["replies@example.invalid"])
    expect(parsedAddresses(parsed.cc)).toEqual([
      "teammate@example.invalid",
      "observer@example.invalid",
    ])
    expect(parsed.headers.get("in-reply-to")).toBe(
      "<original-249@example.invalid>"
    )
    expect(parsed.headers.get("references")).toEqual([
      "<earlier-249@example.invalid>",
      "<original-249@example.invalid>",
    ])
    expect(parsed.text?.trim()).toBe("Approved reply body.")
  })

  it("preserves multiple RFC References headers when replying", async () => {
    const setUp = pinnedGmail(true)
    const original = Buffer.from(
      "From: sender@example.invalid\r\nTo: signed-sender@example.invalid\r\n" +
        "Message-ID: <original@example.invalid>\r\n" +
        "References: <earlier@example.invalid>\r\n" +
        "References: <another@example.invalid>\r\n\r\nOriginal body.\r\n"
    )
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: false,
        to: ["sender@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(true)
    const sent = gmail.postedBodies[0]
    if (typeof sent !== "object" || sent === null || !("raw" in sent))
      throw new Error("fake Gmail did not receive reply MIME")
    const parsed = await simpleParser(
      Buffer.from(String(sent.raw), "base64url")
    )
    expect(parsed.headers.get("references")).toEqual([
      "<earlier@example.invalid>",
      "<another@example.invalid>",
      "<original@example.invalid>",
    ])
  })

  it("forwards the exact verified original RFC message, including attachments, without file access", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          raw: original.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.forward",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        to: ["colleague@example.invalid"],
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(true)
    expect(inverseOp(setUp, intentId)).toBeNull()
    const sent = gmail.postedBodies.at(-1)
    if (!isRecord(sent) || typeof sent["raw"] !== "string")
      throw new Error("fake Gmail did not receive forward MIME")
    const parsed = await simpleParser(Buffer.from(sent["raw"], "base64url"))
    expect(parsedAddresses(parsed.from)).toEqual([
      "signed-sender@example.invalid",
    ])
    expect(parsedAddresses(parsed.to)).toEqual(["colleague@example.invalid"])
    expect(parsed.text).toContain("Subject: Planning")
    expect(parsed.text).toContain("Original body text.")
    const forwardedAttachment = parsed.attachments.find(
      (item) => item.filename === "agenda.txt"
    )
    if (forwardedAttachment === undefined)
      throw new Error("forward omitted the original attachment")
    expect(forwardedAttachment.content.toString("utf8")).toBe(
      "Original attachment text."
    )
  })

  it("refuses a reply when the source message no longer matches its approved hash", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const altered = Buffer.from(original)
    altered[0] = altered[0] === 65 ? 66 : 65
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: altered.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: false,
        to: ["replies@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
    expect(inverseOp(setUp, intentId)).toBeUndefined()
  })

  it("refuses reply recipients that differ from the source-derived approved recipients", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: false,
        to: ["attacker@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
  })

  it("keeps a reply in the verified thread when the original lacks RFC thread headers", async () => {
    const setUp = pinnedGmail(true)
    const original = Buffer.from(
      "From: sender@example.invalid\r\nTo: signed-sender@example.invalid\r\n\r\nMessage without a subject or Message-ID.\r\n"
    )
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: false,
        to: ["sender@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(true)
    const sent = gmail.postedBodies.at(-1)
    if (!isRecord(sent) || typeof sent["raw"] !== "string")
      throw new Error("fake Gmail did not receive reply MIME")
    expect(sent["threadId"]).toBe("thread-249")
    const parsed = await simpleParser(Buffer.from(sent["raw"], "base64url"))
    expect(parsed.subject).toBe("Re:")
    expect(parsed.headers.get("in-reply-to")).toBeUndefined()
    expect(parsed.headers.get("references")).toBeUndefined()
  })

  it("refuses to send a reply that cannot be placed in a Gmail thread", async () => {
    const setUp = pinnedGmail(true)
    const original = Buffer.from(
      "From: sender@example.invalid\r\nTo: signed-sender@example.invalid\r\n\r\nMessage without thread metadata.\r\n"
    )
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": { raw: original.toString("base64url") },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: false,
        to: ["sender@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
  })

  it("refuses original-message data returned for a different Gmail id", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          id: "different-message",
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.forward",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        to: ["colleague@example.invalid"],
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
  })

  it("refuses a reply when Gmail has no authenticated sender identity", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      },
      null
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.reply",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        replyAll: false,
        to: ["replies@example.invalid"],
        body: "Approved reply body.",
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
  })

  it("refuses malformed raw-message data from Gmail", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": { threadId: "thread-249" },
      }
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.forward",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        to: ["colleague@example.invalid"],
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
  })

  it("rejects a Gmail send response without a message id", async () => {
    const setUp = pinnedGmail(true)
    const original = await originalMessageBytes()
    const gmail = fakeGmailApi(
      {},
      {
        "original-249": {
          threadId: "thread-249",
          raw: original.toString("base64url"),
        },
      },
      "signed-sender@example.invalid",
      null
    )
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.forward",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(original),
        to: ["colleague@example.invalid"],
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toHaveLength(1)
  })

  it.each([
    ["a non-string raw message", { threadId: "thread-249", raw: 23 }],
    ["a non-string thread id", { threadId: 23, raw: "not-used" }],
  ])("refuses %s from Gmail", async (_description, source) => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({}, { "original-249": source })
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId } = proposeIntent(setUp, {
      kind: "email.forward",
      connector: "gmail",
      args: {
        messageId: "original-249",
        messageSha256: sha256(Buffer.from("verified original")),
        to: ["colleague@example.invalid"],
      },
    })
    approve(setUp, intentId)
    expect((await executor.execute(intentId)).ok).toBe(false)
    expect(gmail.postedBodies).toEqual([])
  })
})

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
