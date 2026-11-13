import { describe, expect, it } from "vitest"

import { describeIntent } from "./audit-description"
import { sample } from "./test-fixtures"

const json = (value: unknown) => JSON.stringify(value)

describe("describeIntent", () => {
  it("counts the messages and names the connector for mark read", () => {
    const intent = sample("email.markRead", {
      messageIds: ["a", "b", "c", "d"],
      read: true,
    })
    expect(describeIntent(json({ ...intent, connector: "gmail" }))).toBe(
      "Marked 4 messages read in Gmail"
    )
  })

  it("says unread when the flag is cleared, singular for one message", () => {
    const intent = sample("email.markRead", { messageIds: ["a"], read: false })
    expect(describeIntent(json({ ...intent, connector: "gmail" }))).toBe(
      "Marked 1 message unread in Gmail"
    )
  })

  it("leaves the connector out when it is not a known one", () => {
    const intent = sample("email.archive", { messageIds: ["a", "b"] })
    expect(describeIntent(json({ ...intent, connector: "other-mail" }))).toBe(
      "Archived 2 messages"
    )
  })

  it("never repeats message ids or other args in the sentence", () => {
    const intent = sample("email.trash", { messageIds: ["secret-id-77"] })
    expect(describeIntent(json(intent))).toBe("Moved 1 message to trash")
  })

  it("describes a Things to-do without its title", () => {
    const intent = sample("things.add_todo", { title: "Call the landlord" })
    expect(describeIntent(json(intent))).toBe("Added a to-do in Things")
  })

  it.each([
    ["email.label", "Changed labels on 1 message"],
    ["email.untrash", "Restored 1 message from trash"],
    ["things.complete_todo", "Completed a to-do in Things"],
    ["things.cancel_todo", "Cancelled a to-do in Things"],
    ["things.update_todo", "Updated a to-do in Things"],
    ["things.schedule_todo", "Scheduled a to-do in Things"],
    ["things.add_project", "Added a project in Things"],
    ["reminder.create", "Added a reminder"],
  ] as const)("describes %s", (kind, sentence) => {
    expect(describeIntent(json(sample(kind)))).toBe(sentence)
  })

  it("returns undefined for a kind with no sentence", () => {
    expect(describeIntent(json(sample("file.delete")))).toBeUndefined()
  })

  it("returns undefined for text that is not an intent", () => {
    expect(describeIntent("not json")).toBeUndefined()
    expect(describeIntent(json({ kind: "email.archive" }))).toBeUndefined()
  })
})
