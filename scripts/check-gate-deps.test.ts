import { describe, expect, test } from "vitest"
import { checkGateDeps, parseAllowlist } from "./check-gate-deps.ts"

const ALLOWLIST = [
  "# comment lines and blank lines are skipped",
  "",
  "zod # validates API bodies",
  "ws#sockets",
].join("\n")

describe("parseAllowlist", () => {
  test("reads names and reasons", () => {
    const problems: string[] = []
    const allowed = parseAllowlist(ALLOWLIST, problems)
    expect([...allowed]).toEqual([
      ["zod", "validates API bodies"],
      ["ws", "sockets"],
    ])
    expect(problems).toEqual([])
  })

  test("reports a line without a reason, with its line number", () => {
    const problems: string[] = []
    parseAllowlist("zod # ok\nleft-pad\nempty #   \n", problems)
    expect(problems).toEqual([
      'packages/gate/ALLOWED_DEPENDENCIES line 2 (left-pad) has no "# reason"',
      'packages/gate/ALLOWED_DEPENDENCIES line 3 (empty) has no "# reason"',
    ])
  })
})

describe("checkGateDeps", () => {
  test("passes when every dependency is allowlisted with a registry spec", () => {
    expect(
      checkGateDeps(ALLOWLIST, {
        dependencies: { zod: "4.1.0", ws: "workspace:*" },
        devDependencies: {},
      })
    ).toEqual([])
  })

  test("fails on a dependency that is not allowlisted, in any field", () => {
    const problems = checkGateDeps(ALLOWLIST, {
      dependencies: { zod: "4.1.0", leftpad: "1.0.0" },
      peerDependencies: { react: "19.0.0" },
    })
    expect(problems).toEqual([
      "packages/gate/package.json dependencies lists leftpad, which is not in packages/gate/ALLOWED_DEPENDENCIES",
      "packages/gate/package.json peerDependencies lists react, which is not in packages/gate/ALLOWED_DEPENDENCIES",
    ])
  })

  test("fails on an allowlist line without a reason", () => {
    const problems = checkGateDeps("zod", { dependencies: { zod: "4.1.0" } })
    expect(problems).toEqual([
      'packages/gate/ALLOWED_DEPENDENCIES line 1 (zod) has no "# reason"',
    ])
  })

  test.each([
    "npm:other@1.0.0",
    "git+https://example.com/x.git",
    "github:user/repo",
    "file:../x",
    "link:../x",
    "https://example.com/x.tgz",
    "user/repo",
  ])("fails on the non-registry spec %s", (spec) => {
    const problems = checkGateDeps("zod # why", { dependencies: { zod: spec } })
    expect(problems).toEqual([
      `packages/gate/package.json dependencies.zod uses non-registry spec "${spec}" (only workspace: is allowed)`,
    ])
  })

  test("fails on a non-string spec", () => {
    expect(
      checkGateDeps("zod # why", { dependencies: { zod: 4 } })
    ).toHaveLength(1)
  })
})
