import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { InMemoryVault } from "../vault/vault"
import {
  BRIDGE_PASSWORD_KEY,
  MAX_MESSAGE_BYTES,
  createProtonBridge,
  imapOptions,
  parseFallbackId,
  rawSha256,
  smtpOptions,
} from "./bridge"
import type { ProtonBridge } from "./bridge"
import type { BridgeConfig } from "./config"
import { BridgeError } from "./errors"
import { closedPort, rawMessage, startFakeBridge } from "./fake-bridge"
import { createTestCertificate } from "./test-certificate"
import type { FakeBridge, FakeBridgeOptions, FakeMailbox } from "./fake-bridge"

const USER = "assistant@example.invalid"
const PASSWORD = "synthetic-bridge-password-3c9e"

const opened: FakeBridge[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((fake) => fake.close()))
})

function config(fake: Pick<FakeBridge, "imapPort" | "smtpPort">): BridgeConfig {
  return {
    host: "127.0.0.1",
    imapPort: fake.imapPort,
    smtpPort: fake.smtpPort,
    tls: "none",
    username: USER,
    searchFolders: ["INBOX", "Archive"],
  }
}

async function start(
  options: Partial<FakeBridgeOptions> = {},
  /** The vault's password; null leaves the vault empty. */
  password: string | null = PASSWORD
): Promise<{ fake: FakeBridge; bridge: ProtonBridge; vault: InMemoryVault }> {
  const fake = await startFakeBridge({
    username: USER,
    password: PASSWORD,
    ...options,
  })
  opened.push(fake)
  const vault = new InMemoryVault()
  if (password !== null) await vault.set(BRIDGE_PASSWORD_KEY, password)
  return {
    fake,
    vault,
    bridge: createProtonBridge({ config: config(fake), vault }),
  }
}

function box(
  uidValidity: number,
  messages: { uid: number; raw: Buffer; reportedSize?: number }[]
): FakeMailbox {
  const last = messages.at(-1)?.uid ?? 0
  return {
    uidValidity,
    uidNext: last + 1,
    messages: messages.map((message) => ({ ...message, flags: [] })),
  }
}

const first = rawMessage({
  messageId: "<first@example.invalid>",
  subject: "One",
  body: "lorem",
})
const second = rawMessage({
  messageId: "<second@example.invalid>",
  subject: "Two",
  body: "ipsum",
  references: "<first@example.invalid>",
  replyTo: "Desk <desk@example.invalid>",
  cc: "Carol <carol@example.invalid>, dave@example.invalid",
})

function mailboxes(): Record<string, FakeMailbox> {
  return {
    INBOX: box(1700000001, [
      { uid: 3, raw: first },
      { uid: 7, raw: second },
    ]),
    Drafts: box(1700000002, []),
    Trash: box(1700000003, []),
    Archive: { ...box(1700000004, []), listFlags: [] },
    Folders: { ...box(1700000005, []), listFlags: ["\\Noselect"] },
  }
}

/** Every client command that could flag, expunge or remove mail. */
function destructive(commands: readonly string[]): string[] {
  return commands.filter((command) =>
    /^(UID )?(EXPUNGE|STORE|CLOSE|DELETE)\b|\\Deleted/i.test(command)
  )
}

describe("connection options", () => {
  const base: BridgeConfig = {
    host: "127.0.0.1",
    imapPort: 1143,
    smtpPort: 1025,
    tls: "starttls",
    certificatePem: "synthetic certificate",
    certificateSha256: "a".repeat(64),
    username: USER,
    searchFolders: ["INBOX"],
  }

  it("requires STARTTLS and the pinned certificate on both protocols", () => {
    expect(imapOptions(base, PASSWORD)).toMatchObject({
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      doSTARTTLS: true,
      tls: { rejectUnauthorized: true, ca: "synthetic certificate" },
      logger: false,
    })
    expect(smtpOptions(base, PASSWORD)).toMatchObject({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      tls: { rejectUnauthorized: true, ca: "synthetic certificate" },
      name: "localhost",
      logger: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  })

  it("uses implicit TLS and verifies the certificate in tls mode", () => {
    const tls = { ...base, tls: "tls" as const }
    expect(imapOptions(tls, PASSWORD)).toMatchObject({
      secure: true,
      doSTARTTLS: false,
      tls: { rejectUnauthorized: true },
    })
    expect(smtpOptions(tls, PASSWORD)).toMatchObject({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    })
  })

  it("keeps clear-text mode only for direct test fixtures", () => {
    const none = { ...base, tls: "none" as const }
    expect(imapOptions(none, PASSWORD)).toMatchObject({
      secure: false,
      doSTARTTLS: false,
    })
    expect(smtpOptions(none, PASSWORD)).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    })
  })
})

