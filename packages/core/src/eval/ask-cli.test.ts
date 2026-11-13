import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer, StubReply } from "../inference/stub-server"
import { formatAskTable, main, parseAskCliOptions } from "./ask-cli"
import type { AskCandidateResult } from "./ask-cli"
import { loadAskCases } from "./ask-eval"
import { freePort } from "./eval.test-support"

const casesFile = resolve(process.cwd(), "../../fixtures/eval/ask/cases.json")
const cases = loadAskCases(casesFile)
const servers: StubModelServer[] = []
const dirs: string[] = []
let output = ""

beforeEach(() => {
  output = ""
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eido-ask-eval-"))
  dirs.push(dir)
  return dir
}

describe("parseAskCliOptions", () => {
  test("defaults to the committed fixture and .eval-results", () => {
    const options = parseAskCliOptions([], {})
    expect(options.cases).toBe(casesFile)
    expect(options.out).toBe(".eval-results")
    expect(options.candidates).toBeUndefined()
  })

  test("flags win over the environment, and a leading -- is skipped", () => {
    const options = parseAskCliOptions(
      ["--", "--cases", "a.json", "--out", "o", "--candidates", "c.json"],
      { EIDO_EVAL_OUT: "env", EIDO_EVAL_CANDIDATES: "env.json" }
    )
    expect(options).toEqual({ cases: "a.json", out: "o", candidates: "c.json" })
  })

  test("reads the environment", () => {
    expect(
      parseAskCliOptions([], {
        EIDO_EVAL_ASK_CASES: "x.json",
        EIDO_EVAL_OUT: "o",
        EIDO_EVAL_CANDIDATES: "c.json",
      })
    ).toEqual({ cases: "x.json", out: "o", candidates: "c.json" })
  })

  test("rejects an unknown flag and a missing value", () => {
    expect(() => parseAskCliOptions(["--seed", "1"], {})).toThrow(
      "unknown argument --seed"
    )
    expect(() => parseAskCliOptions(["--out"], {})).toThrow(
      "--out requires a value"
    )
    expect(() => parseAskCliOptions(["--out", "--cases"], {})).toThrow(
      "--out requires a value"
    )
  })
})

describe("formatAskTable", () => {
  test("prints a row per variant, a failure line and the ids to read", () => {
    const score = { tagCitation: 1, placeholderUse: 0.5, noMatchPhrasing: 0 }
    const results: AskCandidateResult[] = [
      {
        name: "m",
        status: "ran",
        modelId: "id",
        reports: [
          {
            variant: "with-reminder",
            scores: score,
            cases: [
              {
                id: "bad",
                tagCitation: true,
                placeholderUse: false,
                noMatchPhrasing: null,
                answer: "",
              },
              {
                id: "fine",
                tagCitation: true,
                placeholderUse: true,
                noMatchPhrasing: true,
                answer: "",
              },
            ],
          },
        ],
      },
      { name: "gone", status: "failed", error: "no server" },
    ]
    const table = formatAskTable(results)
    expect(table).toContain("m | with-reminder | 100.0% | 50.0% | 0.0%")
    expect(table).toContain("gone | could not run: no server")
    expect(table).toContain("m with-reminder: cases to read: bad")
  })
})

describe("main against the stub model server", () => {
  function replies(): StubReply[] {
    // Requests run in order: every case with the reminder, then every case without.
    const good = cases.map((c): StubReply => ({
      deltas: [
        c.kind === "no_match"
          ? "No match found."
          : `Found ${c.sources.join(" ")}${c.placeholders.length > 0 ? ` ${c.placeholders.join(" and ")}` : ""}.`,
      ],
    }))
    const bad = cases.map((): StubReply => ({ deltas: ["Nothing to say."] }))
    return [...good, ...bad]
  }

  test("runs both variants, writes ask-results.json and prints the table", async () => {
    const server = await startStubModelServer({
      replies: replies(),
      modelId: "stub-model",
      contextTokens: 16384,
    })
    servers.push(server)
    const out = tempDir()
    const results = await main(["--out", out], {
      EIDO_LLAMA_PORT: new URL(server.url).port,
    })
    expect(process.exitCode).toBeUndefined()
    const [candidate] = results
    if (candidate?.status !== "ran") throw new Error("candidate did not run")
    expect(candidate.reports.map((r) => r.variant)).toEqual([
      "with-reminder",
      "without-reminder",
    ])
    expect(candidate.reports[0]?.scores).toEqual({
      tagCitation: 1,
      placeholderUse: 1,
      noMatchPhrasing: 1,
    })
    expect(candidate.reports[1]?.scores.noMatchPhrasing).toBe(0)
    expect(server.completions()).toHaveLength(24)
    for (const view of server.completions()) {
      expect(view.body["temperature"]).toBe(0)
      expect(view.body["seed"]).toBe(329)
    }
    const written: unknown = JSON.parse(
      readFileSync(join(out, "ask-results.json"), "utf8")
    )
    expect(written).toMatchObject({ seed: 329, temperature: 0 })
    expect(output).toContain("default | with-reminder | 100.0%")
    expect(output).toContain("default | without-reminder")
    expect(output).toContain("default without-reminder: cases to read:")
  }, 30_000)

  test("a candidates file runs its candidates; one that cannot run sets the exit code", async () => {
    const server = await startStubModelServer({
      replies: replies(),
      modelId: "stub-model",
      contextTokens: 16384,
    })
    servers.push(server)
    const missingPort = await freePort()
    const dir = tempDir()
    const candidatesFile = join(dir, "candidates.json")
    writeFileSync(
      candidatesFile,
      JSON.stringify({
        candidates: [
          { name: "up", baseUrl: server.url, quantization: "Q4" },
          {
            name: "kwargs",
            baseUrl: `http://127.0.0.1:${String(missingPort)}`,
            chatTemplateKwargs: { enable_thinking: false },
          },
        ],
      })
    )
    const results = await main(
      ["--candidates", candidatesFile, "--cases", casesFile, "--out", dir],
      {}
    )
    expect(results.map((r) => r.status)).toEqual(["ran", "failed"])
    expect(results[0]).toMatchObject({ quantization: "Q4" })
    expect(process.exitCode).toBe(1)
    expect(output).toContain("kwargs | could not run:")
  }, 30_000)
})
