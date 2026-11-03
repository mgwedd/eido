import { describe, expect, test } from "vitest"
import { ALLOWED, findStrayJs } from "./check-no-js.ts"

describe("findStrayJs", () => {
  test("flags JavaScript outside the allowlist", () => {
    expect(
      findStrayJs([
        "packages/core/src/ok.ts",
        "packages/core/src/stray.js",
        "apps/web/lib/helper.mjs",
        "apps/web/components/widget.jsx",
        "x/y.cjs",
      ])
    ).toEqual([
      "packages/core/src/stray.js",
      "apps/web/lib/helper.mjs",
      "apps/web/components/widget.jsx",
      "x/y.cjs",
    ])
  })

  test("no longer allows JavaScript under scripts/ or package scripts/", () => {
    expect(
      findStrayJs(["scripts/new-check.mjs", "packages/schemas/scripts/c.mjs"])
    ).toHaveLength(2)
  })

  test.each([
    "apps/web/eslint.config.js",
    "apps/web/postcss.config.mjs",
    "packages/eslint-config/base.js",
    "apps/web/public/sw.js",
    ".agents/skills/x/run.mjs",
  ])("allows the documented exception %s", (file) => {
    expect(findStrayJs([file])).toEqual([])
  })

  test("no longer allows a CommonJS dependency-cruiser config", () => {
    expect(findStrayJs([".dependency-cruiser.cjs"])).toHaveLength(1)
  })

  test("does not allow nested ESLint preset files", () => {
    expect(
      findStrayJs(["packages/eslint-config/nested/other.js"])
    ).toHaveLength(1)
  })

  test("every exception states a reason", () => {
    for (const { reason } of ALLOWED) expect(reason.length).toBeGreaterThan(10)
  })
})