describe("certificate pinning against an implicit-TLS fake Bridge", () => {
  let pinned: ReturnType<typeof createTestCertificate>
  let other: ReturnType<typeof createTestCertificate>
  beforeAll(() => {
    pinned = createTestCertificate()
    other = createTestCertificate()
  })
  afterAll(() => {
    pinned.cleanup()
    other.cleanup()
  })

  async function bridgeFor(
    cert: ReturnType<typeof createTestCertificate>,
    expectedSha256 = pinned.sha256
  ) {
    const fake = await startFakeBridge({
      username: USER,
      password: PASSWORD,
      implicitTls: { cert: cert.cert, key: cert.key },
    })
    opened.push(fake)
    const vault = new InMemoryVault()
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const bridge = createProtonBridge({
      config: {
        host: "127.0.0.1",
        imapPort: fake.imapPort,
        smtpPort: fake.smtpPort,
        tls: "tls",
        certificatePem: pinned.cert,
        certificateSha256: expectedSha256,
        username: USER,
        searchFolders: ["INBOX"],
      },
      vault,
    })
    return { fake, bridge }
  }

  it("connects through the pinned certificate on IMAP and SMTP", async () => {
    const { fake, bridge } = await bridgeFor(pinned)
    expect(await bridge.listFolders()).toContain("INBOX")
    await bridge.send({ to: ["guest@example.invalid"], text: "synthetic" })
    expect(fake.imapCommands).toContain("LOGIN <redacted>")
    expect(fake.smtpCommands.some((line) => line.startsWith("AUTH"))).toBe(true)
  })

  it("refuses a peer whose trusted certificate does not match the configured fingerprint", async () => {
    const { fake, bridge } = await bridgeFor(pinned, other.sha256)
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "handshake_failed",
    })
    expect(fake.imapLines.some((line) => line.includes("LOGIN"))).toBe(false)
  })

  it("refuses a different certificate before IMAP LOGIN or SMTP AUTH", async () => {
    const { fake, bridge } = await bridgeFor(other)
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "handshake_failed",
    })
    await expect(
      bridge.send({ to: ["guest@example.invalid"], text: "synthetic" })
    ).rejects.toMatchObject({ code: "handshake_failed" })
    expect(fake.imapLines.some((line) => line.includes("LOGIN"))).toBe(false)
    expect(fake.smtpLines.some((line) => line.startsWith("AUTH"))).toBe(false)
  })
})

describe("parseFallbackId", () => {
  it("splits core's fallback id, keeping colons in the folder", () => {
    expect(parseFallbackId("proton:Folders/a:b:1700000001:42")).toEqual({
      folder: "Folders/a:b",
      uidValidity: "1700000001",
      uid: 42,
    })
  })

  it.each([
    "<a@example.invalid>",
    "proton:INBOX:1:0",
    "proton:INBOX:x:1",
    "proton::1:2",
  ])("rejects %j", (id) => {
    expect(parseFallbackId(id)).toBeUndefined()
  })
})

