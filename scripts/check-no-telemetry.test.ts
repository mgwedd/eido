import { describe, expect, test } from "vitest"
import { scan } from "./check-no-telemetry.ts"

const reader = (files: Record<string, string>) => (file: string) => {
  const content = files[file]
  if (content === undefined) {
    throw Object.assign(new Error("missing"), { code: "ENOENT" })
  }
  return content
}

describe("scan", () => {
  test("flags a denied SDK in a manifest", () => {
    const files = {
      "apps/web/package.json": '{"dependencies":{"posthog-js":"1"}}',
    }
    expect(scan(Object.keys(files), reader(files))).toEqual([
      { file: "apps/web/package.json", finding: "analytics SDK" },
    ])
  })

  test("flags a denied SDK installed in the lockfile", () => {
    const files = {
      "pnpm-lock.yaml":
        "packages:\n  '@sentry/nextjs@8.0.0':\n    resolution: {}\n",
    }
    expect(scan(Object.keys(files), reader(files))).toEqual([
      { file: "pnpm-lock.yaml", finding: "crash-reporting SDK" },
    ])
  })

  test("flags an initializer in app source", () => {
    const files = { "apps/web/src/init.ts": 'Sentry.init({ dsn: "x" })' }
    expect(scan(Object.keys(files), reader(files))).toEqual([
      {
        file: "apps/web/src/init.ts",
        finding: "crash-reporting SDK initialization",
      },
    ])
  })

  test("passes clean manifests and source, and skips other files", () => {
    const files = {
      "apps/web/package.json": '{"dependencies":{"next":"16.0.0"}}',
      "apps/web/src/a.ts": "const segments = path.split('/')",
      "packages/core/src/a.ts": "Sentry.init()",
      "broken/package.json": "{not json",
    }
    expect(scan(Object.keys(files), reader(files))).toEqual([])
  })

  test("skips a file deleted from the worktree", () => {
    expect(scan(["apps/web/package.json"], reader({}))).toEqual([])
  })

  test("rethrows other read errors", () => {
    expect(() =>
      scan(["apps/web/package.json"], () => {
        throw new Error("boom")
      })
    ).toThrow("boom")
  })
})
