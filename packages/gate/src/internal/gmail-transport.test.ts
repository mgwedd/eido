import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { simpleParser } from "mailparser"
import MailComposer from "nodemailer/lib/mail-composer"
import type { AddressObject } from "mailparser"
import type { ConnectorManifest, Intent } from "@eido/schemas"
import { PROTON_CONNECTOR } from "./bridge/config"
import { createExecutor } from "./executor"
import type { WriteTransport } from "./executor"
import { gmailProbe, gmailWriteTransport } from "./gmail-transport"
import { BRIDGE_WRITERS } from "./bridge/writers"
import {
  GMAIL_BATCH_MODIFY_PATH,
  GMAIL_HOST,
  GMAIL_WRITERS,
  gmailMarkReadWriter,
} from "./gmail-writers"
import { propose } from "./intents"
import { dataPlaneHandler } from "./routes"
import { MAIL_OPS, manifest, setup, signedPin } from "./test-fixtures"
import {
  assertion,
  deviceChallenge,
  testAuthenticator,
  WEBAUTHN,
} from "./test-fixtures"
import { issueNonce } from "./approvals"
import { beginLogin, login, SESSION_COOKIE } from "./sessions"
import { phoneHandler } from "./phone-routes"
import {
  validateGateIntentStatus,
  validateGatePrepareApproval,
  validateGateProposeResult,
} from "@eido/schemas"
import { payloadHash } from "./canonical"
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
    "email.untrash",
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
  const approvalNo =
    Number(
      db.prepare("SELECT count(*) AS count FROM approvals").get()?.["count"] ??
        0
    ) + 1
  const credentialId = `credential-${approvalNo}`
  const nonce = `nonce-${approvalNo}`
  db.exec(
    `INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES ('${credentialId}','synthetic-public-key',0,'now')`
  )
  db.prepare(
    "INSERT INTO approval_nonces(nonce,intent_id,issued_at,used_at) VALUES (?,?,'then','now')"
  ).run(nonce, id)
  db.prepare(
    "INSERT INTO approvals(intent_id,bundle_hash,decision,signature,credential_id,sign_count,nonce,decided_at) SELECT id,payload_hash,'approved','synthetic-signature',?,0,?,'now' FROM intents WHERE id=?"
  ).run(credentialId, nonce, id)
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

  it.each([null, ""])(
    "refuses to create a draft without an authenticated sender (%s)",
    async (sender) => {
      const setUp = pinnedGmail(true)
      const gmail = fakeGmailApi({}, {}, sender)
      const executor = await gmailExecutor(setUp, gmail)
      const { intentId } = proposeIntent(setUp, {
        kind: "email.draft",
        connector: "gmail",
        args: {
          to: ["person@example.invalid"],
          subject: "Approved subject",
          body: "Approved body",
        },
      })
      expect((await executor.execute(intentId)).ok).toBe(false)
      expect(
        gmail.calls.some(
          (call) => call.method === "GET" && call.url.endsWith("/profile")
        )
      ).toBe(true)
      expect(gmail.postedBodies).toEqual([])
    }
  )

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

  it("restores trashed messages from their authenticated prior labels with a fresh approval", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({
      m: ["INBOX", "UNREAD"],
      elsewhere: ["Label_7"],
      already: ["TRASH", "Label_9"],
    })
    const executor = await gmailExecutor(setUp, gmail)
    const { intentId, tier } = proposeIntent(setUp, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["m", "elsewhere", "already"] },
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
      result: {
        priorLabels: {
          m: ["INBOX", "UNREAD"],
          elsewhere: ["Label_7"],
          already: ["TRASH", "Label_9"],
        },
      },
    })
    expect(gmail.labels("m")).toEqual(["INBOX", "TRASH", "UNREAD"])
    expect(gmail.calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
    ])
    expect(inverseOp(setUp, intentId)).toBeNull()
    expect(await executor.undo(intentId)).toEqual({
      ok: false,
      code: "undo_not_allowed",
    })
    let pendingNotifications = 0
    const response = await dataPlaneHandler(() => ({
      db: setUp.db,
      policy: setUp.policy,
      notifyPending: () => {
        pendingNotifications += 1
      },
    }))({
      method: "POST",
      path: `/intents/${intentId}/restore`,
      query: new URLSearchParams(),
      headers: {},
      body: () => Promise.resolve({ ok: true, text: "{}" }),
    })
    expect(response.status).toBe(201)
    expect(pendingNotifications).toBe(1)
    if (!isRecord(response.body) || typeof response.body["id"] !== "string")
      throw new Error("restore route did not propose an intent")
    const restoreId = response.body["id"]
    const restoreRow = setUp.db
      .prepare("SELECT payload_json, tier FROM intents WHERE id=?")
      .get(restoreId)
    expect(restoreRow?.["tier"]).toBe("approval")
    expect(JSON.parse(String(restoreRow?.["payload_json"]))).toMatchObject({
      kind: "email.untrash",
      connector: "gmail",
      args: {
        sourceIntentId: intentId,
        messageIds: ["m", "elsewhere", "already"],
        priorLabels: [
          { messageId: "m", labels: ["INBOX", "UNREAD"] },
          { messageId: "elsewhere", labels: ["Label_7"] },
          { messageId: "already", labels: ["TRASH", "Label_9"] },
        ],
      },
    })
    expect(await executor.execute(restoreId)).toEqual({
      ok: false,
      code: "invalid_state",
    })
    setUp.db
      .prepare("UPDATE intents SET tier='auto', state='proposed' WHERE id=?")
      .run(restoreId)
    expect(await executor.execute(restoreId)).toEqual({
      ok: false,
      code: "invalid_state",
    })
    setUp.db
      .prepare("UPDATE intents SET tier='approval', state='pending' WHERE id=?")
      .run(restoreId)
    expect(gmail.labels("m")).toContain("TRASH")
    approve(setUp, restoreId)
    expect(await executor.execute(restoreId)).toEqual({
      ok: true,
      upstreamRef: null,
      result: {},
    })
    expect(gmail.labels("m")).toEqual(["INBOX", "UNREAD"])
    expect(gmail.labels("elsewhere")).toEqual(["Label_7"])
    expect(gmail.labels("already")).toEqual(["Label_9", "TRASH"])
    expect(gmail.calls.slice(-3).map((call) => call.method)).toEqual([
      "POST",
      "POST",
      "POST",
    ])
    expect(
      setUp.db.prepare("SELECT count(*) AS count FROM approvals").get()?.[
        "count"
      ]
    ).toBe(2)
    const forged = proposeIntent(setUp, {
      kind: "email.untrash",
      connector: "gmail",
      args: {
        sourceIntentId: intentId,
        messageIds: ["m", "elsewhere", "already"],
        priorLabels: [
          { messageId: "m", labels: ["INBOX"] },
          { messageId: "elsewhere", labels: ["Label_7"] },
          { messageId: "already", labels: ["TRASH", "Label_9"] },
        ],
      },
    })
    approve(setUp, forged.intentId)
    const callsBeforeForgery = gmail.calls.length
    expect(await executor.execute(forged.intentId)).toEqual({
      ok: false,
      code: "invalid_restore_source",
    })
    expect(gmail.calls).toHaveLength(callsBeforeForgery)
    const wrongMessages = proposeIntent(setUp, {
      kind: "email.untrash",
      connector: "gmail",
      args: {
        sourceIntentId: intentId,
        messageIds: ["m", "elsewhere", "invented"],
        priorLabels: [
          { messageId: "m", labels: ["INBOX", "UNREAD"] },
          { messageId: "elsewhere", labels: ["Label_7"] },
          { messageId: "invented", labels: [] },
        ],
      },
    })
    approve(setUp, wrongMessages.intentId)
    expect(await executor.execute(wrongMessages.intentId)).toEqual({
      ok: false,
      code: "invalid_restore_source",
    })
    expect(gmail.calls).toHaveLength(callsBeforeForgery)
    const wrongSource = proposeIntent(setUp, {
      kind: "email.untrash",
      connector: "gmail",
      args: {
        sourceIntentId: "unknown-trash-id",
        messageIds: ["m", "elsewhere", "already"],
        priorLabels: [
          { messageId: "m", labels: ["INBOX", "UNREAD"] },
          { messageId: "elsewhere", labels: ["Label_7"] },
          { messageId: "already", labels: ["TRASH", "Label_9"] },
        ],
      },
    })
    approve(setUp, wrongSource.intentId)
    expect(await executor.execute(wrongSource.intentId)).toEqual({
      ok: false,
      code: "invalid_restore_source",
    })
    expect(gmail.calls).toHaveLength(callsBeforeForgery)
    const sourcePayload = String(
      setUp.db
        .prepare("SELECT payload_json FROM intents WHERE id=?")
        .get(intentId)?.["payload_json"]
    )
    const unavailableHandler = dataPlaneHandler(() => ({
      db: setUp.db,
      policy: setUp.policy,
    }))
    const missingReport = proposeIntent(setUp, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["unreported"] },
    })
    approve(setUp, missingReport.intentId)
    const emptyReportExecutor = createExecutor(setUp.db, GMAIL_WRITERS, () =>
      Promise.resolve({ upstreamRef: null, result: { priorLabels: {} } })
    )
    expect((await emptyReportExecutor.execute(missingReport.intentId)).ok).toBe(
      true
    )
    expect(
      (
        await unavailableHandler({
          method: "POST",
          path: `/intents/${missingReport.intentId}/restore`,
          query: new URLSearchParams(),
          headers: {},
          body: () => Promise.resolve({ ok: true, text: "{}" }),
        })
      ).status
    ).toBe(409)
    const oversizedPrior = proposeIntent(setUp, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["many-labels"] },
    })
    approve(setUp, oversizedPrior.intentId)
    const manyLabels = Array.from(
      { length: 101 },
      (_, index) => `Label_${index}`
    )
    const oversizedReceiptExecutor = createExecutor(
      setUp.db,
      GMAIL_WRITERS,
      () =>
        Promise.resolve({
          upstreamRef: null,
          result: { priorLabels: { "many-labels": manyLabels } },
        })
    )
    expect(
      (await oversizedReceiptExecutor.execute(oversizedPrior.intentId)).ok
    ).toBe(true)
    expect(
      (
        await unavailableHandler({
          method: "POST",
          path: `/intents/${oversizedPrior.intentId}/restore`,
          query: new URLSearchParams(),
          headers: {},
          body: () => Promise.resolve({ ok: true, text: "{}" }),
        })
      ).status
    ).toBe(409)
    setUp.db
      .prepare("UPDATE intents SET payload_json='{' WHERE id=?")
      .run(intentId)
    expect(
      (
        await unavailableHandler({
          method: "POST",
          path: `/intents/${intentId}/restore`,
          query: new URLSearchParams(),
          headers: {},
          body: () => Promise.resolve({ ok: true, text: "{}" }),
        })
      ).status
    ).toBe(409)
    setUp.db
      .prepare("UPDATE intents SET payload_json=? WHERE id=?")
      .run(sourcePayload, intentId)
    const sourceObject: unknown = JSON.parse(sourcePayload)
    if (!isRecord(sourceObject) || !isRecord(sourceObject["args"]))
      throw new Error("trash proposal payload missing args")
    const changedSource = JSON.stringify({
      ...sourceObject,
      connector: "proton-mail",
    })
    setUp.db
      .prepare("UPDATE intents SET payload_json=? WHERE id=?")
      .run(changedSource, intentId)
    expect(
      (
        await unavailableHandler({
          method: "POST",
          path: `/intents/${intentId}/restore`,
          query: new URLSearchParams(),
          headers: {},
          body: () => Promise.resolve({ ok: true, text: "{}" }),
        })
      ).status
    ).toBe(409)
    setUp.db
      .prepare("UPDATE intents SET payload_json=? WHERE id=?")
      .run(sourcePayload, intentId)
    setUp.db
      .prepare("UPDATE executions SET result='{}' WHERE intent_id=?")
      .run(intentId)
    const corruptedReceipt = await unavailableHandler({
      method: "POST",
      path: `/intents/${intentId}/restore`,
      query: new URLSearchParams(),
      headers: {},
      body: () => Promise.resolve({ ok: true, text: "{}" }),
    })
    expect(corruptedReceipt.status).toBe(409)
    const unexecutedSource = proposeIntent(setUp, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["still-in-inbox"] },
    })
    const prematureRestore = proposeIntent(setUp, {
      kind: "email.untrash",
      connector: "gmail",
      args: {
        sourceIntentId: unexecutedSource.intentId,
        messageIds: ["still-in-inbox"],
        priorLabels: [{ messageId: "still-in-inbox", labels: ["INBOX"] }],
      },
    })
    approve(setUp, prematureRestore.intentId)
    const callsBeforePremature = gmail.calls.length
    expect(await executor.execute(prematureRestore.intentId)).toEqual({
      ok: false,
      code: "invalid_restore_source",
    })
    expect(gmail.calls).toHaveLength(callsBeforePremature)
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