describe("reads against the fake Bridge", () => {
  it("lists, selects and fetches a mailbox through modified UTF-7 paths", async () => {
    const folder = "Entwürfe & Arbeit"
    const { bridge, fake } = await start({
      mailboxes: {
        ...mailboxes(),
        [folder]: box(1700000042, [{ uid: 4, raw: first }]),
      },
    })

    expect(await bridge.listFolders()).toContain(folder)
    expect(await bridge.folderState(folder)).toEqual({
      uidValidity: "1700000042",
      uidNext: 5,
    })
    expect(await bridge.fetchRaw(folder, 1, 10)).toEqual({
      messages: [{ uid: 4, raw: first }],
      skipped: [],
    })
    expect(
      fake.imapCommands.some(
        (command) => command.startsWith("EXAMINE") && command.includes("&APw-")
      )
    ).toBe(true)
  })

  it("lists selectable folders only", async () => {
    const { bridge } = await start({ mailboxes: mailboxes() })
    expect((await bridge.listFolders()).sort()).toEqual([
      "Archive",
      "Drafts",
      "INBOX",
      "Trash",
    ])
  })

  it("returns a folder's UIDVALIDITY and UIDNEXT, and undefined for an unknown folder", async () => {
    const { bridge } = await start({ mailboxes: mailboxes() })
    expect(await bridge.folderState("INBOX")).toEqual({
      uidValidity: "1700000001",
      uidNext: 8,
    })
    expect(await bridge.folderState("Nowhere")).toBeUndefined()
  })

  it("fetches raw bytes from fromUid, ascending, within the limit, read-only", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    const page = await bridge.fetchRaw("INBOX", 1, 1)
    expect(page).toEqual({ messages: [{ uid: 3, raw: first }], skipped: [] })
    const rest = await bridge.fetchRaw("INBOX", 4, 10)
    expect(rest).toEqual({ messages: [{ uid: 7, raw: second }], skipped: [] })
    expect(await bridge.fetchRaw("INBOX", 8, 10)).toEqual({
      messages: [],
      skipped: [],
    })
    expect(fake.imapCommands.filter((c) => c.startsWith("SELECT"))).toEqual([])
    expect(
      fake.imapCommands.filter((c) => c.startsWith("EXAMINE"))
    ).toHaveLength(3)
  })

  it("returns undefined for an unknown folder without opening it", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    expect(await bridge.fetchRaw("Nowhere", 1, 10)).toBeUndefined()
    expect(fake.imapCommands.some((c) => c.startsWith("EXAMINE"))).toBe(false)
  })

  it("skips a message over the per-message cap and stops at the page budget", async () => {
    const big = Buffer.concat([
      first,
      Buffer.alloc(MAX_MESSAGE_BYTES + 1 - first.length, 0x61),
    ])
    const half = Buffer.concat([first, Buffer.alloc(17 * 1024 * 1024, 0x62)])
    const { bridge } = await start({
      mailboxes: {
        INBOX: box(1700000001, [
          { uid: 1, raw: big },
          { uid: 2, raw: first },
          { uid: 3, raw: half },
          { uid: 4, raw: half },
        ]),
        Drafts: box(1700000002, []),
        Trash: box(1700000003, []),
      },
    })
    const page = await bridge.fetchRaw("INBOX", 1, 10)
    // UID 1 is over 25 MiB; UID 4 would take the page past 32 MiB, so the page ends at UID 3.
    expect(page?.skipped).toEqual([1])
    expect(page?.messages.map((message) => message.uid)).toEqual([2, 3])
    expect(page?.messages[1]?.raw.length).toBe(half.length)
  })

  it("counts the real bytes of a message whose size Bridge omits toward the page cap", async () => {
    const half = Buffer.concat([first, Buffer.alloc(17 * 1024 * 1024, 0x62)])
    const { bridge } = await start({
      omitSize: true,
      mailboxes: {
        INBOX: box(1700000001, [
          { uid: 1, raw: half },
          { uid: 2, raw: half },
        ]),
        Drafts: box(1700000002, []),
        Trash: box(1700000003, []),
      },
    })
    const page = await bridge.fetchRaw("INBOX", 1, 10)
    // Both count as 0 by report, but 17 MiB twice passes 32 MiB: the page ends before UID 2.
    expect(page?.messages.map((message) => message.uid)).toEqual([1])
    const next = await bridge.fetchRaw("INBOX", 2, 10)
    expect(next?.messages.map((message) => message.uid)).toEqual([2])
  })

  it("does not report a later skipped UID past a message stopped by the real-byte budget", async () => {
    const half = Buffer.concat([first, Buffer.alloc(17 * 1024 * 1024, 0x62)])
    const big = Buffer.concat([
      first,
      Buffer.alloc(MAX_MESSAGE_BYTES + 1 - first.length, 0x61),
    ])
    const { bridge } = await start({
      mailboxes: {
        INBOX: box(1700000001, [
          { uid: 1, raw: half },
          { uid: 2, raw: half, reportedSize: 0 },
          { uid: 3, raw: big },
        ]),
        Drafts: box(1700000002, []),
        Trash: box(1700000003, []),
      },
    })
    const page = await bridge.fetchRaw("INBOX", 1, 10)
    expect(page?.messages.map((message) => message.uid)).toEqual([1])
    expect(page?.skipped).toEqual([])
    const next = await bridge.fetchRaw("INBOX", 2, 10)
    expect(next?.messages.map((message) => message.uid)).toEqual([2])
    expect(next?.skipped).toEqual([3])
  })

  it("skips a message over the per-message cap whose size Bridge omits", async () => {
    const big = Buffer.concat([
      first,
      Buffer.alloc(MAX_MESSAGE_BYTES + 1 - first.length, 0x61),
    ])
    const { bridge } = await start({
      omitSize: true,
      mailboxes: {
        INBOX: box(1700000001, [
          { uid: 1, raw: big },
          { uid: 2, raw: first },
        ]),
        Drafts: box(1700000002, []),
        Trash: box(1700000003, []),
      },
    })
    const page = await bridge.fetchRaw("INBOX", 1, 10)
    expect(page?.skipped).toEqual([1])
    expect(page?.messages).toEqual([{ uid: 2, raw: first }])
  })

  it("opens at most the configured number of sessions for parallel reads and refuses the rest", async () => {
    const fake = await startFakeBridge({
      username: USER,
      password: PASSWORD,
      mailboxes: mailboxes(),
      fetchDelayMs: 150,
    })
    opened.push(fake)
    const vault = new InMemoryVault()
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const bridge = createProtonBridge({
      config: config(fake),
      vault,
      maxConcurrentReads: 2,
    })
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => bridge.fetchRaw("INBOX", 1, 10))
    )
    const refused = results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof BridgeError &&
        result.reason.code === "busy"
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2)
    expect(refused).toHaveLength(3)
    expect(fake.imapSessions.peak).toBe(2)
    // The slots are free again once those reads end.
    expect((await bridge.fetchRaw("INBOX", 1, 10))?.messages).toHaveLength(2)
  })

  it("runs one mail read at a time by default, across read kinds", async () => {
    const fake = await startFakeBridge({
      username: USER,
      password: PASSWORD,
      mailboxes: mailboxes(),
      fetchDelayMs: 150,
    })
    opened.push(fake)
    const vault = new InMemoryVault()
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const bridge = createProtonBridge({ config: config(fake), vault })
    const [page, folders, state] = await Promise.allSettled([
      bridge.fetchRaw("INBOX", 1, 10),
      bridge.listFolders(),
      bridge.folderState("INBOX"),
    ])
    expect(page.status).toBe("fulfilled")
    expect(folders).toMatchObject({ status: "rejected" })
    expect(state).toMatchObject({ status: "rejected" })
    expect(fake.imapSessions.peak).toBe(1)
  })

  it("frees the read slot when a read fails", async () => {
    const { bridge, vault } = await start({ mailboxes: mailboxes() })
    await vault.set(BRIDGE_PASSWORD_KEY, "")
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "auth_failed",
    })
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    await expect(bridge.listFolders()).resolves.toContain("INBOX")
  })

  it("finds a message by Message-ID in the search folders, with its envelope", async () => {
    const { bridge } = await start({ mailboxes: mailboxes() })
    const found = await bridge.find("<second@example.invalid>")
    expect(found).toMatchObject({
      folder: "INBOX",
      uid: 7,
      raw: second,
      messageId: "<second@example.invalid>",
      references: "<first@example.invalid>",
      subject: "Two",
      from: [{ name: "Sender", address: "sender@example.invalid" }],
      replyTo: [{ name: "Desk", address: "desk@example.invalid" }],
      to: [{ name: "Owner", address: "owner@example.invalid" }],
      cc: [
        { name: "Carol", address: "carol@example.invalid" },
        { address: "dave@example.invalid" },
      ],
    })
  })

  it("matches the exact Message-ID, not a substring of another one", async () => {
    const { bridge } = await start({ mailboxes: mailboxes() })
    expect(await bridge.locate("second@example")).toBeUndefined()
    expect(await bridge.locate("<nobody@example.invalid>")).toBeUndefined()
  })

  it("locates core's fallback id only while the folder's UIDVALIDITY matches", async () => {
    const { bridge } = await start({ mailboxes: mailboxes() })
    expect(await bridge.locate("proton:INBOX:1700000001:3")).toEqual({
      folder: "INBOX",
      uid: 3,
    })
    expect(await bridge.locate("proton:INBOX:1600000000:3")).toBeUndefined()
    expect(await bridge.locate("proton:Nowhere:1700000001:3")).toBeUndefined()
    expect(await bridge.find("proton:INBOX:1700000001:5")).toBeUndefined()
  })

  it("does not locate a fallback id whose UID the folder does not hold", async () => {
    const { bridge } = await start({ mailboxes: mailboxes() })
    expect(await bridge.locate("proton:INBOX:1700000001:5")).toBeUndefined()
  })

  it("with a hash, finds only the message with exactly those bytes", async () => {
    const copy = rawMessage({
      messageId: "<first@example.invalid>",
      subject: "One",
      body: "planted",
    })
    const { bridge } = await start({
      mailboxes: {
        INBOX: box(1700000001, [
          { uid: 3, raw: first },
          { uid: 5, raw: copy },
        ]),
      },
    })
    expect(await bridge.find("<first@example.invalid>")).toMatchObject({
      uid: 3,
    })
    expect(
      await bridge.find("<first@example.invalid>", rawSha256(copy))
    ).toMatchObject({ uid: 5, raw: copy })
    expect(
      await bridge.find("proton:INBOX:1700000001:3", rawSha256(copy))
    ).toBeUndefined()
    expect(
      await bridge.find("<first@example.invalid>", "0f".repeat(32))
    ).toBeUndefined()
  })

  it("hashes raw bytes as lowercase hex SHA-256", () => {
    // SHA-256 of "abc" (FIPS 180-2, appendix B.1).
    expect(rawSha256(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })
})

