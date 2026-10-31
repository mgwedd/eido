import { describe, expect, test } from "vitest"
import { REQUIRED_TESTS, findMissingTests } from "./check-invariant-tests.ts"

describe("findMissingTests", () => {
  test("passes when every required name is quoted in its file", () => {
    const read = (path: string) =>
      REQUIRED_TESTS.filter(([p]) => p === path)
        .map(([, name]) => `test("${name}", () => {})`)
        .join("\n")
    expect(findMissingTests(REQUIRED_TESTS, read)).toEqual([])
  })

  test("reports a renamed or removed test", () => {
    const required: [string, string][] = [
      ["a.test.ts", "invariant: one"],
      ["a.test.ts", "invariant: two"],
    ]
    expect(
      findMissingTests(required, () => 'test("invariant: one", () => {})')
    ).toEqual(["a.test.ts: invariant: two"])
  })

  test("does not accept the name without its quotes", () => {
    expect(
      findMissingTests(
        [["a.test.ts", "invariant: one"]],
        () => "invariant: one"
      )
    ).toHaveLength(1)
  })

  test("lists the named gate invariants", () => {
    expect(REQUIRED_TESTS.length).toBeGreaterThan(0)
    for (const [path, name] of REQUIRED_TESTS) {
      expect(path).toMatch(/^packages\/gate\/.*\.test\.ts$/)
      expect(name).toMatch(/^invariant: /)
    }
  })
})
