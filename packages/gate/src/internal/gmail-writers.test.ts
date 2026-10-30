import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Intent } from "@eido/schemas"
import { issueNonce, verifyApproval } from "./approvals"
import { beginRegistration, registerCredential } from "./credentials"
import { createExecutor } from "./executor"
import type { WriteRequest } from "./executor"
import {
  GMAIL_BATCH_MODIFY_PATH,
  GMAIL_HOST,
  GMAIL_WRITERS,
  gmailArchiveWriter,
  gmailLabelWriter,
  gmailMarkReadWriter,
  gmailTrashWriter,
  gmailDraftWriter,
  gmailSendWriter,
} from "./gmail-writers"
import { intentHistory, intentSummary, propose } from "./intents"
import {
  MAIL_OPS,
  WEBAUTHN,
  assertion,
  auditRows,
  deviceChallenge,
  manifest,
  registration,
  sample,
  setup,
  testAuthenticator,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

const URL_ =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify"

/** A pinned Gmail connector with the manifest's shared batchModify and message read routes. */
function pinnedGmail(): Setup {
  const gmail = manifest("gmail", MAIL_OPS)
  gmail.auth.scopes.push("read")
  gmail.egress.hosts = [
    {
      host: GMAIL_HOST,
      methods: ["GET", "POST"],
      pathPrefixes: ["/gmail/v1/users/me"],
    },
  ]
  for (const kind of [
    "email.markRead",
    "email.label",
    "email.archive",
    "email.trash",
  ]) {
    const operation = gmail.operations.find((op) => op.intentKind === kind)
    if (operation === undefined) throw new Error(`fixture lacks ${kind}`)
    if (kind === "email.label") operation.name = "label"
    operation.routes = [
      {
        host: GMAIL_HOST,
        method: "POST",
        pathPattern: GMAIL_BATCH_MODIFY_PATH,
      },
    ]
  }
  gmail.operations.push({
    name: "mail_get",
    effect: "read",
    reversibility: "reversible",
    sensitivity: "sensitive",
    untrustedOutput: true,
    defaultTier: "auto",
    authScopes: ["read"],
    routes: [
      {
        host: GMAIL_HOST,
        method: "GET",
        pathPattern: "/gmail/v1/users/me/messages/{id}",
      },
    ],
  })
  const setUp = setup([gmail])
  s = setUp
  return setUp
}

/** A fake Gmail mailbox: message id to its labels, changed only by batchModify requests. */
function fakeGmail(labels: Record<string, string[]>) {
  const mailbox = new Map(
    Object.entries(labels).map(([id, list]) => [id, new Set(list)])
  )
  const unread = (id: string) => mailbox.get(id)?.has("UNREAD") ?? false
  const transport = vi.fn((request: WriteRequest) => {
    const body: unknown = JSON.parse(request.body)
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
    // The write transport reports each message's UNREAD state from before the call.
    const previouslyUnread = ids.map(String).filter((id) => unread(id))
    for (const id of ids) {
      const set = mailbox.get(String(id))
      for (const label of add) set?.add(String(label))
      for (const label of remove) set?.delete(String(label))
    }
    // batchModify itself answers 204 with an empty body.
    return Promise.resolve({ upstreamRef: null, result: { previouslyUnread } })
  })
  return { transport, unread }
}

const markRead: Intent = {
  kind: "email.markRead",
  args: { messageIds: ["18c2f0a1b2c3d4e5"], read: true },
}

describe("Gmail mark read through the executor", () => {
  it("is auto-tier, removes UNREAD on execute and restores it on undo", async () => {
    const { db, policy } = pinnedGmail()
    const gmail = fakeGmail({ "18c2f0a1b2c3d4e5": ["INBOX", "UNREAD"] })
    const proposed = propose(db, policy, { intent: markRead, origin: "task" })
    if (!proposed.ok) throw new Error(proposed.code)
    expect(proposed).toMatchObject({ tier: "auto", state: "approved" })

    const executor = createExecutor(db, [gmailMarkReadWriter], gmail.transport)
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT payload_json FROM intents WHERE id=?")
            .get(proposed.intentId)?.["payload_json"]
        )
      )
    ).toMatchObject({ connector: "gmail" })
    expect(await executor.execute(proposed.intentId)).toEqual({
      ok: true,
      upstreamRef: null,
      result: { previouslyUnread: ["18c2f0a1b2c3d4e5"] },
    })
    expect(gmail.unread("18c2f0a1b2c3d4e5")).toBe(false)
    expect(
      db
        .prepare("SELECT inverse_op FROM executions WHERE intent_id=?")
        .get(proposed.intentId)?.["inverse_op"]
    ).toBe(
      '{"args":{"messageIds":["18c2f0a1b2c3d4e5"],"read":false},"connector":"gmail","kind":"email.markRead"}'
    )

    expect((await executor.undo(proposed.intentId)).ok).toBe(true)
    expect(gmail.unread("18c2f0a1b2c3d4e5")).toBe(true)

    const [execute, undo] = gmail.transport.mock.calls.map(([r]) => r)
    expect(execute).toMatchObject({
      method: "POST",
      url: URL_,
      body: '{"ids":["18c2f0a1b2c3d4e5"],"removeLabelIds":["UNREAD"]}',
      connector: "gmail",
      operation: "mark_read",
      idempotencyKey: proposed.intentId,
    })
    expect(undo).toMatchObject({
      url: URL_,
      body: '{"addLabelIds":["UNREAD"],"ids":["18c2f0a1b2c3d4e5"]}',
      idempotencyKey: `${proposed.intentId}:undo`,
    })
  })

  it("undo marks unread only the message that was unread before", async () => {
    const { db, policy } = pinnedGmail()
    const gmail = fakeGmail({
      unreadMsg: ["INBOX", "UNREAD"],
      readMsg: ["INBOX"],
    })
    const proposed = propose(db, policy, {
      intent: {
        kind: "email.markRead",
        args: { messageIds: ["unreadMsg", "readMsg"], read: true },
      },
      origin: "task",
    })
    if (!proposed.ok) throw new Error(proposed.code)
    const executor = createExecutor(db, [gmailMarkReadWriter], gmail.transport)
    expect((await executor.execute(proposed.intentId)).ok).toBe(true)
    expect(gmail.unread("unreadMsg")).toBe(false)
    expect(
      db
        .prepare("SELECT inverse_op FROM executions WHERE intent_id=?")
        .get(proposed.intentId)?.["inverse_op"]
    ).toBe(
      '{"args":{"messageIds":["unreadMsg"],"read":false},"connector":"gmail","kind":"email.markRead"}'
    )
    expect((await executor.undo(proposed.intentId)).ok).toBe(true)
    expect(gmail.unread("unreadMsg")).toBe(true)
    expect(gmail.unread("readMsg")).toBe(false)
  })

  it("leaves what the Done automatically list needs in the intent API and audit history", async () => {
    const { db, policy } = pinnedGmail()
    const gmail = fakeGmail({ "18c2f0a1b2c3d4e5": ["INBOX", "UNREAD"] })
    const proposed = propose(db, policy, { intent: markRead, origin: "task" })
    if (!proposed.ok) throw new Error(proposed.code)
    await createExecutor(db, [gmailMarkReadWriter], gmail.transport).execute(
      proposed.intentId
    )
    expect(intentSummary(db, proposed.intentId)).toMatchObject({
      id: proposed.intentId,
      kind: "email.markRead",
      tier: "auto",
      state: "executed",
    })
    expect(
      intentHistory(db, proposed.intentId).map((e) => [e.from, e.to, e.actor])
    ).toEqual([
      [null, "proposed", "data-plane"],
      ["proposed", "approved", "policy"],
      ["approved", "executed", "executor"],
    ])
    const actions = auditRows(db)
      .filter((row) => row.target === proposed.intentId)
      .map((row) => row.action)
    expect(actions).toContain("execute")
    // The audit log holds hashes only, never the message ids it acted on.
    expect(JSON.stringify(auditRows(db))).not.toContain("18c2f0a1b2c3d4e5")
  })
})

