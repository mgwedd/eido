import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { SCRIPTS_DIR } from "./runner"

describe("Things AppleScript safety invariant (AC 4)", () => {
  test("gate Things scripts never contain 'delete' or 'empty trash'", () => {
    const files = readdirSync(SCRIPTS_DIR).filter((f) =>
      f.endsWith(".applescript")
    )
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const content = readFileSync(join(SCRIPTS_DIR, file), "utf8")
      const lower = content.toLowerCase()
      expect(
        lower.includes("delete"),
        `file ${file} contains forbidden word 'delete'`
      ).toBe(false)
      expect(
        lower.includes("empty trash"),
        `file ${file} contains forbidden phrase 'empty trash'`
      ).toBe(false)
    }
  })
})
