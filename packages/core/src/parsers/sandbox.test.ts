import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CHILD_ENV, childArgs, runInChild } from "./sandbox"

const HOSTILE = join(dirname(fileURLToPath(import.meta.url)), "hostile")
let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "eido-sandbox-"))
})
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const run = (entry: string, resultBytes = 1024 * 1024) =>
  runInChild({
    entry: join(HOSTILE, entry),
    payload: {},
    tmpRoot: tmp,
    limits: { timeoutMs: 20_000, heapMiB: 128, resultBytes },
  })

describe("childArgs", () => {
  it("caps the heap, disables eval and preloads the no-network module before the entry", () => {
    const args = childArgs("/entry.ts", "/job.json", 64)
    expect(args.slice(0, 2)).toEqual([
      "--max-old-space-size=64",
      "--disallow-code-generation-from-strings",
    ])
    expect(args.at(-3)?.endsWith("no-network.ts")).toBe(true)
    expect(args.slice(-2)).toEqual(["/entry.ts", "/job.json"])
  })

  it("gives the child an empty, frozen environment", () => {
    expect(CHILD_ENV).toEqual({})
    expect(Object.isFrozen(CHILD_ENV)).toBe(true)
  })
})

describe("runInChild", { timeout: 60_000 }, () => {
  it("is crashed when the child exits non-zero", async () => {
    expect(await run("fail.test-support.ts")).toEqual({
      ok: false,
      reason: "crashed",
      detail: "the parser exited with 3",
    })
  })

  it("is crashed when the child exits without a result", async () => {
    expect(await run("silent.test-support.ts")).toEqual({
      ok: false,
      reason: "crashed",
      detail: "the parser exited without a result",
    })
  })

  it("is crashed when the result is not JSON", async () => {
    expect(await run("garbage.test-support.ts")).toEqual({
      ok: false,
      reason: "crashed",
      detail: "the parser's result is not JSON",
    })
  })

  it("is oversize when the result is larger than the parent will read", async () => {
    expect(await run("env.test-support.ts", 4)).toEqual({
      ok: false,
      reason: "oversize",
      detail: "the parser's result is too large",
    })
  })

  it("removes every work dir it made", () => {
    expect(readdirSync(tmp)).toEqual([])
  })
})
