import { describe, expect, test } from "vitest"
import { createThingsReads } from "./things-adapter"
import type { ThingsScriptRunner } from "./runner"
import { FIELD_SEPARATOR, RECORD_SEPARATOR } from "./runner"

describe("ThingsReads adapter", () => {
  const sampleTodoRow = [
    "todo-1",
    "Sample Todo",
    "open",
    "Some notes",
    "Tag1,Tag2",
    "Area1",
    "Project1",
    "2026-12-01",
    "2026-11-05",
    "2026-11-03",
    "2026-11-01",
  ].join(FIELD_SEPARATOR)

  const sampleProjectRow = [
    "proj-1",
    "Sample Project",
    "Area1",
    "open",
    "H1|H2",
    "3",
    "Proj notes",
    "2026-12-31",
    "2026-11-01",
    "TagA",
  ].join(FIELD_SEPARATOR)

  test("listTodos calls list-todos script and parses output", async () => {
    const runner: ThingsScriptRunner = (script, argv) => {
      expect(script).toBe("list-todos")
      expect(argv).toEqual(["Today"])
      return Promise.resolve(sampleTodoRow)
    }
    const adapter = createThingsReads(runner)
    const list = await adapter.listTodos("Today")
    expect(list.items).toHaveLength(1)
    expect(list.items[0]?.name).toBe("Sample Todo")
  })

  test("listByDeadline calls list-deadline script", async () => {
    const runner: ThingsScriptRunner = (script, argv) => {
      expect(script).toBe("list-deadline")
      expect(argv).toEqual(["14"])
      return Promise.resolve(sampleTodoRow)
    }
    const adapter = createThingsReads(runner)
    const list = await adapter.listByDeadline(14)
    expect(list.items).toHaveLength(1)
  })

  test("getItem returns to-do when found as to-do", async () => {
    const runner: ThingsScriptRunner = (script, argv) => {
      if (script === "get-todo") {
        expect(argv).toEqual(["todo-1"])
        return Promise.resolve(sampleTodoRow)
      }
      return Promise.resolve("")
    }
    const adapter = createThingsReads(runner)
    const item = await adapter.getItem("todo-1")
    expect(item).not.toBeNull()
    expect(item?.id).toBe("todo-1")
  })

  test("getItem returns project when not found as to-do but found as project", async () => {
    const runner: ThingsScriptRunner = (script, argv) => {
      if (script === "get-todo") return Promise.resolve("")
      if (script === "get-project") {
        expect(argv).toEqual(["proj-1"])
        return Promise.resolve(sampleProjectRow)
      }
      return Promise.resolve("")
    }
    const adapter = createThingsReads(runner)
    const item = await adapter.getItem("proj-1")
    expect(item).not.toBeNull()
    expect(item?.id).toBe("proj-1")
    expect(item?.name).toBe("Sample Project")
  })

  test("getItem returns null when not found as to-do or project", async () => {
    const runner: ThingsScriptRunner = () => Promise.resolve("")
    const adapter = createThingsReads(runner)
    const item = await adapter.getItem("unknown-id")
    expect(item).toBeNull()
  })

  test("getItem returns null when returned item ID does not match queried ID", async () => {
    const runner: ThingsScriptRunner = (script) => {
      if (script === "get-todo") return Promise.resolve(sampleTodoRow) // id is todo-1
      if (script === "get-project") return Promise.resolve(sampleProjectRow) // id is proj-1
      return Promise.resolve("")
    }
    const adapter = createThingsReads(runner)
    const item = await adapter.getItem("mismatched-id")
    expect(item).toBeNull()
  })

  test("listProjects, listAreas, listTags call corresponding scripts", async () => {
    const runner: ThingsScriptRunner = (script, argv) => {
      if (script === "list-projects") {
        expect(argv).toEqual(["Area1"])
        return Promise.resolve(sampleProjectRow)
      }
      if (script === "list-areas") {
        return Promise.resolve(`a-1${FIELD_SEPARATOR}Area1`)
      }
      if (script === "list-tags") {
        return Promise.resolve(`Tag1${RECORD_SEPARATOR}Tag2`)
      }
      return Promise.resolve("")
    }
    const adapter = createThingsReads(runner)
    const projs = await adapter.listProjects("Area1")
    expect(projs.projects).toHaveLength(1)

    const areas = await adapter.listAreas()
    expect(areas.areas).toEqual([{ id: "a-1", name: "Area1" }])

    const tags = await adapter.listTags()
    expect(tags.tags).toEqual(["Tag1", "Tag2"])
  })
})