async function draftDiscardFixture(draftResult?: Record<string, unknown>) {
  const setUp = pinnedGmail(true)
  const gmail = fakeGmailApi({ "message-1": ["DRAFT"], unrelated: ["INBOX"] })
  const transport = gmailWriteTransport({
    db: setUp.db,
    vault: await vaultWithToken(),
    fetch: gmail.send,
  })
  const executor = createExecutor(setUp.db, GMAIL_WRITERS, async (request) => {
    const result = await transport(request)
    return request.intentKind === "email.draft" && draftResult !== undefined
      ? { ...result, result: draftResult }
      : result
  })
  const draft = proposeIntent(setUp, {
    kind: "email.draft",
    connector: "gmail",
    args: {
      to: ["recipient@example.invalid"],
      subject: "Synthetic draft",
      body: "Private draft body",
    },
  })
  expect((await executor.execute(draft.intentId)).ok).toBe(true)
  const auth = testAuthenticator()
  setUp.db
    .prepare(
      "INSERT INTO credentials(credential_id,public_key,sign_count,created_at) VALUES (?,?,0,?)"
    )
    .run(auth.credentialId, auth.publicKey, new Date().toISOString())
  const now = () => new Date()
  const begun = beginLogin(setUp.db, now)
  const session = login(
    setUp.db,
    WEBAUTHN,
    assertion(auth, begun.challenge),
    now
  )
  if (!session.ok) throw new Error("login refused")
  const notifyPending = vi.fn()
  const handler = phoneHandler({
    gate: () => ({
      ...setUp,
      webAuthn: WEBAUTHN,
      push: {
        publicKey: () => Promise.resolve("synthetic"),
        notifyPending,
        notifyRecovery: () => Promise.resolve(),
      },
    }),
    allowedHosts: ["eido.example.invalid"],
    basePath: "/api/gate",
    now,
    execute: (id) => executor.execute(id),
    undo: (id) => executor.undo(id),
  })
  const call = (
    path = `/executions/${draft.intentId}/discard-draft`,
    body: unknown = {},
    signedIn = true
  ) =>
    handler({
      method: "POST",
      path: `/api/gate${path}`,
      query: new URLSearchParams(),
      headers: {
        host: "eido.example.invalid",
        contentType: "application/json",
        ...(signedIn ? { cookie: `${SESSION_COOKIE}=${session.token}` } : {}),
      },
      body: () => Promise.resolve({ ok: true, text: JSON.stringify(body) }),
    })
  return { ...setUp, gmail, executor, draft, auth, call, notifyPending }
}

