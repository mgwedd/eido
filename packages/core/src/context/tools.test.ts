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

  test("a todo or project request is offered the two Things kinds that need no id", () => {
    for (const text of [
      "add a todo to call the dentist",
      "add a to-do: renew passport",
      "create a task for the report",
      "start a new project called Garden",
    ])
      expect(
        names(selectTools({ text, task: "propose" }, CATALOG)).filter((n) =>
          n.startsWith("things.")
        )
      ).toEqual(["things.add_project", "things.add_todo"])
  })

  test("an email-only request is not offered Things kinds", () => {
    expect(
      names(
        selectTools(
          { text: "archive the invoice emails", task: "propose" },
          CATALOG
        )
      ).filter((n) => n.startsWith("things."))
    ).toEqual([])
  })

  test("a file name or a projects folder does not open the Things kinds", () => {
    for (const text of [
      "Create a file notes/todo.txt containing hello",
      "In the projects folder, rename a.txt to b.txt",
      'Create a calendar meeting "Project kickoff" on the work calendar',
    ])
      expect(detectAreas(text)).not.toContain("things")
  })

  test("the id-dependent Things kinds are never offered, whatever the request says", () => {
    const idKinds = [
      "things.cancel_todo",
      "things.complete_todo",
      "things.schedule_todo",
      "things.update_todo",
    ]
    for (const task of ["propose", "ask"] as const)
      expect(
        names(
          selectTools(
            {
              text: "complete, cancel, reschedule and update my todo task, and add a new project",
              task,
            },
            CATALOG
          )
        ).filter((n) => idKinds.includes(n))
      ).toEqual([])
    expect(INTENT_KINDS).toEqual(expect.arrayContaining(idKinds))
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
    expect(detectAreas("add a todo and email it")).toEqual(["email", "things"])
    expect(detectAreas("nothing relevant")).toEqual([])
  })
})