it("executes label, archive and signed trash through the pinned shared route", async () => {
  const { db, policy } = pinnedGmail()
  const mailbox = new Map<string, Set<string>>([
    ["label-1", new Set(["INBOX"])],
    ["archive-1", new Set(["INBOX", "UNREAD"])],
    ["trash-1", new Set(["INBOX"])],
  ])
  const transport = vi.fn((request: WriteRequest) => {
    expect(request.url).toBe(URL_)
    const body: unknown = JSON.parse(request.body)
    if (typeof body !== "object" || body === null || !("ids" in body))
      throw new Error("bad request body")
    const ids = body.ids
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
      throw new Error("bad message ids")
    const add = "addLabelIds" in body ? body.addLabelIds : []
    const remove = "removeLabelIds" in body ? body.removeLabelIds : []
    if (!Array.isArray(add) || !Array.isArray(remove))
      throw new Error("bad label change")
    const priorLabels: Record<string, string[]> = {}
    for (const id of ids) {
      const labels = mailbox.get(id)
      if (labels === undefined) throw new Error("unknown message")
      priorLabels[id] = [...labels]
      for (const label of add) labels.add(String(label))
      for (const label of remove) labels.delete(String(label))
    }
    return Promise.resolve({ upstreamRef: null, result: { priorLabels } })
  })
  const executor = createExecutor(db, GMAIL_WRITERS, transport)
  for (const [kind, args, expected] of [
    [
      "email.label",
      { messageIds: ["label-1"], add: ["STARRED"] },
      ["INBOX", "STARRED"],
    ],
    ["email.archive", { messageIds: ["archive-1"] }, ["UNREAD"]],
    ["email.trash", { messageIds: ["trash-1"] }, ["INBOX", "TRASH"]],
  ] as const) {
    const result = propose(db, policy, {
      intent: { kind, connector: "gmail", args },
      origin: "task",
    })
    if (!result.ok) throw new Error(result.code)
    if (kind === "email.trash") {
      expect(result.state).toBe("pending")
      const auth = testAuthenticator()
      const begun = beginRegistration(db, "admin")
      if (!begun.ok) throw new Error("registration refused")
      const registered = registerCredential(
        db,
        WEBAUTHN,
        "admin",
        registration(auth, begun.challenge)
      )
      if (!registered.ok) throw new Error("credential refused")
      const prepared = issueNonce(db, result.intentId)
      if (!prepared.ok) throw new Error("prepare refused")
      expect(
        verifyApproval(db, WEBAUTHN, {
          intentId: result.intentId,
          nonce: prepared.nonce,
          assertion: assertion(
            auth,
            deviceChallenge(
              prepared.payloadHash,
              result.intentId,
              prepared.nonce
            )
          ),
        }).ok
      ).toBe(true)
    } else {
      expect(result.state).toBe("approved")
    }
    expect((await executor.execute(result.intentId)).ok).toBe(true)
    expect([...(mailbox.get(args.messageIds[0]) ?? [])].sort()).toEqual(
      [...expected].sort()
    )
    expect(transport.mock.lastCall?.[0].operation).toBe(
      kind === "email.label"
        ? "label"
        : kind === "email.archive"
          ? "archive"
          : "trash"
    )
  }
})

