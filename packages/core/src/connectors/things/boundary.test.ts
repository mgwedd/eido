import { describe, expect, test } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

describe("Things connector boundary checks (AC 6)", () => {
  function getSourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const st = statSync(fullPath)
      if (st.isDirectory()) {
        files.push(...getSourceFiles(fullPath))
      } else if (
        (entry.endsWith(".ts") || entry.endsWith(".json")) &&
        !entry.endsWith(".test.ts")
      ) {
        files.push(fullPath)
      }
    }
    return files
  }

  test("AC 6: core has no osascript or child_process in packages/core/src/connectors/things", () => {
    const connectorDir = __dirname
    const sourceFiles = getSourceFiles(connectorDir)
    expect(sourceFiles.length).toBeGreaterThan(0)

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8")
      expect(content).not.toMatch(/\bchild_process\b/)
      expect(content).not.toMatch(/\bosascript\b/)
    }
  })
})
