import { describe, expect, test } from "vitest"
import { parseMessage } from "./mail/parse"
import { extractAddresses, replyRecipients } from "./reply-target"
import type { StoredAddress } from "./reply-target"

const bytes = (lines: string[]) =>
  new TextEncoder().encode(lines.join("\r\n") + "\r\n")

describe("extractAddresses", () => {
  test("reads From, Reply-To, To and Cc in header order, flattening groups", async () => {
    const found = extractAddresses(
      await parseMessage(
        bytes([
          "From: Ada <ada@example.com>",
          "Reply-To: desk@example.com",
          "To: team: bob@example.com, carol@example.com;, dan@example.com",
          "Cc: eve@example.com",
          "Subject: x",
          "",
          "body",
        ])
      )
    )
    expect(found).toEqual([
      { role: "from", address: "ada@example.com" },
      { role: "reply_to", address: "desk@example.com" },
      { role: "to", address: "bob@example.com" },
      { role: "to", address: "carol@example.com" },
      { role: "to", address: "dan@example.com" },
      { role: "cc", address: "eve@example.com" },
    ])
  })

  test("a message with no address headers yields none", async () => {
    expect(
      extractAddresses(await parseMessage(bytes(["Subject: x", "", "body"])))
    ).toEqual([])
  })
})

describe("replyRecipients", () => {
  const at = (role: StoredAddress["role"], address: string): StoredAddress => ({
    role,
    address,
  })

  test("reply-all with no sender at all falls back to the other recipients as To", () => {
    expect(
      replyRecipients(
        [at("to", "assistant@example.com"), at("to", "bob@example.com")],
        true,
        "Assistant@Example.com"
      )
    ).toEqual({ to: ["bob@example.com"], cc: [] })
  })

  test("a reply to the assistant's own message has no recipient", () => {
    expect(
      replyRecipients(
        [at("from", "ASSISTANT@example.com")],
        false,
        "assistant@example.com"
      )
    ).toEqual({ to: [], cc: [] })
  })
})