describe("writes against the fake Bridge", () => {
  it("appends a draft to Drafts with the Draft flag", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    expect(await bridge.appendDraft(first)).toEqual({
      folder: "Drafts",
      uid: 1,
    })
    expect(fake.mailboxes.get("Drafts")?.messages).toEqual([
      { uid: 1, raw: first, flags: ["\\Draft", "\\Seen"] },
    ])
  })

  it("moves to Trash with UID MOVE, leaving messages already in Trash alone", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    expect(
      await bridge.moveToTrash([
        { folder: "INBOX", uid: 3 },
        { folder: "INBOX", uid: 7 },
        { folder: "Trash", uid: 1 },
      ])
    ).toEqual({ moved: 2 })
    expect(fake.mailboxes.get("INBOX")?.messages).toEqual([])
    expect(fake.mailboxes.get("Trash")?.messages.map((m) => m.raw)).toEqual([
      first,
      second,
    ])
    expect(fake.imapCommands.filter((c) => c.startsWith("UID MOVE"))).toEqual([
      "UID MOVE 3,7 Trash",
    ])
  })

  it("counts only the messages Bridge moved, and moves nothing when no UID exists", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    expect(
      await bridge.moveToTrash([
        { folder: "INBOX", uid: 3 },
        { folder: "INBOX", uid: 99 },
      ])
    ).toEqual({ moved: 1 })
    expect(await bridge.moveToTrash([{ folder: "INBOX", uid: 98 }])).toEqual({
      moved: 0,
    })
    expect(fake.imapCommands.filter((c) => c.startsWith("UID MOVE"))).toEqual([
      "UID MOVE 3 Trash",
    ])
  })

  it("refuses to move when Bridge lacks MOVE, so imapflow cannot fall back to flag and expunge", async () => {
    const { bridge, fake } = await start({
      mailboxes: mailboxes(),
      capabilities: ["IMAP4rev1", "UIDPLUS"],
    })
    await expect(
      bridge.moveToTrash([{ folder: "INBOX", uid: 3 }])
    ).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(fake.mailboxes.get("INBOX")?.messages).toHaveLength(2)
    expect(fake.imapCommands.some((c) => c.startsWith("SELECT"))).toBe(false)
  })

  it("fails a write when Bridge has no Drafts or Trash folder", async () => {
    const { bridge } = await start({
      mailboxes: { INBOX: box(1700000001, []) },
    })
    await expect(bridge.appendDraft(first)).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(bridge.moveToTrash([])).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("never sends EXPUNGE, CLOSE, STORE or a \\Deleted flag, and logs out of every session", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    await bridge.listFolders()
    await bridge.folderState("INBOX")
    await bridge.fetchRaw("INBOX", 1, 10)
    await bridge.find("<first@example.invalid>")
    await bridge.appendDraft(first)
    await bridge.moveToTrash([{ folder: "INBOX", uid: 3 }])
    expect(destructive(fake.imapCommands)).toEqual([])
    const logins = fake.imapCommands.filter(
      (c) => c === "LOGIN <redacted>"
    ).length
    const logouts = fake.imapCommands.filter((c) => c === "LOGOUT").length
    expect(logins).toBe(6)
    expect(logouts).toBe(6)
  })

  it("sends a text/calendar part from the assistant identity", async () => {
    const { bridge, fake } = await start()
    const invite = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:evt-1@example.invalid",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    const { messageId } = await bridge.send({
      to: ["guest@example.invalid"],
      subject: "Invitation",
      text: "lorem",
      icalEvent: { method: "REQUEST", content: invite },
    })
    expect(fake.sent).toHaveLength(1)
    const [mail] = fake.sent
    expect(mail?.from).toBe(USER)
    expect(mail?.to).toEqual(["guest@example.invalid"])
    expect(mail?.data).toMatch(/^From: assistant@example\.invalid$/m)
    expect(mail?.data).toMatch(
      /^Content-Type: text\/calendar; charset=utf-8; method=REQUEST$/m
    )
    expect(mail?.data).toContain(`Message-ID: ${messageId}`)
    expect(fake.smtpCommands[0]).toBe("EHLO localhost")
  })
})

