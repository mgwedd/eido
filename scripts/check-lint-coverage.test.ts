import { describe, expect, test } from "vitest"
import { PACKAGES, judgeEslintOutput } from "./check-lint-coverage.ts"

const results = (...files: string[]) =>
  JSON.stringify(files.map((filePath) => ({ filePath })))

describe("check-lint-coverage", () => {
  test("covers the scripts package", () => {
    expect(PACKAGES).toContain("scripts")
  })

  test("passes when eslint linted TypeScript files", () => {
    const verdict = judgeEslintOutput(
      "scripts",
      results("/r/scripts/a.ts", "/r/scripts/b.tsx", "/r/scripts/c.js"),
      ""
    )
    expect(verdict).toEqual({
      ok: true,
      message: "ok: scripts: 2 TypeScript files linted.",
    })
  })

  test("fails when a package lints no .ts file", () => {
    const verdict = judgeEslintOutput(
      "packages/x",
      results("/r/packages/x/eslint.config.js"),
      ""
    )
    expect(verdict).toEqual({
      ok: false,
      message: "FAIL: packages/x: eslint linted 0 TypeScript files.",
    })
  })

  test("fails when eslint prints no results at all", () => {
    expect(judgeEslintOutput("p", "[]", "").ok).toBe(false)
  })

  test("fails with stderr when eslint prints no JSON", () => {
    const verdict = judgeEslintOutput("p", "not json", "config error")
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain("did not produce JSON")
    expect(verdict.message).toContain("config error")
  })
})