describe("gmailMarkReadWriter", () => {
  const unread = sample("email.markRead", { read: false })

  it("decodes both directions of its own requests back to the intent", () => {
    for (const intent of [markRead, unread]) {
      const request = gmailMarkReadWriter.buildRequest(intent)
      expect(gmailMarkReadWriter.intentFromRequest(request)).toEqual(intent)
    }
  })

  it.each([
    [
      "another URL",
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/x/modify",
      },
    ],
    ["another method", { method: "PUT" }],
    ["no body", { body: null }],
    ["an array body", { body: [] }],
    [
      "ids that are not strings",
      { body: { ids: [1], removeLabelIds: ["UNREAD"] } },
    ],
    ["another label", { body: { ids: ["a"], removeLabelIds: ["INBOX"] } }],
    [
      "an extra label",
      { body: { ids: ["a"], removeLabelIds: ["UNREAD", "INBOX"] } },
    ],
    [
      "both directions",
      {
        body: {
          ids: ["a"],
          addLabelIds: ["UNREAD"],
          removeLabelIds: ["UNREAD"],
        },
      },
    ],
    [
      "an extra field",
      { body: { ids: ["a"], addLabelIds: ["UNREAD"], trash: true } },
    ],
  ])("refuses a request with %s", (_name, change) => {
    const request = { ...gmailMarkReadWriter.buildRequest(markRead), ...change }
    expect(() => gmailMarkReadWriter.intentFromRequest(request)).toThrow(
      "not a Gmail mark read request"
    )
  })

  describe("inverse", () => {
    const two = (read: boolean): Intent => ({
      kind: "email.markRead",
      args: { messageIds: ["a", "b"], read },
    })

    it("marking unread is undone by marking read only what was read before", () => {
      expect(
        gmailMarkReadWriter.inverse(two(false), { previouslyUnread: ["a"] })
      ).toEqual({
        kind: "email.markRead",
        args: { messageIds: ["b"], read: true },
      })
    })

    it("gives no undo when nothing changed", () => {
      expect(
        gmailMarkReadWriter.inverse(two(true), { previouslyUnread: [] })
      ).toBeNull()
    })

    it("gives no undo, not a guess, when the prior state is not reported", () => {
      expect(gmailMarkReadWriter.inverse(two(true), {})).toBeNull()
      expect(
        gmailMarkReadWriter.inverse(two(true), { previouslyUnread: [1] })
      ).toBeNull()
    })

    it("ignores reported ids the intent did not name", () => {
      expect(
        gmailMarkReadWriter.inverse(two(true), { previouslyUnread: ["a", "z"] })
      ).toEqual({
        kind: "email.markRead",
        args: { messageIds: ["a"], read: false },
      })
    })
  })

  it("builds and inverts mark read only", () => {
    const label = sample("email.label")
    expect(() => gmailMarkReadWriter.buildRequest(label)).toThrow(
      "wrong intent kind"
    )
    expect(gmailMarkReadWriter.inverse(label, {})).toBeNull()
  })
})