describe("Gmail draft discard through the phone approval flow", () => {
  it("proposes only the receipt's message, and moves it to Trash only after a signed approval", async () => {
    const f = await draftDiscardFixture()
    const initialCalls = f.gmail.calls.length
    const response = await f.call()
    expect(response.status).toBe(201)
    const proposed = validateGateProposeResult(response.body)
    if (!proposed.ok) throw new Error("invalid proposal response")
    expect(proposed.value).toMatchObject({ tier: "approval", state: "pending" })
    const id = proposed.value.id
    const row = f.db
      .prepare("SELECT payload_json FROM intents WHERE id=?")
      .get(id)
    expect(JSON.parse(String(row?.["payload_json"]))).toEqual({
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["message-1"] },
    })
    expect(f.notifyPending).toHaveBeenCalledTimes(1)
    expect(await f.executor.execute(id)).toEqual({
      ok: false,
      code: "invalid_state",
    })
    expect(f.gmail.calls).toHaveLength(initialCalls)
    expect(f.gmail.labels("message-1")).toEqual(["DRAFT"])
    expect(await f.executor.undo(f.draft.intentId)).toEqual({
      ok: false,
      code: "no_inverse",
    })
    const prepared = validateGatePrepareApproval(
      (await f.call(`/approvals/${id}/nonce`)).body
    )
    if (!prepared.ok) throw new Error("invalid approval preparation")
    const approved = await f.call(`/approvals/${id}/decision`, {
      intentId: id,
      decision: "approved",
      nonce: prepared.value.nonce,
      assertion: assertion(
        f.auth,
        deviceChallenge(prepared.value.payloadHash, id, prepared.value.nonce)
      ),
    })
    expect(approved.status).toBe(200)
    expect(f.gmail.labels("message-1")).toEqual(["DRAFT", "TRASH"])
    expect(f.gmail.labels("unrelated")).toEqual(["INBOX"])
    expect(
      f.gmail.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.url)
    ).toEqual([
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
    ])
    const posted = f.gmail.send.mock.lastCall?.[1]?.body
    if (typeof posted !== "string")
      throw new Error("missing Trash request body")
    expect(JSON.parse(posted)).toEqual({
      ids: ["message-1"],
      addLabelIds: ["TRASH"],
    })
  })

  it("refuses unsigned approval without a Gmail call", async () => {
    const f = await draftDiscardFixture()
    const proposed = validateGateProposeResult((await f.call()).body)
    if (!proposed.ok) throw new Error("invalid proposal")
    const prepared = issueNonce(f.db, proposed.value.id)
    if (!prepared.ok) throw new Error("prepare refused")
    const before = f.gmail.calls.length
    const response = await f.call(`/approvals/${proposed.value.id}/decision`, {
      intentId: proposed.value.id,
      decision: "approved",
      nonce: prepared.nonce,
      assertion: assertion(
        testAuthenticator(),
        deviceChallenge(prepared.payloadHash, proposed.value.id, prepared.nonce)
      ),
    })
    expect(response.status).toBe(403)
    expect(f.gmail.calls).toHaveLength(before)
    expect(f.gmail.labels("message-1")).toEqual(["DRAFT"])
  })

  it.each([
    null,
    [],
    { messageId: "unrelated" },
    { intent: { kind: "email.trash" } },
  ])("rejects a nonempty or invalid body %j", async (body) => {
    const f = await draftDiscardFixture()
    const before = f.gmail.calls.length
    expect((await f.call(undefined, body)).status).toBe(400)
    expect(f.gmail.calls).toHaveLength(before)
    expect(
      f.db.prepare("SELECT id FROM intents WHERE kind='email.trash'").all()
    ).toEqual([])
  })

  it("requires a session and bounds the execution id", async () => {
    const f = await draftDiscardFixture()
    expect((await f.call(undefined, {}, false)).status).toBe(401)
    expect(
      (await f.call(`/executions/${"a".repeat(65)}/discard-draft`)).status
    ).toBe(400)
  })

  it.each([
    "unknown",
    "not_executed",
    "wrong_kind",
    "bad_payload",
    "changed_payload",
    "wrong_connector",
    "changed_receipt",
    "missing_receipt",
    "missing_message",
    "wrong_draft_id",
    "invalid_message",
    "auto_trash",
  ])("refuses %s sources without proposing Trash", async (scenario) => {
    const draftResult =
      scenario === "missing_message"
        ? { id: "draft-1" }
        : scenario === "wrong_draft_id"
          ? { id: "other-draft", messageId: "message-1" }
          : scenario === "invalid_message"
            ? { id: "draft-1", messageId: "" }
            : undefined
    const f = await draftDiscardFixture(draftResult)
    const id = f.draft.intentId
    if (scenario === "not_executed")
      f.db.prepare("UPDATE intents SET state='failed' WHERE id=?").run(id)
    if (scenario === "wrong_kind")
      f.db.prepare("UPDATE intents SET kind='email.send' WHERE id=?").run(id)
    if (scenario === "bad_payload")
      f.db.prepare("UPDATE intents SET payload_json='{' WHERE id=?").run(id)
    if (scenario === "changed_payload")
      f.db
        .prepare("UPDATE intents SET payload_hash=? WHERE id=?")
        .run("0".repeat(64), id)
    if (scenario === "wrong_connector") {
      const payload = {
        kind: "email.draft",
        connector: "proton",
        args: {
          to: ["r@example.invalid"],
          subject: "Synthetic",
          body: "Synthetic",
        },
      }
      f.db
        .prepare("UPDATE intents SET payload_json=?,payload_hash=? WHERE id=?")
        .run(JSON.stringify(payload), payloadHash(payload), id)
    }
    if (scenario === "changed_receipt")
      f.db
        .prepare("UPDATE executions SET result=? WHERE intent_id=?")
        .run(JSON.stringify({ id: "draft-1", messageId: "unrelated" }), id)
    if (scenario === "missing_receipt")
      f.db.prepare("DELETE FROM executions WHERE intent_id=?").run(id)
    if (scenario === "auto_trash")
      f.policy.shipped.tiers["email.trash"] = "auto"
    const before = f.gmail.calls.length
    const response = await f.call(
      scenario === "unknown" ? "/executions/missing/discard-draft" : undefined
    )
    expect(response.status).toBe(409)
    expect(f.gmail.calls).toHaveLength(before)
    expect(
      f.db.prepare("SELECT id FROM intents WHERE kind='email.trash'").all()
    ).toEqual([])
  })
})

