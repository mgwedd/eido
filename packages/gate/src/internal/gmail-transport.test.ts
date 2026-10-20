import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectorManifest } from "@eido/schemas"
import { createExecutor } from "./executor"
import { gmailWriteTransport } from "./gmail-transport"
import {
  GMAIL_BATCH_MODIFY_PATH,
  GMAIL_HOST,
  gmailMarkReadWriter,
} from "./gmail-writers"
import { propose } from "./intents"
import { MAIL_OPS, manifest, setup } from "./test-fixtures"
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
  const markRead = gmail.operations.find(
    (op) => op.intentKind === "email.markRead"
  )
  if (markRead === undefined) throw new Error("fixture lacks mark read")
  markRead.routes = [
    { host: GMAIL_HOST, method: "POST", pathPattern: GMAIL_BATCH_MODIFY_PATH },
  ]
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
      '{"args":{"messageIds":["wasUnread"],"read":false},"kind":"email.markRead"}'
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