const BATCH = { method: "POST", url: URL_ }

describe("gmailLabelWriter", () => {
  const label: Intent = {
    kind: "email.label",
    connector: "gmail",
    args: { messageIds: ["a", "b"], add: ["Label_1"], remove: ["INBOX"] },
  }

  it("builds one batchModify call and decodes it back to the intent", () => {
    const request = gmailLabelWriter.buildRequest(label)
    expect(request).toEqual({
      ...BATCH,
      body: {
        ids: ["a", "b"],
        addLabelIds: ["Label_1"],
        removeLabelIds: ["INBOX"],
      },
    })
    expect(gmailLabelWriter.intentFromRequest(request, "gmail")).toEqual(label)
  })

  it("leaves out a direction the intent does not name, both ways", () => {
    const addOnly: Intent = {
      kind: "email.label",
      args: { messageIds: ["a"], add: ["Label_1"] },
    }
    const request = gmailLabelWriter.buildRequest(addOnly)
    expect(request.body).toEqual({ ids: ["a"], addLabelIds: ["Label_1"] })
    expect(gmailLabelWriter.intentFromRequest(request)).toEqual(addOnly)
  })

  it.each(["TRASH", "spam"])(
    "refuses to add %s, which only the approval-tier trash may do",
    (forbidden) => {
      const intent: Intent = {
        kind: "email.label",
        args: { messageIds: ["a"], add: [forbidden] },
      }
      expect(() => gmailLabelWriter.buildRequest(intent)).toThrow(
        "may not move mail to Trash or Spam"
      )
      expect(() =>
        gmailLabelWriter.intentFromRequest({
          ...BATCH,
          body: { ids: ["a"], addLabelIds: [forbidden] },
        })
      ).toThrow("not a Gmail label request")
    }
  )

  it("decodes raw MIME content rather than trusting an intent envelope", async () => {
    const intent: Intent = {
      kind: "email.send",
      connector: "gmail",
      args: {
        to: ["person@example.invalid"],
        subject: "Hi",
        body: "Original body",
      },
    }
    const request = await gmailSendWriter.buildRequest(intent)
    if (
      typeof request.body !== "object" ||
      request.body === null ||
      !("raw" in request.body) ||
      typeof request.body.raw !== "string"
    )
      throw new Error("writer did not build raw MIME")
    const raw = Buffer.from(request.body.raw, "base64url").toString("utf8")
    const changed = raw.replace("Original body", "Changed body")
    const decoded = await gmailSendWriter.intentFromRequest(
      { ...request, body: { raw: Buffer.from(changed).toString("base64url") } },
      "gmail"
    )
    expect(decoded).not.toEqual(intent)
  })

  it.each([
    ["another URL", { url: `https://${GMAIL_HOST}/gmail/v1/users/me/labels` }],
    ["another method", { method: "PUT" }],
    ["an extra field", { body: { ids: ["a"], addLabelIds: ["x"], q: "y" } }],
    ["ids that are not strings", { body: { ids: [1], addLabelIds: ["x"] } }],
    ["labels that are not a list", { body: { ids: ["a"], addLabelIds: "x" } }],
  ])("refuses a request with %s", (_name, change) => {
    expect(() =>
      gmailLabelWriter.intentFromRequest({
        ...gmailLabelWriter.buildRequest(label),
        ...change,
      })
    ).toThrow("not a Gmail label request")
  })

  describe("inverse", () => {
    it("takes off only what was added and puts back only what was removed", () => {
      expect(
        gmailLabelWriter.inverse(label, {
          priorLabels: { a: ["INBOX"], b: ["INBOX", "UNREAD"] },
        })
      ).toEqual({
        kind: "email.label",
        connector: "gmail",
        args: { messageIds: ["a", "b"], add: ["INBOX"], remove: ["Label_1"] },
      })
    })

    it("skips messages the write did not change", () => {
      expect(
        gmailLabelWriter.inverse(label, {
          priorLabels: { a: ["Label_1"], b: ["INBOX"] },
        })
      ).toEqual({
        kind: "email.label",
        connector: "gmail",
        args: { messageIds: ["b"], add: ["INBOX"], remove: ["Label_1"] },
      })
    })

    it("gives no undo when nothing changed", () => {
      expect(
        gmailLabelWriter.inverse(label, {
          priorLabels: { a: ["Label_1"], b: ["Label_1"] },
        })
      ).toBeNull()
    })

    it("gives no undo when the messages changed differently", () => {
      expect(
        gmailLabelWriter.inverse(label, {
          priorLabels: { a: ["INBOX"], b: [] },
        })
      ).toBeNull()
    })

    it.each([
      ["no report", {}],
      ["a message missing from the report", { priorLabels: { a: ["INBOX"] } }],
      ["a malformed report", { priorLabels: { a: "INBOX", b: [] } }],
    ])("gives no undo, not a guess, with %s", (_name, result) => {
      expect(gmailLabelWriter.inverse(label, result)).toBeNull()
    })

    it("gives no undo when one label is both added and removed", () => {
      const both: Intent = {
        kind: "email.label",
        args: { messageIds: ["a"], add: ["Label_1"], remove: ["Label_1"] },
      }
      expect(
        gmailLabelWriter.inverse(both, { priorLabels: { a: [] } })
      ).toBeNull()
    })

    it("gives no undo that would put mail back in Trash", () => {
      const untrash: Intent = {
        kind: "email.label",
        args: { messageIds: ["a"], remove: ["TRASH"] },
      }
      expect(
        gmailLabelWriter.inverse(untrash, { priorLabels: { a: ["TRASH"] } })
      ).toBeNull()
    })
  })
})

