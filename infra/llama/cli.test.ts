import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { main, type Deps, type ServerProcess } from "./cli.ts"
import type { HttpResponse } from "./server.ts"
import type { RunResult } from "./verify.ts"

const LOCK = readFileSync(new URL("../model.lock", import.meta.url), "utf8")
const SHA = "b4778681efbd6898fe1965e74f810b3b7dfdf6afab01df9c88c1b0e6e9ca122d"
const SIZE = 6036116480
const ASSET_SHA =
  "791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e"
const HOME = "/Users/u"
const ROOT = `${HOME}/Library/Application Support/eido-dev`
const MODEL = `${ROOT}/models/meta-llama-3.1-8b-instruct-q4_0.gguf`
const BIN = `${ROOT}/llama.cpp/b11149/llama-server`
const PLIST = `${HOME}/Library/LaunchAgents/com.eido.llama-server.plist`
const VERSION = "version: 0.5.0-dev (build 11149, commit d2e54583c)\n"
const REFERENCE =
  "<|start_header_id|>user<|end_header_id|>\n\nThanks.<|eot_id|>"

const reply = (status: number, body: unknown): HttpResponse => ({
  status,
  json: () => Promise.resolve(body),
})

const fail = (): never => {
  throw new Error("llama-server was not spawned")
}

type Child = ServerProcess & { killed: string[]; exit: (code: number) => void }

function child(): Child {
  let exit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const c: Child = {
    exited,
    killed: [],
    kill: (signal) => {
      c.killed.push(signal)
      exit(143)
    },
    exit: (code) => exit(code),
  }
  return c
}

type Options = {
  sha?: string
  version?: RunResult
  files?: Record<string, string>
  http?: Record<string, HttpResponse | Error>
  runs?: Record<string, RunResult>
  env?: Record<string, string>
}

function harness(o: Options = {}) {
  const out: string[] = []
  const err: string[] = []
  const ran: string[] = []
  const spawned: {
    command: string
    args: readonly string[]
    process: Child
  }[] = []
  const written: Record<string, string> = {}
  const removed: string[] = []
  const made: string[] = []
  let stop: () => void = () => {}
  const files: Record<string, string> = {
    "/repo/infra/model.lock": LOCK,
    [MODEL]: "",
    [BIN]: "",
    "/repo/infra/llama/fixtures/meta-llama-3.1-8b-instruct-q4_0.gguf.prompt.txt":
      REFERENCE,
    ...o.files,
  }
  const http: Record<string, HttpResponse | Error> = {
    "/health": reply(200, { status: "ok" }),
    "/props": reply(200, {
      chat_template: "'<|start_header_id|>' + message['role']",
    }),
    "/apply-template": reply(200, { prompt: REFERENCE }),
    "/v1/chat/completions": reply(200, {
      choices: [
        {
          message: {
            content: '{"city":"a","country":"b","summary":"c","unit":"d"}',
          },
        },
      ],
    }),
    ...o.http,
  }
  let t = 0
  const deps: Deps = {
    readText: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    probe: {
      size: (path) =>
        Promise.resolve(
          path in files ? (path === MODEL ? SIZE : 10) : undefined
        ),
      sha256: (path) =>
        Promise.resolve(path === MODEL ? (o.sha ?? SHA) : ASSET_SHA),
      now: () => (t += 1000),
    },
    run: (command, args) => {
      const line = [command, ...args].join(" ")
      ran.push(line)
      if (line === `${BIN} --version`)
        return Promise.resolve(
          o.version ?? { code: 0, stdout: "", stderr: VERSION }
        )
      return Promise.resolve(
        o.runs?.[line] ?? { code: 1, stdout: "", stderr: "" }
      )
    },
    spawn: (command, args) => {
      const process = child()
      spawned.push({ command, args, process })
      return process
    },
    fetch: (url) => {
      const answer = http[new URL(url).pathname]
      if (answer === undefined || answer instanceof Error)
        return Promise.reject(answer ?? new Error("ECONNREFUSED"))
      return Promise.resolve(answer)
    },
    sleep: () => Promise.resolve(),
    onStopSignal: (handler) => (stop = handler),
    fs: {
      exists: (path) => path in files || path in written,
      mkdir: (path) => made.push(path),
      writeFile: (path, text) => (written[path] = text),
      remove: (path) => removed.push(path),
    },
    env: o.env ?? {},
    home: HOME,
    uid: 501,
    node: "/opt/node",
    launcher: "/repo/infra/llama/bin.ts",
    defaultLockPath: "/repo/infra/model.lock",
    fixtureDir: "/repo/infra/llama/fixtures",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  }
  return {
    deps,
    out,
    err,
    ran,
    spawned,
    written,
    removed,
    made,
    stop: () => stop(),
  }
}

