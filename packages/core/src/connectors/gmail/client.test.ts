import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { createGmailClient } from "./client"
import { GmailError } from "./errors"
import { createFakeGmail, rfc822, seedInbox } from "./fake-gmail.test-support"
import { READ_PATHS, WRITE_PATHS } from "./routes"
import { createEgressTransport } from "./transport"
import type { GmailTransport } from "./transport"

const answering =
  (status: number, body: unknown): GmailTransport =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))

describe("read client", () => {
  test("pages a label's messages by pageToken in bounded batches", async () => {
    const gmail = createFakeGmail()
    seedInbox(gmail, 5)
    const client = createGmailClient(gmail.transport)
    const first = await client.searchMessages("", {
      limit: 2,
      labelIds: ["INBOX"],
    })
    expect(first).toEqual({
      messages: [
        { id: "gm-005", threadId: "th-gm-005" },
        { id: "gm-004", threadId: "th-gm-004" },
      ],
      nextPageToken: "2",
    })
    const last = await client.searchMessages("", {
      limit: 2,
      labelIds: ["INBOX"],
      pageToken: "4",
    })
    expect(last).toEqual({
      messages: [{ id: "gm-001", threadId: "th-gm-001" }],
    })
    expect(gmail.requests[0]?.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=2&labelIds=INBOX"
    )
  })

  test("sends a search query as q", async () => {
    const gmail = createFakeGmail()
    await createGmailClient(gmail.transport).searchMessages(
      "from:ada@example.com",
      {
        limit: 10,
      }
    )
    expect(new URL(gmail.requests[0]?.url ?? "").searchParams.get("q")).toBe(
      "from:ada@example.com"
    )
  })

  test("fetches a message as raw bytes", async () => {
    const gmail = createFakeGmail()
    const raw = rfc822({
      messageId: "m1@mail.example.com",
      subject: "Hi",
      body: "Lorem",
    })
    gmail.add({
      id: "gm-1",
      threadId: "th-1",
      labelIds: ["INBOX"],
      raw,
      internalDate: "1700000000000",
    })
    const message = await createGmailClient(gmail.transport).getMessage("gm-1")
    expect(new TextDecoder().decode(message.raw)).toBe(raw)
    expect(message).toMatchObject({
      id: "gm-1",
      threadId: "th-1",
      labelIds: ["INBOX"],
      internalDate: "1700000000000",
    })
    expect(
      new URL(gmail.requests[0]?.url ?? "").searchParams.get("format")
    ).toBe("raw")
  })

  test("reads a thread's message ids and labels", async () => {
    const gmail = createFakeGmail()
    seedInbox(gmail, 1)
    expect(
      await createGmailClient(gmail.transport).getThread("th-gm-001")
    ).toEqual({
      id: "th-gm-001",
      historyId: gmail.historyId,
      messages: [{ id: "gm-001", labelIds: ["INBOX", "UNREAD"] }],
    })
  })

  test("reads the profile's history id", async () => {
    const gmail = createFakeGmail()
    seedInbox(gmail, 2)
    expect(await createGmailClient(gmail.transport).getProfile()).toEqual({
      emailAddress: "owner@example.com",
      historyId: "1002",
    })
  })

  test("lists history: added messages and messages given the label, deduped", async () => {
    const gmail = createFakeGmail()
    seedInbox(gmail, 1)
    const start = gmail.historyId
    seedInbox(gmail, 1, 2)
    gmail.add({ id: "gm-x", threadId: "th-x", labelIds: ["SENT"], raw: "x" })
    gmail.addLabel("gm-x", "INBOX")
    gmail.addLabel("gm-002", "STARRED")
    const page = await createGmailClient(gmail.transport).listHistory(start, {
      labelId: "INBOX",
      limit: 100,
    })
    expect(page).toEqual({
      messageIds: ["gm-002", "gm-x"],
      historyId: gmail.historyId,
    })
    expect(
      new URL(gmail.requests[0]?.url ?? "").searchParams.getAll("historyTypes")
    ).toEqual(["messageAdded", "labelAdded"])
  })

  test("an expired history id is history_expired", async () => {
    const gmail = createFakeGmail()
    seedInbox(gmail, 1)
    gmail.expireHistory()
    await expect(
      createGmailClient(gmail.transport).listHistory("900", {
        labelId: "INBOX",
        limit: 10,
      })
    ).rejects.toMatchObject({ code: "history_expired", status: 404 })
  })

  test("a missing message is not_found", async () => {
    await expect(
      createGmailClient(createFakeGmail().transport).getMessage("gm-none")
    ).rejects.toMatchObject({ code: "not_found" })
  })

  test("other failures pass through listHistory unchanged", async () => {
    await expect(
      createGmailClient(answering(500, {})).listHistory("1", {
        labelId: "INBOX",
        limit: 1,
      })
    ).rejects.toMatchObject({ code: "upstream_error", status: 500 })
  })

  test("a failure with a body that is not JSON is upstream_error", async () => {
    const transport: GmailTransport = () =>
      Promise.resolve(new Response("<html>busy</html>", { status: 503 }))
    await expect(
      createGmailClient(transport).getProfile()
    ).rejects.toMatchObject({
      code: "upstream_error",
      status: 503,
    })
  })

  test.each([
    [
      "not JSON",
      () => Promise.resolve(new Response("<html>", { status: 200 })),
    ],
    ["an array", answering(200, [])],
    [
      "an object without the field",
      answering(200, { emailAddress: "owner@example.com" }),
    ],
  ])(
    "a 200 answer that is %s is invalid_response",
    async (_name, transport) => {
      await expect(
        createGmailClient(transport).getProfile()
      ).rejects.toMatchObject({
        code: "invalid_response",
      })
    }
  )

  test("skips list entries that are not objects and labels that are not strings", async () => {
    const client = createGmailClient(
      answering(200, {
        id: "t",
        messages: [7, { id: "a", labelIds: ["INBOX", 3] }],
      })
    )
    expect(await client.getThread("t")).toEqual({
      id: "t",
      messages: [{ id: "a", labelIds: ["INBOX"] }],
    })
    expect(
      await createGmailClient(
        answering(200, { messages: "none" })
      ).searchMessages("", {
        limit: 1,
      })
    ).toEqual({ messages: [] })
  })
})