describe("gmailArchiveWriter", () => {
  const archive: Intent = {
    kind: "email.archive",
    connector: "gmail",
    args: { messageIds: ["a", "b"] },
  }

  it("takes INBOX off in one call and decodes it back to the intent", () => {
    const request = gmailArchiveWriter.buildRequest(archive)
    expect(request).toEqual({
      ...BATCH,
      body: { ids: ["a", "b"], removeLabelIds: ["INBOX"] },
    })
    expect(gmailArchiveWriter.intentFromRequest(request, "gmail")).toEqual(
      archive
    )
  })

  it.each([
    ["another label", { ids: ["a"], removeLabelIds: ["UNREAD"] }],
    ["an extra label", { ids: ["a"], removeLabelIds: ["INBOX", "UNREAD"] }],
    [
      "an added label",
      { ids: ["a"], removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] },
    ],
  ])("refuses a request with %s", (_name, body) => {
    expect(() =>
      gmailArchiveWriter.intentFromRequest({ ...BATCH, body })
    ).toThrow("not a Gmail archive request")
  })

  it("is undone by putting INBOX back on the messages that had it", () => {
    expect(
      gmailArchiveWriter.inverse(archive, {
        priorLabels: { a: ["INBOX", "UNREAD"], b: ["Label_1"] },
      })
    ).toEqual({
      kind: "email.label",
      connector: "gmail",
      args: { messageIds: ["a"], add: ["INBOX"] },
    })
  })

  it("gives no undo when no message was in the inbox or the report is missing", () => {
    expect(
      gmailArchiveWriter.inverse(archive, { priorLabels: { a: [], b: [] } })
    ).toBeNull()
    expect(gmailArchiveWriter.inverse(archive, {})).toBeNull()
  })
})