describe("llama verify", () => {
  it("passes the pinned binary and model, and logs the digest", async () => {
    const h = harness()
    expect(await main(["verify"], h.deps)).toBe(0)
    expect(h.out).toContain(`ok: ${MODEL} sha256 ${SHA} (hashed in 1.0 s)`)
    expect(h.out).toContain(`ok: ${BIN} is b11149 (d2e54583c)`)
  })

  it("fails on another llama.cpp build before hashing the model", async () => {
    const h = harness({
      version: {
        code: 0,
        stdout: "",
        stderr: "version: 1 (build 9000, commit 1234567)",
      },
    })
    expect(await main(["verify"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      "FAIL: llama-server build mismatch: expected b11149 (d2e54583c), actual b9000 (1234567)",
    ])
  })

  it("fails and prints usage-free errors on a broken lock", async () => {
    const h = harness({ files: { "/repo/infra/model.lock": "model: x\n" } })
    expect(await main(["verify"], h.deps)).toBe(1)
    expect(h.err[0]).toMatch(/^FAIL: model\.lock is missing /)
  })

  it("reads the lock from EIDO_MODEL_LOCK", async () => {
    const h = harness({ env: { EIDO_MODEL_LOCK: "/elsewhere/model.lock" } })
    expect(await main(["verify"], h.deps)).toBe(1)
    expect(h.err).toEqual(["FAIL: ENOENT: /elsewhere/model.lock"])
  })
})

describe("llama launch", () => {
  it("refuses to start llama-server when the model's digest does not match", async () => {
    const altered =
      "6287caa0d1c45eb9e6ccb9a0ebe555d6485b226a78c68ca79e972d271a71284c"
    const h = harness({ sha: altered })
    expect(await main(["launch"], h.deps)).toBe(1)
    expect(h.spawned).toEqual([])
    expect(h.err).toEqual([
      `FAIL: ${MODEL}: sha256 mismatch: expected ${SHA}, actual ${altered}`,
      "llama-server was not started",
    ])
  })

  it("refuses to start when the model file is missing", async () => {
    const h = harness({ env: { EIDO_MODEL_DIR: "/empty" } })
    expect(await main(["launch"], h.deps)).toBe(1)
    expect(h.spawned).toEqual([])
    expect(h.err).toEqual([
      "FAIL: no model file at /empty/meta-llama-3.1-8b-instruct-q4_0.gguf",
      "llama-server was not started",
    ])
  })

  it("starts the verified model on loopback with --jinja, then reports ready", async () => {
    const h = harness()
    const running = main(["launch"], h.deps)
    await new Promise((r) => setTimeout(r, 0))
    expect(h.spawned.map((s) => s.command)).toEqual([BIN])
    const { args, process } = h.spawned[0] ?? fail()
    expect(args.slice(0, 7)).toEqual([
      "-m",
      MODEL,
      "--jinja",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
    ])
    expect(h.out.at(-1)).toMatch(
      /^ok: llama-server ready on http:\/\/127\.0\.0\.1:8080 in [\d.]+ s; chat template has <\|start_header_id\|>$/
    )
    process.exit(0)
    expect(await running).toBe(1)
    expect(h.err).toEqual(["llama-server exited with code 0"])
  })

  it("passes on a crash exit code so launchd sees the failure", async () => {
    const h = harness()
    const running = main(["launch"], h.deps)
    await new Promise((r) => setTimeout(r, 0))
    h.spawned[0]?.process.exit(139)
    expect(await running).toBe(139)
  })

  it("stops llama-server and exits 0 on SIGTERM", async () => {
    const h = harness()
    const running = main(["launch"], h.deps)
    await new Promise((r) => setTimeout(r, 0))
    h.stop()
    expect(await running).toBe(0)
    expect(h.spawned[0]?.process.killed).toEqual(["SIGTERM"])
  })

  it("exits 0 when stopped while still waiting for /health", async () => {
    const h = harness({ http: { "/health": reply(503, {}) } })
    const deps = { ...h.deps, sleep: () => (h.stop(), Promise.resolve()) }
    expect(await main(["launch"], deps)).toBe(0)
    expect(h.spawned[0]?.process.killed).toEqual(["SIGTERM"])
  })

  it("stops llama-server when the loaded template is not the pinned model's", async () => {
    const h = harness({
      http: { "/props": reply(200, { chat_template: "<start_of_turn>" }) },
    })
    expect(await main(["launch"], h.deps)).toBe(1)
    expect(h.spawned[0]?.process.killed).toEqual(["SIGTERM"])
    expect(h.err).toEqual([
      'FAIL: /props chat_template does not contain "<|start_header_id|>"',
    ])
  })

  it("fails when llama-server exits before it is healthy", async () => {
    const h = harness({ http: { "/health": new Error("ECONNREFUSED") } })
    const deps = {
      ...h.deps,
      sleep: () => {
        h.spawned[0]?.process.exit(1)
        return new Promise<void>((r) => setTimeout(r, 0))
      },
    }
    expect(await main(["launch"], deps)).toBe(1)
    expect(h.err).toEqual([
      "FAIL: llama-server exited with code 1 before /health answered",
    ])
  })
})

describe("llama verify-archive", () => {
  const path = "/dl/llama-b11149-bin-macos-arm64.tar.gz"

  it("passes the pinned release asset", async () => {
    const h = harness({ files: { [path]: "" } })
    expect(await main(["verify-archive", path], h.deps)).toBe(0)
    expect(h.out).toContain(`ok: ${path} sha256 ${ASSET_SHA}`)
  })

  it("fails on another asset name, a missing file or another digest", async () => {
    const other = harness({
      files: { "/dl/llama-b11150-bin-macos-arm64.tar.gz": "" },
    })
    expect(
      await main(
        ["verify-archive", "/dl/llama-b11150-bin-macos-arm64.tar.gz"],
        other.deps
      )
    ).toBe(1)
    expect(other.err).toEqual([
      "FAIL: /dl/llama-b11150-bin-macos-arm64.tar.gz is not llama-b11149-bin-macos-arm64.tar.gz",
    ])

    const missing = harness()
    expect(await main(["verify-archive", path], missing.deps)).toBe(1)
    expect(missing.err).toEqual([`FAIL: no file at ${path}`])

    const tampered = harness({ files: { [path]: "" } })
    tampered.deps.probe.sha256 = () => Promise.resolve("0".repeat(64))
    expect(await main(["verify-archive", path], tampered.deps)).toBe(1)
    expect(tampered.err).toEqual([
      `FAIL: ${path}: sha256 mismatch: expected ${ASSET_SHA}, actual ${"0".repeat(64)}`,
    ])
  })

  it("needs a path", async () => {
    const h = harness()
    expect(await main(["verify-archive"], h.deps)).toBe(2)
  })
})

describe("llama check-template", () => {
  it("passes when the template, the rendered prompt and the JSON schema all check out", async () => {
    const h = harness()
    expect(await main(["check-template"], h.deps)).toBe(0)
    expect(h.out).toEqual([
      "ok: chat template",
      "ok: rendered prompt",
      "ok: JSON-schema request",
      "ok: template check passed on b11149 with meta-llama-3.1-8b-instruct-q4_0.gguf",
    ])
  })

  it("fails when the rendered prompt drifts from the reference", async () => {
    const h = harness({
      http: { "/apply-template": reply(200, { prompt: "other" }) },
    })
    expect(await main(["check-template"], h.deps)).toBe(1)
    expect(h.err[0]).toMatch(
      /^FAIL: rendered prompt: rendered prompt differs from the reference at character 0/
    )
  })

  it("fails without a reference prompt for the pinned file", async () => {
    const h = harness()
    const deps = { ...h.deps, fixtureDir: "/nowhere" }
    expect(await main(["check-template"], deps)).toBe(1)
    expect(h.err).toEqual([
      "FAIL: no reference prompt at /nowhere/meta-llama-3.1-8b-instruct-q4_0.gguf.prompt.txt",
    ])
  })
})

describe("llama plan", () => {
  it("prints the plist and the bootstrap command and writes nothing", async () => {
    const h = harness()
    expect(await main(["plan"], h.deps)).toBe(0)
    expect(h.out[0]).toBe(`# ${PLIST}`)
    expect(h.out[1]).toContain(
      `<key>EIDO_LLAMA_SERVER_BIN</key>\n    <string>${BIN}</string>`
    )
    expect(h.out[2]).toBe(`launchctl bootstrap gui/501 ${PLIST}`)
    expect(h.written).toEqual({})
    expect(h.ran).toEqual([])
  })
})

describe("llama install", () => {
  it("writes the plist and bootstraps the agent", async () => {
    const h = harness({
      runs: {
        [`launchctl bootstrap gui/501 ${PLIST}`]: {
          code: 0,
          stdout: "",
          stderr: "",
        },
      },
    })
    expect(await main(["install"], h.deps)).toBe(0)
    expect(Object.keys(h.written)).toEqual([PLIST])
    expect(h.made).toEqual([`${HOME}/Library/Logs/eido`])
    expect(h.ran).toEqual([
      "launchctl print gui/501/com.eido.llama-server",
      `launchctl bootstrap gui/501 ${PLIST}`,
    ])
  })

  it("boots out an already loaded agent first", async () => {
    const h = harness({
      runs: {
        "launchctl print gui/501/com.eido.llama-server": {
          code: 0,
          stdout: "",
          stderr: "",
        },
        [`launchctl bootstrap gui/501 ${PLIST}`]: {
          code: 0,
          stdout: "",
          stderr: "",
        },
      },
    })
    expect(await main(["install"], h.deps)).toBe(0)
    expect(h.ran[1]).toBe("launchctl bootout gui/501/com.eido.llama-server")
  })

  it("reports a failed bootstrap", async () => {
    const h = harness({
      runs: {
        [`launchctl bootstrap gui/501 ${PLIST}`]: {
          code: 5,
          stdout: "",
          stderr: "Input/output error\n",
        },
      },
    })
    expect(await main(["install"], h.deps)).toBe(1)
    expect(h.err).toEqual(["FAIL: launchctl bootstrap: Input/output error"])
  })

  it("installs nothing without the binary or the model", async () => {
    const noBinary = harness({
      env: { EIDO_LLAMA_SERVER_BIN: "/missing/llama-server" },
    })
    expect(await main(["install"], noBinary.deps)).toBe(1)
    expect(noBinary.err).toEqual([
      "FAIL: no llama-server at /missing/llama-server; see infra/llama-server.md",
    ])
    const noModel = harness({ env: { EIDO_MODEL_DIR: "/empty" } })
    expect(await main(["install"], noModel.deps)).toBe(1)
    expect(noModel.err[0]).toMatch(/^FAIL: no model file at \/empty\//)
    expect(noModel.written).toEqual({})
  })
})

describe("llama uninstall", () => {
  it("boots out the loaded agent and removes the plist", async () => {
    const h = harness({
      files: { [PLIST]: "" },
      runs: {
        "launchctl print gui/501/com.eido.llama-server": {
          code: 0,
          stdout: "",
          stderr: "",
        },
        "launchctl bootout gui/501/com.eido.llama-server": {
          code: 0,
          stdout: "",
          stderr: "",
        },
      },
    })
    expect(await main(["uninstall"], h.deps)).toBe(0)
    expect(h.removed).toEqual([PLIST])
  })

  it("is a no-op when nothing is installed", async () => {
    const h = harness()
    expect(await main(["uninstall"], h.deps)).toBe(0)
    expect(h.removed).toEqual([])
  })

  it("reports a failed bootout and keeps the plist", async () => {
    const h = harness({
      files: { [PLIST]: "" },
      runs: {
        "launchctl print gui/501/com.eido.llama-server": {
          code: 0,
          stdout: "",
          stderr: "",
        },
        "launchctl bootout gui/501/com.eido.llama-server": {
          code: 3,
          stdout: "",
          stderr: "",
        },
      },
    })
    expect(await main(["uninstall"], h.deps)).toBe(1)
    expect(h.err).toEqual(["FAIL: launchctl bootout: 3"])
    expect(h.removed).toEqual([])
  })
})

describe("llama status", () => {
  const lsof = "lsof -nP -iTCP:8080 -sTCP:LISTEN -Fpcn"

  it("reports the job, a loopback-only listener and /health", async () => {
    const h = harness({
      runs: {
        "launchctl print gui/501/com.eido.llama-server": {
          code: 0,
          stdout: "\tstate = running\n\truns = 2\n\tpid = 77\n",
          stderr: "",
        },
        [lsof]: {
          code: 0,
          stdout: "p78\ncllama-server\nn127.0.0.1:8080\n",
          stderr: "",
        },
      },
    })
    expect(await main(["status"], h.deps)).toBe(0)
    expect(h.out).toEqual([
      "launchd: gui/501/com.eido.llama-server state running, pid 77, runs 2, last exit none",
      "ok: port 8080 listens on loopback only: llama-server (pid 78) on 127.0.0.1",
      "ok: /health 200",
    ])
  })

  it("fails when the port is open beyond loopback or /health is down", async () => {
    const h = harness({
      runs: {
        [lsof]: {
          code: 0,
          stdout: "p78\ncllama-server\nn*:8080\n",
          stderr: "",
        },
      },
      http: { "/health": reply(503, {}) },
    })
    expect(await main(["status"], h.deps)).toBe(1)
    expect(h.out).toEqual([
      "launchd: gui/501/com.eido.llama-server is not loaded",
    ])
    expect(h.err).toEqual([
      "FAIL: port 8080 is reachable beyond loopback: llama-server (pid 78) on *",
      "FAIL: /health 503",
    ])
  })

  it("fails when nothing answers", async () => {
    const h = harness({
      runs: {
        "launchctl print gui/501/com.eido.llama-server": {
          code: 0,
          stdout: "",
          stderr: "",
        },
      },
      http: { "/health": new Error("ECONNREFUSED") },
    })
    expect(await main(["status"], h.deps)).toBe(1)
    expect(h.out).toEqual([
      "launchd: gui/501/com.eido.llama-server state unknown, pid none, runs unknown, last exit none",
    ])
    expect(h.err).toEqual([
      "FAIL: nothing listens on port 8080",
      "FAIL: /health: ECONNREFUSED",
    ])
  })
})

describe("usage", () => {
  it("rejects an unknown command", async () => {
    const h = harness()
    expect(await main(["start"], h.deps)).toBe(2)
    expect(h.err).toEqual([
      "usage: llama verify|verify-archive PATH|launch|check-template|plan|install|uninstall|status",
    ])
  })
})
