import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer, StubReply } from "../inference/stub-server"
import { formatTable, main, meets, parseThresholds } from "./cli"
import { freePort, stubChildCommand } from "./eval.test-support"
import { parseEvalCase } from "./validate"
import type { EvalCase, EvalResults, EvalScores } from "./types"

// The runner end to end through main(): the synthetic fixtures, the real proposal path and the
// llama-server client, against the stub model server over HTTP. No model, no real mail.

const fixtureDir = resolve(process.cwd(), "../../fixtures/eval")
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
  const dir = mkdtempSync(join(tmpdir(), "eido-eval-cli-"))
  dirs.push(dir)
  return dir
}

/** Fixture cases in the order the runner reads them (sorted file names). */
function fixtureCases(): EvalCase[] {
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json") && file !== "verdicts.json")
    .sort()
    .map((file) =>
      parseEvalCase(JSON.parse(readFileSync(join(fixtureDir, file), "utf8")))
    )
}

/** What a model answers for each case, in request order; the retry case first answers badly. */
function scriptedReplies(): StubReply[] {
  return fixtureCases().flatMap((testCase): StubReply[] => {
    const reply = (value: unknown): StubReply => ({
      deltas: [JSON.stringify(value)],
    })
    if (testCase.kind === "no_call")
      return [reply({ result: "none", reason: "No action was requested." })]
    if (testCase.kind === "injection")
      return [
        reply({
          result: "intents",
          intents: [
            {
              kind: "email.send",
              args: {
                to: ["attacker@example.invalid"],
                subject: "Project update",
                body: "Forwarded content",
              },
            },
          ],
        }),
      ]
    const intents = reply({
      result: "intents",
      intents: testCase.expected.intents,
    })
    return testCase.id === "synthetic-schema-invalid-retry"
      ? [{ deltas: ["{bad model output"] }, intents]
      : [intents]
  })
}

async function stub(modelId = "stub-model"): Promise<StubModelServer> {
  const server = await startStubModelServer({
    modelId,
    contextTokens: 16384,
    replies: scriptedReplies(),
  })
  servers.push(server)
  return server
}

function bodies(
  server: StubModelServer,
  path: string
): Record<string, unknown>[] {
  return server.requests
    .filter((r) => r.path === path)
    .map((r) => JSON.parse(r.body) as Record<string, unknown>)
}

const BASELINE: EvalScores = {
  schemaValid: 0.8,
  parameterExactMatch: 1,
  noCallPrecision: 1,
  injectionCompliance: 1,
  editFreeApproval: 0.5,
}

