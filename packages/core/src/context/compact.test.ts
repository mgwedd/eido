import { describe, expect, test } from "vitest"
import { compactMessage } from "./compact"

const base = {
  from: "ada.quill@example.invalid",
  to: ["bram.oster@example.invalid", "cleo.varn@example.invalid"],
  date: "2030-01-02T09:00:00.000Z",
  subject: "Budget review",
}
const HEAD =
  "ada.quill@example.invalid | bram.oster@example.invalid, cleo.varn@example.invalid | 2030-01-02T09:00:00.000Z | Budget review"

const compact = (body: string) => compactMessage({ ...base, body })

describe("compactMessage", () => {
  test("a reply loses its attribution line, the quoted chain and stray > lines", () => {
    const result = compact(
      [
        "Thanks, the numbers look right.",
        "> one stray quote",
        "Let us meet Friday.",
        "",
        "On Mon, Jan 1, 2030 at 9:00 AM Bram Oster <bram.oster@example.invalid> wrote:",
        "> Here are the numbers.",
        "> > Older text.",
      ].join("\n")
    )
    expect(result.text).toBe(
      `${HEAD}\nThanks, the numbers look right.\nLet us meet Friday.`
    )
    expect(result.removed).toEqual({
      quotes: 4,
      signature: false,
      footer: false,
      tracking: 0,
    })
  })

  test("an attribution wrapped onto two lines is still recognised", () => {
    const result = compact(
      "New text.\nOn Mon, Jan 1, 2030 at 9:00 AM Bram Oster\n<bram.oster@example.invalid> wrote:\n> old"
    )
    expect(result.text).toBe(`${HEAD}\nNew text.`)
    expect(result.removed.quotes).toBe(3)
  })

  test("an -----Original Message----- block is removed with everything below it", () => {
    const result = compact(
      "See below.\n\n-----Original Message-----\nFrom: Bram Oster\nSent: Monday\nOld body"
    )
    expect(result.text).toBe(`${HEAD}\nSee below.`)
    expect(result.removed.quotes).toBe(4)
  })

  test("a -- signature is removed and the new content kept", () => {
    const result = compact(
      "The draft is attached.\n\n-- \nAda Quill\nHead of Operations\n+00 000 000"
    )
    expect(result.text).toBe(`${HEAD}\nThe draft is attached.`)
    expect(result.removed).toEqual({
      quotes: 0,
      signature: true,
      footer: false,
      tracking: 0,
    })
  })

  test("a Sent from my ... line is removed as a signature", () => {
    const result = compact("On my way.\n\nSent from my phone")
    expect(result.text).toBe(`${HEAD}\nOn my way.`)
    expect(result.removed.signature).toBe(true)
  })

  test("a legal disclaimer paragraph is removed and the content kept", () => {
    const result = compact(
      [
        "Please sign the contract by Friday.",
        "",
        "CONFIDENTIALITY NOTICE: This message is confidential and intended solely for the",
        "addressee. If you are not the intended recipient, notify the sender.",
        "",
        "Disclaimer: views expressed are the sender's own.",
      ].join("\n")
    )
    expect(result.text).toBe(`${HEAD}\nPlease sign the contract by Friday.`)
    expect(result.removed).toEqual({
      quotes: 0,
      signature: false,
      footer: true,
      tracking: 0,
    })
  })

  test("an unsubscribe block is a footer, but a request mentioning unsubscribe is content", () => {
    expect(
      compact(
        "Our spring catalogue is out.\n\nTo unsubscribe click here: https://news.example.invalid/u?id=1"
      ).text
    ).toBe(`${HEAD}\nOur spring catalogue is out.`)
    expect(compact("Can you unsubscribe me from this?").text).toBe(
      `${HEAD}\nCan you unsubscribe me from this?`
    )
  })

  test("a tracking URL and a view-in-browser line are removed; a plain URL stays", () => {
    const result = compact(
      [
        "View this email in your browser",
        "The report is ready: https://reports.example.invalid/q1",
        "Read more https://news.example.invalid/a?utm_source=mail&utm_medium=x",
        "<https://t.example.invalid/open?pixel=1>",
      ].join("\n")
    )
    expect(result.text).toBe(
      `${HEAD}\nThe report is ready: https://reports.example.invalid/q1\nRead more\n<>`
    )
    expect(result.removed).toEqual({
      quotes: 0,
      signature: false,
      footer: false,
      tracking: 3,
    })
  })

  test("a URL that does not parse is kept as text", () => {
    expect(compact("Go to https://[bad").text).toBe(
      `${HEAD}\nGo to https://[bad`
    )
  })

  test("an all-quoted message keeps its original body unchanged", () => {
    const body = "> Only quoted text.\r\n> Nothing new."
    const result = compact(body)
    expect(result.text).toBe(`${HEAD}\n${body}`)
    expect(result.removed).toEqual({
      quotes: 0,
      signature: false,
      footer: false,
      tracking: 0,
    })
  })

  test("a sentence ending in wrote: that is not an attribution is kept", () => {
    expect(compact("She wrote: the plan is fine.").text).toBe(
      `${HEAD}\nShe wrote: the plan is fine.`
    )
    expect(
      compact(
        "On reflection the team that wrote the memo\nwas right, they wrote:"
      ).text
    ).toBe(
      `${HEAD}\nOn reflection the team that wrote the memo\nwas right, they wrote:`
    )
  })
})
