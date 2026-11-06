import { describe, expect, test } from "vitest"
import { changedFiles, judgeChangedFiles } from "./check-eval-report.ts"

describe("judgeChangedFiles", () => {
  test("a pull request without the report passes", () => {
    expect(judgeChangedFiles(["packages/core/src/a.ts"])).toBeNull()
  })

  test("the report on its own passes", () => {
    expect(judgeChangedFiles(["docs/injection-eval.md"])).toBeNull()
  })

  test("the report next to other changes fails and names them", () => {
    const error = judgeChangedFiles([
      "docs/injection-eval.md",
      "packages/core/src/digest/build.ts",
    ])
    expect(error).toMatch(
      /git checkout origin\/main -- docs\/injection-eval\.md/
    )
    expect(error).toMatch(/packages\/core\/src\/digest\/build\.ts$/)
  })
})

describe("changedFiles", () => {
  test("in CI on a pull request, diffs the merge commit against its base", () => {
    const calls: string[][] = []
    const files = changedFiles(
      { CI: "true", GITHUB_EVENT_NAME: "pull_request" },
      (args) => {
        calls.push(args)
        return "a.ts\ndocs/injection-eval.md\n"
      }
    )
    expect(calls).toEqual([["diff", "--name-only", "HEAD^1", "HEAD"]])
    expect(files).toEqual(["a.ts", "docs/injection-eval.md"])
  })

  test("in CI on a push to main, checks nothing", () => {
    expect(
      changedFiles({ CI: "true", GITHUB_EVENT_NAME: "push" }, () => "x")
    ).toBeNull()
  })

  test("locally, diffs against the merge base with origin/main", () => {
    const calls: string[][] = []
    const files = changedFiles({}, (args) => {
      calls.push(args)
      return args[0] === "merge-base" ? "base123" : "b.ts"
    })
    expect(calls[1]).toEqual(["diff", "--name-only", "base123"])
    expect(files).toEqual(["b.ts"])
  })

  test("locally without origin/main, checks nothing", () => {
    expect(changedFiles({}, () => null)).toBeNull()
  })
})
