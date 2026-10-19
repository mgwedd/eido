import { describe, expect, test } from "vitest"
import { assertAllowed, imap, quote } from "./imap-commands"
import type { ImapCommand } from "./imap-commands"

const all: ImapCommand[] = [
  imap.capability(),
  imap.noop(),
  imap.logout(),
  imap.startTls(),
  imap.listFolders(),
  imap.select("INBOX"),
  imap.selectWritable("Folders/Work"),
  imap.fetchRange(1, 50),
  imap.fetchHeaderRange(1, 50),
  imap.fetchOne(7),
  imap.searchMessageId("<a@example.com>"),
  imap.moveToTrash([3, 4], "Trash"),
  imap.appendDraft("Drafts", Buffer.from("Subject: x\r\n\r\ny\r\n")),
]

describe("command builders", () => {
  test("builds the exact lines the server sees", () => {
    expect(all.map((c) => c.text)).toEqual([
      "CAPABILITY",
      "NOOP",
      "LOGOUT",
      "STARTTLS",
      'LIST "" "*"',
      'EXAMINE "INBOX"',
      'SELECT "Folders/Work"',
      "UID FETCH 1:50 (UID BODY.PEEK[])",
      "UID FETCH 1:50 (UID BODY.PEEK[HEADER])",
      "UID FETCH 7 (UID BODY.PEEK[])",
      'UID SEARCH HEADER Message-ID "<a@example.com>"',
      'UID MOVE 3,4 "Trash"',
      'APPEND "Drafts" (\\Draft) {18}',
    ])
  })

  test("no builder yields EXPUNGE, DELETE, a \\Deleted flag or STORE", () => {
    for (const command of all) {
      expect(command.text).not.toMatch(/EXPUNGE|DELETE|\\Deleted|STORE/i)
      expect(() => assertAllowed(command)).not.toThrow()
    }
  })

  test("a draft is appended with the message as a literal, only APPEND carries one", () => {
    const append = imap.appendDraft("Drafts", Buffer.from("abc"))
    expect(Buffer.from(append.literal ?? []).toString()).toBe("abc")
    expect(() =>
      assertAllowed({ text: "NOOP", literal: Buffer.from("x") })
    ).toThrow(/only APPEND/)
  })
})

describe("assertAllowed", () => {
  test.each([
    "EXPUNGE",
    "UID EXPUNGE 1:*",
    'DELETE "Trash"',
    "UID STORE 1 +FLAGS (\\Deleted)",
    'UID COPY 1 "Trash"',
    "CLOSE",
    'UID MOVE 1 "Trash" EXPUNGE',
    'SELECT "INBOX" ; DELETE "x"',
    'UID SEARCH HEADER Message-ID "<a>" EXPUNGE',
    "UID FETCH 1:2 (UID BODY[])",
  ])("refuses %s", (text) => {
    expect(() => assertAllowed({ text })).toThrowError(
      expect.objectContaining({ code: "unsafe_command" })
    )
  })
})

describe("arguments", () => {
  test("quotes and escapes", () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"')
  })

  test.each(["a\r\nb", "tab\there", "café", "nul\0"])(
    "refuses an argument with %j",
    (value) => {
      expect(() => quote(value)).toThrowError(
        expect.objectContaining({ code: "unsafe_command" })
      )
    }
  )

  test.each([0, -1, 1.5, Number.NaN])("refuses UID %s", (value) => {
    expect(() => imap.fetchOne(value)).toThrow(/positive integer/)
  })

  test("refuses a move of no messages", () => {
    expect(() => imap.moveToTrash([], "Trash")).toThrow(/no UIDs/)
  })

  test("a folder name cannot smuggle a second command", () => {
    const command = imap.select('INBOX" DELETE "y')
    expect(command.text).toBe('EXAMINE "INBOX\\" DELETE \\"y"')
    expect(() => assertAllowed(command)).not.toThrow()
    expect(() => imap.select('INBOX"\r\nX DELETE "y')).toThrow(
      /unsupported character/
    )
  })
})
