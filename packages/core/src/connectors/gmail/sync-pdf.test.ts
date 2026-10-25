import { mkdtempSync, rmSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IntentClient } from "@eido/gate"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { openDataDb } from "../../ledger/db"
import { createParser } from "../../parsers/index"
import type { Parser } from "../../parsers/index"
import { textPdf } from "../../parsers/fixtures.test-support"
import { createProfileStore } from "../../profile/store"
import type { IngestAccount } from "../ingest-entity"
import { createGmailClient } from "./client"
import { resolveGmailConfig } from "./config"
import { createGmailFacade } from "./facade"
import { createFakeGmail, rfc822 } from "./fake-gmail.test-support"
import { syncGmail } from "./sync"

// PDF attachments are read by the real sandboxed parser (a child process per parse).

const ACCOUNT = "owner@example.invalid"
const config = resolveGmailConfig({ batchSize: 5, fullSyncLimit: 10 })
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function newParser(limits?: Parameters<typeof createParser>[0]["limits"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "eido-gmail-pdf-"))
  dirs.push(dataDir)
  return createParser({ dataDir, ...(limits === undefined ? {} : { limits }) })
}

let db: DatabaseSync
let gmail: ReturnType<typeof createFakeGmail>
let account: IngestAccount

beforeEach(async () => {
  db = openDataDb(":memory:")
  gmail = createFakeGmail()
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  const entity = await profile.createEntity({
    kind: "personal",
    name: "Test Personal",
    tag: "ME",
  })
  await profile.assignAccount({
    connector: "gmail",
    accountRef: ACCOUNT,
    entityId: entity.id,
  })
  account = { accountRef: ACCOUNT, entities: profile }
})

function addWithPdf(id: string, pdf: Uint8Array) {
  gmail.add({
    id,
    threadId: `th-${id}`,
    labelIds: ["INBOX"],
    raw: rfc822({
      messageId: `${id}@mail.example.com`,
      subject: `Mail ${id}`,
      body: "See attached.",
      attachment: {
        filename: "report.pdf",
        mime: "application/pdf",
        content: pdf,
      },
    }),
  })
}

const noIntents: IntentClient = {
  propose: () => Promise.reject(new Error("not used")),
  status: () => Promise.reject(new Error("not used")),
  history: () => Promise.reject(new Error("not used")),
  listPending: () => Promise.reject(new Error("not used")),
  getConnectorHealth: () => Promise.resolve([]),
}

const sync = (parser: Parser | undefined) =>
  syncGmail(
    db,
    createGmailClient(gmail.transport),
    config,
    account,
    parser === undefined ? {} : { parser }
  )

const facade = () =>
  createGmailFacade({
    db,
    intents: noIntents,
    identity: "x@example.invalid",
    profile: { getProfile: () => Promise.resolve(null) },
  })

describe("PDF attachments", () => {
  test("a synced PDF's text comes back from attachment_text, flagged untrusted", async () => {
    addWithPdf("gm-1", textPdf([["Lorem ipsum", "dolor sit"], ["amet"]]))
    await sync(newParser())
    expect(
      facade().attachment_text({ messageId: "gm-1", attachmentIndex: 0 })
    ).toEqual({
      filename: "report.pdf",
      mime: "application/pdf",
      text: "Lorem ipsum\ndolor sit\namet",
      untrusted: true,
    })
  }, 60_000)

  test("a PDF that fails to parse is indexed with no text and the sync goes on", async () => {
    const good = textPdf([["Valid text"]])
    addWithPdf("gm-1", good)
    addWithPdf("gm-2", good.subarray(0, good.length - 20))
    gmail.add({
      id: "gm-3",
      threadId: "th-3",
      labelIds: ["INBOX"],
      raw: rfc822({
        messageId: "3@m.example.com",
        subject: "Plain",
        body: "x",
      }),
    })
    const [result] = await sync(newParser())
    expect(result?.inserted).toBe(5)
    expect(
      facade().attachment_text({ messageId: "gm-2", attachmentIndex: 0 })
    ).toMatchObject({ mime: "application/pdf", text: null, untrusted: true })
    expect(
      facade().attachment_text({ messageId: "gm-1", attachmentIndex: 0 }).text
    ).toBe("Valid text")
    expect(facade().mail_get({ messageId: "gm-3" })?.text).toBe("x")
  }, 60_000)

  test("a PDF over the parser's limits is indexed with no text and the sync goes on", async () => {
    addWithPdf("gm-1", textPdf([["one"], ["two"]]))
    addWithPdf("gm-2", textPdf([["short"]]))
    const [result] = await sync(newParser({ pdfPages: 1 }))
    expect(result?.inserted).toBe(4)
    expect(
      facade().attachment_text({ messageId: "gm-1", attachmentIndex: 0 }).text
    ).toBeNull()
    expect(
      facade().attachment_text({ messageId: "gm-2", attachmentIndex: 0 }).text
    ).toBe("short")
  }, 60_000)

  test("without a parser a PDF is indexed with no text", async () => {
    addWithPdf("gm-1", textPdf([["Lorem"]]))
    await sync(undefined)
    expect(
      facade().attachment_text({ messageId: "gm-1", attachmentIndex: 0 }).text
    ).toBeNull()
  })
})