describe("a draft's discarded status (#549)", () => {
  async function discarded(f: Awaited<ReturnType<typeof draftDiscardFixture>>) {
    const response = await dataPlaneHandler(() => ({
      db: f.db,
      policy: f.policy,
    }))({
      method: "GET",
      path: `/intents/${f.draft.intentId}`,
      query: new URLSearchParams(),
      headers: {},
      body: () => Promise.resolve({ ok: true, text: "" }),
    })
    const status = validateGateIntentStatus(response.body)
    if (!status.ok) throw new Error("invalid status response")
    return status.value.discarded
  }

  async function proposedDiscard(
    f: Awaited<ReturnType<typeof draftDiscardFixture>>
  ) {
    const proposed = validateGateProposeResult((await f.call()).body)
    if (!proposed.ok) throw new Error("invalid proposal")
    return proposed.value.id
  }

  it("is false while the discard is pending, and true once it executed", async () => {
    const f = await draftDiscardFixture()
    expect(await discarded(f)).toBe(false)
    const trash = await proposedDiscard(f)
    expect(await discarded(f)).toBe(false)
    approve(f, trash)
    expect((await f.executor.execute(trash)).ok).toBe(true)
    expect(await discarded(f)).toBe(true)
  })

  it("is false when the discard was rejected or failed", async () => {
    const f = await draftDiscardFixture()
    const trash = await proposedDiscard(f)
    for (const state of ["rejected", "failed"]) {
      f.db.prepare("UPDATE intents SET state=? WHERE id=?").run(state, trash)
      expect(await discarded(f)).toBe(false)
    }
  })

  it("is false again once the discarded draft was restored from Trash", async () => {
    const f = await draftDiscardFixture()
    const trash = await proposedDiscard(f)
    approve(f, trash)
    expect((await f.executor.execute(trash)).ok).toBe(true)
    const restored = validateGateProposeResult(
      (
        await dataPlaneHandler(() => ({ db: f.db, policy: f.policy }))({
          method: "POST",
          path: `/intents/${trash}/restore`,
          query: new URLSearchParams(),
          headers: {},
          body: () => Promise.resolve({ ok: true, text: "{}" }),
        })
      ).body
    )
    if (!restored.ok) throw new Error("invalid restore proposal")
    expect(await discarded(f)).toBe(true)
    approve(f, restored.value.id)
    expect((await f.executor.execute(restored.value.id)).ok).toBe(true)
    expect(f.gmail.labels("message-1")).toEqual(["DRAFT"])
    expect(await discarded(f)).toBe(false)
  })

  it("ignores a trash of another message", async () => {
    const f = await draftDiscardFixture()
    const other = proposeIntent(f, {
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: ["unrelated"] },
    })
    approve(f, other.intentId)
    expect((await f.executor.execute(other.intentId)).ok).toBe(true)
    expect(await discarded(f)).toBe(false)
  })

  it.each(["not_executed", "wrong_kind", "missing_message"])(
    "is false for a %s source even after its message was trashed",
    async (scenario) => {
      const f = await draftDiscardFixture(
        scenario === "missing_message" ? { id: "draft-1" } : undefined
      )
      const trash = proposeIntent(f, {
        kind: "email.trash",
        connector: "gmail",
        args: { messageIds: ["message-1"] },
      })
      approve(f, trash.intentId)
      expect((await f.executor.execute(trash.intentId)).ok).toBe(true)
      const id = f.draft.intentId
      if (scenario === "not_executed")
        f.db.prepare("UPDATE intents SET state='failed' WHERE id=?").run(id)
      if (scenario === "wrong_kind")
        f.db.prepare("UPDATE intents SET kind='email.send' WHERE id=?").run(id)
      expect(await discarded(f)).toBe(false)
    }
  )
})