describe("gmailTrashWriter", () => {
  const trash: Intent = {
    kind: "email.trash",
    connector: "gmail",
    args: { messageIds: ["a"] },
  }

  it("adds the TRASH label in one call and decodes it back to the intent", () => {
    const request = gmailTrashWriter.buildRequest(trash)
    expect(request).toEqual({
      ...BATCH,
      body: { ids: ["a"], addLabelIds: ["TRASH"] },
    })
    expect(gmailTrashWriter.intentFromRequest(request, "gmail")).toEqual(trash)
  })

  it.each([
    ["another label", { ids: ["a"], addLabelIds: ["SPAM"] }],
    [
      "a removed label",
      { ids: ["a"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] },
    ],
  ])("refuses a request with %s", (_name, body) => {
    expect(() =>
      gmailTrashWriter.intentFromRequest({ ...BATCH, body })
    ).toThrow("not a Gmail trash request")
  })

  it("records no inverse", () => {
    expect(
      gmailTrashWriter.inverse(trash, { priorLabels: { a: [] } })
    ).toBeNull()
  })
})

describe("the Gmail writers", () => {
  it.each([
    ["mark read", gmailMarkReadWriter, sample("email.label")],
    ["label", gmailLabelWriter, sample("email.archive")],
    ["archive", gmailArchiveWriter, sample("email.trash")],
    ["trash", gmailTrashWriter, sample("email.archive")],
  ])("%s builds its own kind only", async (_name, writer, other) => {
    await expect(
      Promise.resolve().then(() => writer.buildRequest(other))
    ).rejects.toThrow("wrong intent kind")
    expect(writer.inverse(other, { priorLabels: {} })).toBeNull()
  })

  it.each([sample("email.send"), sample("email.draft")])(
    "draft and send reject a mismatched intent kind",
    async (other) => {
      const writer =
        other.kind === "email.send" ? gmailDraftWriter : gmailSendWriter
      await expect(writer.buildRequest(other)).rejects.toThrow(
        "wrong intent kind"
      )
      expect(writer.inverse(other, { priorLabels: {} })).toBeNull()
    }
  )

  it("decode only their own kind, though they share one route", () => {
    const archive = gmailArchiveWriter.buildRequest(sample("email.archive"))
    const trash = gmailTrashWriter.buildRequest(sample("email.trash"))
    expect(() => gmailTrashWriter.intentFromRequest(archive)).toThrow()
    expect(() => gmailArchiveWriter.intentFromRequest(trash)).toThrow()
    expect(() => gmailMarkReadWriter.intentFromRequest(trash)).toThrow()
    expect(() => gmailLabelWriter.intentFromRequest(trash)).toThrow()
  })

  it("are all registered for the gmail connector, one per kind", () => {
    expect(
      GMAIL_WRITERS.map((writer) => `${writer.connector}:${writer.kind}`)
    ).toEqual([
      "gmail:email.markRead",
      "gmail:email.label",
      "gmail:email.archive",
      "gmail:email.trash",
      "gmail:email.draft",
      "gmail:email.send",
    ])
  })

  it.each([
    [
      gmailDraftWriter,
      {
        kind: "email.draft",
        connector: "gmail",
        args: { to: ["person@example.invalid"], subject: "Hi", body: "Body" },
      } satisfies Intent,
    ],
    [
      gmailSendWriter,
      {
        kind: "email.send",
        connector: "gmail",
        args: { to: ["person@example.invalid"], subject: "Hi", body: "Body" },
      } satisfies Intent,
    ],
    [
      gmailSendWriter,
      {
        kind: "email.send",
        connector: "gmail",
        args: {
          to: ["person@example.invalid"],
          subject: "Hi",
          body: "Body",
          draftId: "draft-1",
        },
      } satisfies Intent,
    ],
  ])(
    "round-trips approved $1 mail intent and records no inverse",
    async (_writer, intent) => {
      const writer =
        intent.kind === "email.draft" ? gmailDraftWriter : gmailSendWriter
      const request = await writer.buildRequest(intent)
      expect(await writer.intentFromRequest(request, "gmail")).toEqual(intent)
      expect(writer.inverse(intent, { id: "upstream" })).toBeNull()
    }
  )

  it("rejects malformed or unsupported raw mail", async () => {
    await expect(
      Promise.resolve().then(() =>
        gmailDraftWriter.intentFromRequest({
          method: "PUT",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
          body: {},
        })
      )
    ).rejects.toThrow("not a Gmail mail request")
    await expect(
      Promise.resolve().then(() =>
        gmailDraftWriter.intentFromRequest({
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
          body: { message: { raw: 3 } },
        })
      )
    ).rejects.toThrow("not a Gmail raw mail request")
    await expect(
      Promise.resolve().then(() =>
        gmailSendWriter.intentFromRequest({
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          body: { raw: Buffer.from("no mail headers").toString("base64url") },
        })
      )
    ).rejects.toThrow("Gmail raw message lacks required headers or text body")
  })

  it.each(["./gmail-writers.ts", "./gmail-transport.ts"])(
    "%s names no permanent delete or empty-trash endpoint",
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8")
      expect(source).not.toMatch(
        /batchDelete|emptyTrash|messages\.delete|\/delete\b|["'`]DELETE["'`]/i
      )
    }
  )
})
