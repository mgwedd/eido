import { describe, expect, test } from "vitest"
import { htmlToText } from "./html-text"
import { raw } from "./memory-source.test-support"
import { attachmentText, isTextMime, parseMessage } from "./parse"

const headers = [
  "From: Ada Example <ada@example.com>",
  "To: Bo Example <bo@example.com>, Team: cy@example.com, di@example.com;",
  "Cc: <ed@example.com>",
  "Subject: Lunch",
  "Message-ID: <m1@example.com>",
  "In-Reply-To: <m0@example.com>",
  "References: <m00@example.com> <m0@example.com>",
  "Date: Mon, 05 Oct 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
]

describe("parseMessage", () => {
  test("multipart: a quoted-printable part in ISO-8859-1, soft line breaks, and a text attachment", async () => {
    const parsed = await parseMessage(
      raw([
        ...headers,
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=iso-8859-1",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Caf=E9 menu=3D today, soft=",
        " break",
        "--b1",
        'Content-Type: text/csv; name="menu.csv"',
        'Content-Disposition: attachment; filename="menu.csv"',
        "Content-Transfer-Encoding: base64",
        "",
        "aXRlbSxwcmljZQpzb3VwLDQK",
        "--b1--",
      ])
    )
    expect(parsed.text).toBe("Café menu= today, soft break")
    expect(parsed.subject).toBe("Lunch")
    expect(parsed.messageId).toBe("<m1@example.com>")
    expect(parsed.inReplyTo).toBe("<m0@example.com>")
    expect(parsed.references).toEqual(["<m00@example.com>", "<m0@example.com>"])
    expect(parsed.date).toBe("2026-10-05T10:00:00.000Z")
    expect(parsed.from).toEqual([
      { name: "Ada Example", address: "ada@example.com" },
    ])
    expect(parsed.to).toEqual([
      { name: "Bo Example", address: "bo@example.com" },
      { address: "cy@example.com" },
      { address: "di@example.com" },
    ])
    expect(parsed.cc).toEqual([{ address: "ed@example.com" }])
    expect(parsed.attachments).toHaveLength(1)
    const [attachment] = parsed.attachments
    expect(attachment).toMatchObject({ filename: "menu.csv", mime: "text/csv" })
    expect(attachment === undefined ? null : attachmentText(attachment)).toBe(
      "item,price\nsoup,4\n"
    )
  })

  test("a non-UTF-8 charset (windows-1251, base64) decodes to the right characters", async () => {
    const parsed = await parseMessage(
      raw([
        ...headers,
        "Content-Type: text/plain; charset=windows-1251",
        "Content-Transfer-Encoding: base64",
        "",
        "z/Do4uXy",
      ])
    )
    expect(parsed.text).toBe("Привет")
  })

  test("an HTML-only body becomes the visible text", async () => {
    const parsed = await parseMessage(
      raw([
        ...headers,
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><head><title>x</title></head><body><p>Hello &amp; <b>bye</b></p><p>second&nbsp;line</p><style>p{color:red}</style></body></html>",
      ])
    )
    expect(parsed.text).toBe("Hello & bye\n\nsecond line")
  })

  test("a binary attachment has no text, and an unnamed one gets a positional name", async () => {
    const parsed = await parseMessage(
      raw([
        "Subject: Logo",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b2"',
        "",
        "--b2",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b2",
        "Content-Type: image/png",
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        "iVBORw0KGgo=",
        "--b2--",
      ])
    )
    expect(parsed.text).toBe("see attached")
    expect(parsed.messageId).toBeUndefined()
    expect(parsed.from).toEqual([])
    const [png] = parsed.attachments
    expect(png).toMatchObject({ filename: "attachment-1", mime: "image/png" })
    expect(png?.content).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    expect(png === undefined ? "x" : attachmentText(png)).toBeNull()
  })

  test("an HTML attachment is reduced to text", () => {
    expect(
      attachmentText({
        filename: "a.html",
        mime: "text/html",
        content: new TextEncoder().encode("<p>one</p><p>two</p>"),
      })
    ).toBe("one\n\ntwo")
  })
})

describe("isTextMime", () => {
  test.each([
    ["text/plain", true],
    ["application/json", true],
    ["image/png", false],
    ["application/pdf", false],
  ])("%s -> %s", (mime, expected) => {
    expect(isTextMime(mime)).toBe(expected)
  })
})

describe("htmlToText", () => {
  test.each([
    ["a<br>b", "a\nb"],
    ["<script>alert(1)</script>kept", "kept"],
    ["x &#65;&#x42; &lt;tag&gt; &unknown; &#0;", "x AB <tag> &unknown; &#0;"],
    ["1 & 2", "1 & 2"],
    ["<h1>Title</h1>body", "Title\nbody"],
    ["text <unclosed", "text"],
    ["<p>a</p><p></p><p></p><p></p>b", "a\n\nb"],
  ])("%j", (html, expected) => {
    expect(htmlToText(html)).toBe(expected)
  })
})
