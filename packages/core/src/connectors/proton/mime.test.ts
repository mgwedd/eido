import { describe, expect, test } from "vitest"
import { attachmentText, buildMessage, decodeWords, parseMessage } from "./mime"

const crlf = (lines: string[]): Buffer => Buffer.from(lines.join("\r\n"))

describe("parseMessage", () => {
  test("reads headers, addresses and the plain body", () => {
    const parsed = parseMessage(
      crlf([
        'From: "Example, Alex" <alex@example.com>',
        "To: a@example.com, Bo <bo@example.com>",
        "Cc: c@example.com",
        "Subject: =?UTF-8?B?Q2Fmw6k=?= plans",
        "Date: Mon, 05 Oct 2026 10:00:00 +0000",
        "Message-ID: <m1@example.com>",
        "In-Reply-To: <m0@example.com>",
        "References: <m00@example.com>",
        " <m0@example.com>",
        "",
        "Hello there",
      ])
    )
    expect(parsed).toMatchObject({
      messageId: "<m1@example.com>",
      inReplyTo: "<m0@example.com>",
      references: ["<m00@example.com>", "<m0@example.com>"],
      subject: "Café plans",
      date: "2026-10-05T10:00:00.000Z",
      text: "Hello there",
    })
    expect(parsed.from).toEqual([
      { name: "Example, Alex", address: "alex@example.com" },
    ])
    expect(parsed.to).toEqual([
      { address: "a@example.com" },
      { name: "Bo", address: "bo@example.com" },
    ])
    expect(parsed.cc).toEqual([{ address: "c@example.com" }])
  })

  test("decodes quoted-printable text in a declared charset", () => {
    const parsed = parseMessage(
      crlf([
        "Subject: s",
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "caf=E9 soft=",
        "break",
      ])
    )
    expect(parsed.text).toBe("café softbreak")
  })

  test("falls back to utf-8 for an unknown charset and to html when there is no plain part", () => {
    const parsed = parseMessage(
      crlf([
        "Content-Type: text/html; charset=nonsense-9",
        "",
        "<p>Hi &amp; bye</p><script>x()</script>",
      ])
    )
    expect(parsed.text).toBe("Hi & bye")
  })

  test("splits a multipart message into text and attachments", () => {
    const parsed = parseMessage(
      crlf([
        "Subject: s",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--B",
        'Content-Type: text/csv; name="a.csv"',
        "Content-Disposition: attachment; filename=a.csv",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("x,y\n1,2\n").toString("base64"),
        "--B",
        "Content-Type: application/pdf",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("%PDF").toString("base64"),
        "--B--",
        "",
      ])
    )
    expect(parsed.text).toBe("see attached")
    expect(
      parsed.attachments.map((a) => [a.index, a.filename, a.mime])
    ).toEqual([
      [0, "a.csv", "text/csv"],
      [1, "part-2", "application/pdf"],
    ])
    const [csv, pdf] = parsed.attachments
    expect(attachmentText(csv!)).toBe("x,y\n1,2\n")
    expect(attachmentText(pdf!)).toBeNull()
  })

  test("tolerates LF-only messages and a missing body", () => {
    expect(parseMessage(Buffer.from("Subject: a\n\nbody\n")).text).toBe("body")
    expect(parseMessage(Buffer.from("Subject: only headers")).subject).toBe(
      "only headers"
    )
  })

  test("a bad Date and a header without an id yield no date and no ids", () => {
    const parsed = parseMessage(
      crlf(["Date: not a date", "Message-ID: nothing", "", "x"])
    )
    expect(parsed.date).toBeUndefined()
    expect(parsed.messageId).toBeUndefined()
  })

  test("decodes Q-encoded words and joins adjacent ones", () => {
    expect(decodeWords("=?utf-8?Q?caf=C3=A9_au?= =?utf-8?Q?_lait?=")).toBe(
      "café au lait"
    )
  })
})

describe("attachmentText", () => {
  const part = (mime: string, text: string) => ({
    index: 0,
    filename: "f",
    mime,
    data: Buffer.from(text),
  })
  test("strips html and reads calendar and xml parts", () => {
    expect(attachmentText(part("text/html", "<b>hi</b>"))).toBe("hi")
    expect(attachmentText(part("text/calendar", "BEGIN:VCALENDAR"))).toBe(
      "BEGIN:VCALENDAR"
    )
    expect(attachmentText(part("application/json", "{}"))).toBe("{}")
    expect(attachmentText(part("image/svg+xml", "<svg/>"))).toBe("<svg/>")
    expect(attachmentText(part("application/xml", "<a/>"))).toBe("<a/>")
    expect(attachmentText(part("image/png", "x"))).toBeNull()
  })
})

describe("buildMessage", () => {
  const base = {
    from: "assistant@example.com",
    to: ["a@example.com"],
    subject: "Hi",
    text: "Body line",
    date: new Date("2026-10-05T10:00:00Z"),
  }

  test("round-trips through parseMessage and keeps Bcc out of the headers", () => {
    const { raw, messageId } = buildMessage({
      ...base,
      cc: ["c@example.com"],
      bcc: ["secret@example.com"],
      subject: "Café",
      inReplyTo: "<p@example.com>",
      references: ["<p@example.com>"],
    })
    expect(raw).not.toContain("secret@example.com")
    expect(raw.endsWith("\r\n")).toBe(true)
    const parsed = parseMessage(Buffer.from(raw))
    expect(parsed).toMatchObject({
      messageId,
      subject: "Café",
      text: "Body line",
      inReplyTo: "<p@example.com>",
    })
    expect(parsed.from).toEqual([{ address: "assistant@example.com" }])
    expect(parsed.cc).toEqual([{ address: "c@example.com" }])
  })

  test("a calendar invitation is a text/calendar alternative with its method", () => {
    const { raw } = buildMessage({
      ...base,
      calendar: { method: "REQUEST", ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" },
    })
    expect(raw).toContain("Content-Type: multipart/alternative")
    expect(raw).toContain('text/calendar; charset="utf-8"; method=REQUEST')
    const parsed = parseMessage(Buffer.from(raw))
    expect(parsed.text).toBe("Body line")
    expect(attachmentText(parsed.attachments[0]!)).toBe(
      "BEGIN:VCALENDAR\r\nEND:VCALENDAR"
    )
  })

  test("refuses a header value with a line break", () => {
    expect(() =>
      buildMessage({ ...base, subject: "x\r\nBcc: evil@example.com" })
    ).toThrow(/line break/)
  })
})