describe("gmailProbe", () => {
  const url = (input: string | URL | Request) =>
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url

  async function reconnectedVault(): Promise<InMemoryVault> {
    const vault = new InMemoryVault()
    await vault.set(
      { connector: "gmail", kind: "refresh_token", client: "write" },
      "test-refresh-token"
    )
    await vault.set(
      { connector: "gmail", kind: "api_key", client: "write" },
      "test-client-secret"
    )
    return vault
  }

  it("is ok when the profile reads with the stored write token", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({})
    const probe = gmailProbe({
      db: setUp.db,
      vault: await vaultWithToken(),
      fetch: gmail.send,
    })
    expect(await probe()).toBe("ok")
    expect(gmail.calls).toEqual([
      {
        method: "GET",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        authorization: `Bearer ${TOKEN}`,
      },
    ])
  })

  it("refreshes from a new refresh token when no access token is cached", async () => {
    const setUp = pinnedGmail(true)
    const gmail = fakeGmailApi({})
    const vault = await reconnectedVault()
    const send = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (url(input) === "https://oauth2.googleapis.com/token")
        return Promise.resolve(
          Response.json({ access_token: "test-new-token" })
        )
      const authorization = new Headers(init?.headers).get("authorization")
      if (authorization !== "Bearer test-new-token")
        return Promise.resolve(new Response(null, { status: 401 }))
      return gmail.send(input, init)
    })
    const probe = gmailProbe({
      db: setUp.db,
      vault,
      fetch: send,
      clientId: "test-client-id",
    })
    expect(await probe()).toBe("ok")
    expect(
      await vault.get({
        connector: "gmail",
        kind: "access_token",
        client: "write",
      })
    ).toBe("test-new-token")
  })

  it("reports a refused grant as auth_failed", async () => {
    const setUp = pinnedGmail(true)
    const send = vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        url(input) === "https://oauth2.googleapis.com/token"
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : new Response(null, { status: 401 })
      )
    )
    const probe = gmailProbe({
      db: setUp.db,
      vault: await reconnectedVault(),
      fetch: send,
      clientId: "test-client-id",
    })
    expect(await probe()).toBe("auth_failed")
  })

  it("reports a failing Gmail as unavailable", async () => {
    const setUp = pinnedGmail(true)
    const send = vi.fn(() =>
      Promise.resolve(new Response("{}", { status: 500 }))
    )
    const probe = gmailProbe({
      db: setUp.db,
      vault: await vaultWithToken(),
      fetch: send,
    })
    expect(await probe()).toBe("unavailable")
  })
})