describe("connection failures", () => {
  it("raises handshake_failed when Bridge refuses the connection, on IMAP and SMTP", async () => {
    const port = await closedPort()
    const vault = new InMemoryVault()
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const bridge = createProtonBridge({
      config: config({ imapPort: port, smtpPort: port }),
      vault,
    })
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "handshake_failed",
    })
    await expect(
      bridge.send({ to: ["a@example.invalid"], text: "x" })
    ).rejects.toMatchObject({
      code: "handshake_failed",
    })
  })

  it("raises auth_failed for a wrong password and does not log in with it again", async () => {
    const { bridge, fake } = await start(
      { mailboxes: mailboxes() },
      "wrong-password"
    )
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "auth_failed",
    })
    await expect(bridge.folderState("INBOX")).rejects.toMatchObject({
      code: "auth_failed",
    })
    await expect(
      bridge.send({ to: ["a@example.invalid"], text: "x" })
    ).rejects.toMatchObject({
      code: "auth_failed",
    })
    expect(
      fake.imapCommands.filter((c) => c === "LOGIN <redacted>")
    ).toHaveLength(1)
    expect(fake.smtpCommands).toEqual([])
  })

  it("tries again once the vault holds a new password", async () => {
    const { bridge, vault } = await start(
      { mailboxes: mailboxes() },
      "wrong-password"
    )
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "auth_failed",
    })
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    expect(await bridge.listFolders()).toContain("INBOX")
  })

  it("raises auth_failed when SMTP refuses the password, and remembers it", async () => {
    // The fake expects another password than the one in the vault; only send is called.
    const fake = await startFakeBridge({ username: USER, password: "other" })
    opened.push(fake)
    const vault = new InMemoryVault()
    await vault.set(BRIDGE_PASSWORD_KEY, PASSWORD)
    const bridge = createProtonBridge({ config: config(fake), vault })
    await expect(
      bridge.send({ to: ["a@example.invalid"], text: "x" })
    ).rejects.toMatchObject({
      code: "auth_failed",
    })
    await expect(
      bridge.send({ to: ["a@example.invalid"], text: "x" })
    ).rejects.toMatchObject({
      code: "auth_failed",
    })
    expect(fake.smtpCommands.filter((c) => c.startsWith("AUTH"))).toHaveLength(
      1
    )
  })

  it("raises auth_failed without connecting when the vault has no password", async () => {
    const { bridge, fake } = await start({}, null)
    await expect(bridge.listFolders()).rejects.toMatchObject({
      code: "auth_failed",
    })
    expect(fake.imapCommands).toEqual([])
  })

  it("sends the password only in the login of each session, and never in an error", async () => {
    const { bridge, fake } = await start({ mailboxes: mailboxes() })
    await bridge.listFolders()
    await bridge.send({ to: ["a@example.invalid"], text: "x" })
    // What each line carries, raw and base64-decoded (SMTP AUTH sends base64).
    const carries = (line: string) =>
      [
        line,
        ...line
          .split(" ")
          .map((word) => Buffer.from(word, "base64").toString("utf8")),
      ].some((text) => text.includes(PASSWORD))
    expect(fake.imapLines.filter(carries)).toEqual([
      expect.stringMatching(/^\S+ LOGIN /),
    ])
    expect(fake.smtpLines.filter(carries)).toEqual([
      expect.stringMatching(/^AUTH PLAIN /),
    ])
    const wrong = await start({}, "wrong-password-0b1d")
    const error: unknown = await wrong.bridge
      .listFolders()
      .catch((e: unknown) => e)
    expect(String(error)).not.toContain("wrong-password-0b1d")
    expect(JSON.stringify(error)).not.toContain("wrong-password-0b1d")
  })
})
