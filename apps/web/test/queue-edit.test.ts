import { describe, expect, test } from "vitest"
import {
  buildEditedIntent,
  editRefusalMessage,
  editableFields,
  hasEdits,
} from "../lib/queue/edit"

const PAYLOAD = JSON.stringify({
  kind: "email.reply",
  args: {
    messageId: "m-1",
    messageSha256: "ab".repeat(32),
    to: ["a@example.invalid", "b@example.invalid"],
    subject: "Re: quote",
    body: "Hello",
    replyAll: false,
  },
})

describe("editableFields", () => {
  test("offers text and list arguments, long text as a block, and nothing else", () => {
    expect(editableFields(PAYLOAD)).toEqual([
      {
        key: "to",
        label: "To",
        type: "list",
        initial: "a@example.invalid, b@example.invalid",
      },
      { key: "subject", label: "Subject", type: "text", initial: "Re: quote" },
      { key: "body", label: "Message", type: "block", initial: "Hello" },
    ])
  })

  test("a payload that is not an intent has nothing to edit", () => {
    expect(editableFields("not json")).toEqual([])
    expect(editableFields(JSON.stringify({ args: { to: "x" } }))).toEqual([])
  })
})

describe("buildEditedIntent", () => {
  test("puts the edited values in and keeps every other argument as it was", () => {
    expect(
      buildEditedIntent(PAYLOAD, {
        to: "c@example.invalid ,  d@example.invalid,",
        body: "Hi",
      })
    ).toEqual({
      kind: "email.reply",
      args: {
        messageId: "m-1",
        messageSha256: "ab".repeat(32),
        to: ["c@example.invalid", "d@example.invalid"],
        subject: "Re: quote",
        body: "Hi",
        replyAll: false,
      },
    })
  })

  test("is undefined for a payload that cannot be read", () => {
    expect(buildEditedIntent("{", {})).toBeUndefined()
  })
})

describe("hasEdits", () => {
  test("is false until a value differs from the card", () => {
    expect(hasEdits(PAYLOAD, {})).toBe(false)
    expect(hasEdits(PAYLOAD, { subject: "Re: quote" })).toBe(false)
    expect(hasEdits(PAYLOAD, { subject: "Re: new" })).toBe(true)
  })
})

describe("editRefusalMessage", () => {
  test.each([
    [
      "tier_changed",
      "Edit refused. This change moves the intent to a different tier. Reject it and ask again instead.",
    ],
    ["forbidden", "Edit refused. Policy forbids the edited intent."],
    [
      "invalid_request",
      "Edit refused. The edited values are not a valid intent.",
    ],
    ["network", "from the gate"],
  ])("%s", (code, message) => {
    expect(editRefusalMessage({ code, message: "from the gate" })).toBe(message)
  })
})