describe("revoked grant", () => {
  test.each([
    ["a 401 from Google", 401, { error: { code: 401 } }],
    ["the egress proxy's grant_revoked", 502, { reason: "grant_revoked" }],
    ["an invalid_grant body", 400, { error: "invalid_grant" }],
  ])(
    "%s is grant_revoked, after exactly one request",
    async (_name, status, body) => {
      let calls = 0
      const transport: GmailTransport = () => {
        calls++
        return Promise.resolve(new Response(JSON.stringify(body), { status }))
      }
      const error: unknown = await createGmailClient(transport)
        .getProfile()
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(GmailError)
      expect(error).toMatchObject({ code: "grant_revoked", status })
      expect(calls).toBe(1)
    }
  )
})

describe("egress transport", () => {
  test("sends only the target and connector to the gate's proxy, never a credential", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const transport = createEgressTransport({
      proxyUrl: "http://127.0.0.1:7801/ignored",
      fetch: (input, init) => {
        seen.push({
          url:
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          init,
        })
        return Promise.resolve(new Response("{}"))
      },
    })
    await transport({
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    })
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:7801/",
        init: {
          method: "GET",
          headers: {
            "x-eido-connector": "gmail",
            "x-eido-target":
              "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          },
          redirect: "manual",
        },
      },
    ])
  })

  test("an unreachable proxy is gate_unavailable", async () => {
    const transport = createEgressTransport({
      proxyUrl: "http://127.0.0.1:7801",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    })
    await expect(
      transport({
        method: "GET",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      })
    ).rejects.toMatchObject({ code: "gate_unavailable" })
  })
})

describe("no permanent delete", () => {
  test("no Gmail route this connector names deletes or empties anything", () => {
    for (const path of [
      ...Object.values(READ_PATHS),
      ...Object.values(WRITE_PATHS),
    ])
      expect(path).not.toMatch(/delete|empty/i)
  })

  test("no source file in the connector names a delete endpoint or the DELETE method", () => {
    const dir = new URL("./", import.meta.url)
    const sources = readdirSync(dir).filter(
      (file) => file.endsWith(".ts") && !file.includes(".test")
    )
    expect(sources).toContain("client.ts")
    for (const file of sources) {
      const text = readFileSync(new URL(file, dir), "utf8")
      expect(text, file).not.toMatch(/batchDelete|emptyTrash|["'`]DELETE["'`]/)
    }
  })
})
