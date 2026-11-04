import { existsSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { createThingsReads } from "./things-adapter"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
const hasThings =
  process.platform === "darwin" && existsSync("/Applications/Things3.app")

describe.skipIf(!hasThings)("Live Things 3 Verification (AC 10)", () => {
  test("creates a synthetic area, lists it via adapter, and cleans it up", async () => {
    const reads = createThingsReads()
    // 1. Create synthetic area via osascript
    const createScript = `tell application "Things3"
      set newArea to make new area with properties {name:"Test-Eido-Synthetic-Area"}
      return id of newArea
    end tell`
    const { stdout: areaIdRaw } = await exec("osascript", ["-e", createScript])
    const areaId = areaIdRaw.trim()
    expect(areaId).toBeTruthy()

    try {
      // 2. Query through Things reads adapter
      const { areas } = await reads.listAreas()
      const found = areas.find((a) => a.id === areaId)
      expect(found).toBeDefined()
      expect(found?.name).toBe("Test-Eido-Synthetic-Area")

      // 3. Create a todo (which lands in Inbox per AC 3)
      const { runThingsScript } = await import("./runner")
      const result = await runThingsScript("add-todo", [
        "Synthetic Verification To-Do",
        "Test notes",
        "today",
        "",
        "TestTag",
      ])
      const todoId = result.trim()
      expect(todoId).toBeTruthy()

      // 4. Move it to the synthetic area via update-todo
      await runThingsScript("update-todo", [
        todoId,
        "__EIDO_KEEP__",
        "__EIDO_KEEP__",
        "__EIDO_KEEP__",
        "__EIDO_KEEP__",
        "__EIDO_KEEP__",
        "__EIDO_KEEP__",
        "__EIDO_KEEP__",
        "Test-Eido-Synthetic-Area",
      ])

      // 5. Read todo back and verify area is set
      const item = await reads.getItem(todoId)
      expect(item).not.toBeNull()
      expect(item?.name).toBe("Synthetic Verification To-Do")
      expect(item?.area).toBe("Test-Eido-Synthetic-Area")

      // Clean up todo
      await exec("osascript", [
        "-e",
        `tell application "Things3" to delete to do id "${todoId}"`,
      ])
    } finally {
      // Clean up synthetic area by name and id
      await exec("osascript", [
        "-e",
        `tell application "Things3"
            try
              delete area "Test-Eido-Synthetic-Area"
            end try
          end tell`,
      ])
    }
  }, 30000)
})