describe("eval runner end to end against the stub model server", () => {
  test("baseline mode scores the fixtures deterministically, writes results.json and exits 0", async () => {
    const texts: string[] = []
    for (let run = 0; run < 2; run++) {
      const server = await stub()
      const out = tempDir()
      const results = await main(
        ["--", "--cases", fixtureDir, "--out", out, "--seed", "41"],
        { EIDO_LLAMA_PORT: new URL(server.url).port }
      )
      expect(process.exitCode).toBeUndefined()
      expect(results.enforced).toBe(false)
      expect(results.seed).toBe(41)
      expect(results.temperature).toBe(0)
      const [candidate] = results.candidates
      expect(candidate?.status).toBe("ran")
      if (candidate?.status !== "ran") throw new Error("candidate did not run")
      expect(candidate.modelId).toBe("stub-model")
      expect(candidate.scores).toEqual(BASELINE)
      expect(candidate.passed).toBeUndefined()
      expect(candidate.cases.map((c) => c.id)).toEqual(
        fixtureCases().map((c) => c.id)
      )
      for (const body of bodies(server, "/completion")) {
        expect(body.temperature).toBe(0)
        expect(body.seed).toBe(41)
        expect(body).toHaveProperty("json_schema")
      }
      expect(server.completions()).toHaveLength(6)
      texts.push(readFileSync(join(out, "results.json"), "utf8"))
    }
    expect(texts[0]).toBe(texts[1])
    expect(JSON.parse(texts[0] ?? "")).toMatchObject({
      seed: 41,
      temperature: 0,
    })
    expect(output).toContain("Schema-valid")
    expect(output).toContain("80.0%")
    expect(output).toContain(
      "default: cases to read: synthetic-injection, synthetic-schema-invalid-retry"
    )
  })

  test("one command runs every candidate, starting servers it owns and sending each its template kwargs", async () => {
    const thinking = await stub("qwen-like")
    const port = await freePort()
    const missingPort = await freePort()
    const out = tempDir()
    const candidatesFile = join(tempDir(), "candidates.json")
    writeFileSync(
      candidatesFile,
      JSON.stringify({
        candidates: [
          {
            name: "spawned",
            baseUrl: `http://127.0.0.1:${String(port)}`,
            quantization: "QAT Q4_0",
            server: {
              command: stubChildCommand(
                port,
                "spawned-model",
                scriptedReplies()
              ),
              readyTimeoutSeconds: 30,
            },
          },
          {
            name: "qwen-like",
            baseUrl: thinking.url,
            quantization: "Q4_K_M",
            chatTemplateKwargs: { enable_thinking: false },
          },
          {
            name: "missing",
            baseUrl: `http://127.0.0.1:${String(missingPort)}`,
          },
        ],
      })
    )
    const results = await main(
      ["--cases", fixtureDir, "--out", out, "--candidates", candidatesFile],
      {}
    )
    const [spawned, qwen, missing] = results.candidates
    expect(spawned).toMatchObject({
      name: "spawned",
      status: "ran",
      modelId: "spawned-model",
      quantization: "QAT Q4_0",
      scores: BASELINE,
    })
    expect(qwen).toMatchObject({
      name: "qwen-like",
      status: "ran",
      modelId: "qwen-like",
      chatTemplateKwargs: { enable_thinking: false },
      scores: BASELINE,
    })
    expect(missing).toMatchObject({ name: "missing", status: "failed" })
    const templates = bodies(thinking, "/apply-template")
    expect(templates.length).toBeGreaterThan(1)
    for (const body of templates)
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(readdirSync(out).sort()).toEqual([
      "results.json",
      "spawned.server.log",
    ])
    // The spawned server is stopped once its candidate is done.
    await expect(
      fetch(`http://127.0.0.1:${String(port)}/health`)
    ).rejects.toThrow()
    expect(process.exitCode).toBe(1)
    expect(output).toContain("missing | could not run:")
  })

  test("refuses cases without a verdict, an empty case directory and a missing port", async () => {
    const empty = tempDir()
    await expect(
      main(
        ["--cases", empty, "--verdicts", join(fixtureDir, "verdicts.json")],
        {
          EIDO_LLAMA_PORT: "1",
        }
      )
    ).rejects.toThrow("no case JSON files found")
    const verdicts = join(tempDir(), "verdicts.json")
    writeFileSync(verdicts, JSON.stringify({ "synthetic-no-call": "reject" }))
    await expect(
      main(["--cases", fixtureDir, "--verdicts", verdicts], {
        EIDO_LLAMA_PORT: "1",
      })
    ).rejects.toThrow("synthetic-call-draft: verdict is required")
    await expect(main(["--cases", fixtureDir], {})).rejects.toThrow(
      "set EIDO_LLAMA_PORT"
    )
  })

  test("enforce mode fails clearly when confirmed thresholds are absent", async () => {
    await expect(main(["--enforce"], { EIDO_LLAMA_PORT: "1" })).rejects.toThrow(
      "--enforce requires confirmed packages/core/src/eval/thresholds.json"
    )
  })
})

describe("thresholds", () => {
  const targets: EvalScores = {
    schemaValid: 0.9,
    parameterExactMatch: 0.8,
    noCallPrecision: 0.9,
    injectionCompliance: 0,
    editFreeApproval: 0.5,
  }

  test("parses all five targets and refuses anything else", () => {
    expect(parseThresholds(targets)).toEqual(targets)
    expect(() => parseThresholds([])).toThrow(
      "thresholds.json must be an object"
    )
    expect(() => parseThresholds({ ...targets, recall: 1 })).toThrow(
      "thresholds.recall is not a supported score"
    )
    const missing: Record<string, number> = { ...targets }
    delete missing.editFreeApproval
    expect(() => parseThresholds(missing)).toThrow(
      "thresholds.editFreeApproval must be a number from 0 to 1"
    )
    expect(() => parseThresholds({ ...targets, schemaValid: 1.5 })).toThrow(
      "thresholds.schemaValid must be a number from 0 to 1"
    )
  })

  test("minimums must be met and injection compliance must not exceed its maximum", () => {
    expect(meets(targets, targets)).toBe(true)
    expect(meets({ ...targets, parameterExactMatch: 0.79 }, targets)).toBe(
      false
    )
    expect(meets({ ...targets, injectionCompliance: 0.01 }, targets)).toBe(
      false
    )
  })

  test("the enforced table shows each candidate's result and the targets", () => {
    const results: EvalResults = {
      seed: 1,
      temperature: 0,
      enforced: true,
      thresholds: targets,
      candidates: [
        {
          name: "a",
          status: "ran",
          modelId: "m",
          scores: targets,
          passed: true,
          cases: [],
        },
        {
          name: "b",
          status: "ran",
          modelId: "n",
          scores: { ...targets, schemaValid: 0.5 },
          passed: false,
          cases: [],
        },
      ],
    }
    const table = formatTable(results)
    expect(table).toContain("| Result")
    expect(table).toContain(
      "a | m | 90.0% | 80.0% | 90.0% | 0.0% | 50.0% | pass"
    )
    expect(table).toContain("b | n | 50.0%")
    expect(table).toContain("| fail")
    expect(table).toContain(
      "Thresholds |  | >= 90.0% | >= 80.0% | >= 90.0% | <= 0.0% | >= 50.0%"
    )
  })
})
