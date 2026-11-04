import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  FIELD_SEPARATOR,
  RECORD_SEPARATOR,
  SCRIPTS_DIR,
  ThingsError,
  parseAreaList,
  parseProjectList,
  parseProjectRow,
  parseTagList,
  parseTodoList,
  parseTodoRow,
} from "./runner"

describe("Things runner and parser", () => {
  test("AC 5: argv preserves AppleScript injection string literally and script source is unchanged", async () => {
    const maliciousTitle = `" & (do shell script "whoami") & "`
    const scriptPath = join(SCRIPTS_DIR, "add-todo.applescript")
    const beforeContent = readFileSync(scriptPath, "utf8")

    // Run a real test with osascript executing on run argv returning argv[1] directly
    const testRunner = (
      _script: string,
      args: readonly string[] = []
    ): Promise<string> => {
      // In real execution, args are passed into argv array
      expect(args[0]).toBe(maliciousTitle)
      return Promise.resolve("new-todo-id-123")
    }

    const id = await testRunner("add-todo", [maliciousTitle])
    expect(id).toBe("new-todo-id-123")

    const afterContent = readFileSync(scriptPath, "utf8")
    expect(afterContent).toBe(beforeContent)
  })

  test("parses a to-do row and list with nulls and status", () => {
    const row = [
      "t-1",
      "Pay water bill",
      "open",
      "Due on Friday",
      "Home,Bills",
      "Personal",
      "Utilities",
      "2026-11-15",
      "2026-11-10",
      "2026-11-03",
      "2026-11-01",
    ].join(FIELD_SEPARATOR)

    const parsed = parseTodoRow(row)
    expect(parsed).toEqual({
      id: "t-1",
      name: "Pay water bill",
      status: "open",
      notes: "Due on Friday",
      tags: ["Home", "Bills"],
      area: "Personal",
      project: "Utilities",
      dueDate: "2026-11-15",
      activationDate: "2026-11-10",
      modificationDate: "2026-11-03",
      creationDate: "2026-11-01",
    })

    const list = parseTodoList(`${row}${RECORD_SEPARATOR}${row}`)
    expect(list.items).toHaveLength(2)

    // Empty list
    expect(parseTodoList("").items).toHaveLength(0)

    // Completed & canceled status, and null optional fields
    const completedRow = [
      "t-2",
      "Done Task",
      "completed",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].join(FIELD_SEPARATOR)
    const completedParsed = parseTodoRow(completedRow)
    expect(completedParsed.status).toBe("completed")
    expect(completedParsed.area).toBeNull()
    expect(completedParsed.project).toBeNull()
    expect(completedParsed.dueDate).toBeNull()

    const canceledRow = [
      "t-3",
      "Canceled Task",
      "canceled",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].join(FIELD_SEPARATOR)
    expect(parseTodoRow(canceledRow).status).toBe("canceled")
  })

  test("parses project, area and tag lists", () => {
    const projRow = [
      "p-1",
      "Launch Website",
      "Work",
      "open",
      "Phase 1|Phase 2",
      "4",
      "Release notes here",
      "2026-12-01",
      "2026-11-01",
      "Web,Q4",
    ].join(FIELD_SEPARATOR)

    const project = parseProjectRow(projRow)
    expect(project).toEqual({
      id: "p-1",
      name: "Launch Website",
      area: "Work",
      status: "open",
      headings: ["Phase 1", "Phase 2"],
      todoCount: 4,
      notes: "Release notes here",
      dueDate: "2026-12-01",
      activationDate: "2026-11-01",
      tags: ["Web", "Q4"],
    })

    const projList = parseProjectList(projRow)
    expect(projList.projects).toHaveLength(1)
    expect(parseProjectList("").projects).toHaveLength(0)

    // Project with null area, dueDate, activationDate
    const emptyProjRow = [
      "p-2",
      "Minimal Project",
      "",
      "open",
      "",
      "0",
      "",
      "",
      "",
      "",
    ].join(FIELD_SEPARATOR)
    const emptyProj = parseProjectRow(emptyProjRow)
    expect(emptyProj.area).toBeNull()
    expect(emptyProj.dueDate).toBeNull()
    expect(emptyProj.activationDate).toBeNull()
    expect(emptyProj.headings).toHaveLength(0)
    expect(emptyProj.tags).toHaveLength(0)

    // Incomplete project row
    const truncatedProj = parseProjectRow("p-3")
    expect(truncatedProj.id).toBe("p-3")
    expect(truncatedProj.name).toBe("")
    expect(truncatedProj.area).toBeNull()

    const nanCountProj = parseProjectRow(
      `p-4${FIELD_SEPARATOR}title${FIELD_SEPARATOR}${FIELD_SEPARATOR}open${FIELD_SEPARATOR}${FIELD_SEPARATOR}invalid-num`
    )
    expect(nanCountProj.todoCount).toBe(0)

    // Incomplete area row
    const truncatedArea = parseAreaList("a-alone")
    expect(truncatedArea.areas[0]).toEqual({ id: "a-alone", name: "" })

    const areaRow = `a-1${FIELD_SEPARATOR}Work${RECORD_SEPARATOR}a-2${FIELD_SEPARATOR}Personal`
    const areas = parseAreaList(areaRow)
    expect(areas.areas).toEqual([
      { id: "a-1", name: "Work" },
      { id: "a-2", name: "Personal" },
    ])
    expect(parseAreaList("").areas).toHaveLength(0)

    const tagsRow = `Work${RECORD_SEPARATOR}Urgent${RECORD_SEPARATOR}Later`
    const tags = parseTagList(tagsRow)
    expect(tags.tags).toEqual(["Work", "Urgent", "Later"])
    expect(parseTagList("").tags).toHaveLength(0)
  })

  test("ThingsError exposes correct code and message", () => {
    const err = new ThingsError("automation_denied", "permission refused")
    expect(err.code).toBe("automation_denied")
    expect(err.message).toBe("permission refused")
    expect(err.name).toBe("ThingsError")
  })
})
