import { INTENT_KINDS } from "@eido/schemas"
import { describe, expect, test } from "vitest"
import type { ToolDef } from "../inference/types"
import { detectAreas, selectTools } from "./tools"

const tool = (name: string): ToolDef => ({
  type: "function",
  function: { name },
})

// The intent verbs from the schemas, plus read verbs a caller adds for lookups.
const READS = ["index.search", "email.read", "calendar.list"]
const CATALOG: ToolDef[] = [...INTENT_KINDS, ...READS].map(tool)
const names = (tools: ToolDef[]) => tools.map((t) => t.function.name)

describe("selectTools", () => {
  test("an email request gets the email verbs and read verbs, no calendar or file writes", () => {
    expect(
      names(
        selectTools(
          { text: "archive the invoice emails from John", task: "propose" },
          CATALOG
        )
      )
    ).toEqual([
      "calendar.list",
      "email.archive",
      "email.draft",
      "email.forward",
      "email.label",
      "email.markRead",
      "email.read",
      "email.reply",
      "email.send",
      "email.trash",
      "index.search",
    ])
  })

  test("an unrecognized request gets read verbs only", () => {
    expect(
      names(
        selectTools({ text: "what about tomorrow?", task: "propose" }, CATALOG)
      )
    ).toEqual(["calendar.list", "email.read", "index.search"])
  })

  test("an ask request never gets a write verb", () => {
    expect(
      names(
        selectTools(
          { text: "archive the invoice emails", task: "ask" },
          CATALOG
        )
      )
    ).toEqual(["calendar.list", "email.read", "index.search"])
  })

  test("calendar requests include reminders; file requests get file verbs", () => {
    expect(
      names(
        selectTools(
          { text: "set a reminder for the meeting", task: "propose" },
          [
            tool("reminder.create"),
            tool("calendar.create"),
            tool("file.create"),
          ]
        )
      )
    ).toEqual(["calendar.create", "reminder.create"])
    expect(
      names(
        selectTools(
          { text: "rename the PDF", task: "propose" },
          CATALOG.filter((t) => !READS.includes(t.function.name))
        )
      )
    ).toEqual(["file.create", "file.delete", "file.move", "file.rename"])
  })

  test("money-movement and permanent-delete verbs are never returned", () => {
    const hostile = [
      "email.payment",
      "bank.transfer",
      "email.permanentDelete",
      "file.purge",
      "payments.list",
    ].map(tool)
    expect(
      selectTools(
        { text: "pay the invoice email and purge the file", task: "propose" },
        [...hostile, tool("email.archive")]
      ).map((t) => t.function.name)
    ).toEqual(["email.archive"])
  })

  test("a write verb with no known area is never returned", () => {
    expect(
      selectTools({ text: "email the team", task: "propose" }, [
        tool("crm.update"),
        tool(""),
      ])
    ).toEqual([])
  })

  test("a gate-derived restore intent is never offered to the model", () => {
    expect(
      names(
        selectTools({ text: "restore the trashed email", task: "propose" }, [
          tool("email.untrash"),
          tool("email.trash"),
        ])
      )
    ).toEqual(["email.trash"])
  })

  test("output order does not depend on catalog order", () => {
    const request = {
      text: "reply to the email and book a meeting",
      task: "propose",
    } as const
    const forward = names(selectTools(request, CATALOG))
    const reversed = names(selectTools(request, [...CATALOG].reverse()))
    expect(reversed).toEqual(forward)
    expect(forward).toEqual([...forward].sort())
  })
})

describe("detectAreas", () => {
  test("finds each area by keyword", () => {
    expect(detectAreas("move the meeting and file the report")).toEqual([
      "calendar",
      "files",
    ])
    expect(detectAreas("nothing relevant")).toEqual([])
  })
})
