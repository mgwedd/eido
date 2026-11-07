import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { main } from "./cli.ts"

import {
  SHA,
  SIZE,
  QWEN_SHA,
  OSS_SHA,
  OSS_SIZE,
  ASSET_SHA,
  HOME,
  MODEL,
  QWEN,
  OSS,
  BIN,
  SETTINGS,
  PROFILES,
  RECORD,
  PLIST,
  VERSION,
  QWEN_PASS,
  PRINT,
  OK,
  WIN,
  reply,
  fail,
  tick,
  harness,
} from "./test-support.ts"

describe("llama verify", () => {
  it("passes the default profile's binary and model, and logs the digest", async () => {
    const h = harness()
    expect(await main(["verify"], h.deps)).toBe(0)
    expect(h.out).toEqual([
      `pin: profile gemma-4-26b-a4b, gemma-4-26B-A4B-it Q4_0 (QAT) (${MODEL}), llama.cpp b11149`,
      `ok: ${BIN} is b11149 (d2e54583c)`,
      `ok: ${MODEL} sha256 ${SHA} (hashed in 1.0 s)`,
    ])
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
    expect(h.err[0]).toMatch(/^FAIL: model\.lock line 1: unknown key "model"/)
  })

  it("reads the lock from EIDO_MODEL_LOCK", async () => {
    const h = harness({ env: { EIDO_MODEL_LOCK: "/elsewhere/model.lock" } })
    expect(await main(["verify"], h.deps)).toBe(1)
    expect(h.err).toEqual(["FAIL: ENOENT: /elsewhere/model.lock"])
  })

  it("checks the active profile from the settings file", async () => {
    const h = harness({
      files: { [SETTINGS]: "EIDO_LLAMA_MODEL=gpt-oss-20b\n" },
    })
    expect(await main(["verify"], h.deps)).toBe(1)
    expect(h.out[0]).toBe(
      `pin: profile gpt-oss-20b, gpt-oss-20b MXFP4 (${OSS}), llama.cpp b11149`
    )
    expect(h.err).toEqual([`FAIL: no model file at ${OSS}`])
  })

  it("fails on an active id that is not a profile", async () => {
    const h = harness({ env: { EIDO_LLAMA_MODEL: "nope" } })
    expect(await main(["verify"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      'FAIL: unknown model profile "nope"; the profiles are gemma-4-26b-a4b, qwen3.6-35b-a3b, gpt-oss-20b',
    ])
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
      "FAIL: no model file at /empty/gemma-4-26B_q4_0-it.gguf",
      "llama-server was not started",
    ])
  })

  it("starts the default profile on loopback with --jinja and its flags, then reports ready", async () => {
    const h = harness()
    const running = main(["launch"], h.deps)
    await tick()
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
    expect(args.slice(-2)).toEqual(["--reasoning", "off"])
    expect(h.out.at(-1)).toMatch(
      /^ok: llama-server ready on http:\/\/127\.0\.0\.1:8080 in [\d.]+ s; profile gemma-4-26b-a4b, chat template has <\|turn>model$/
    )
    process.exit(0)
    expect(await running).toBe(1)
    expect(h.err).toEqual(["llama-server exited with code 0"])
  })

  it("loads the active profile's file, kwargs, flags and marker, and no other file", async () => {
    const h = harness({
      files: {
        [SETTINGS]: "EIDO_LLAMA_MODEL=qwen3.6-35b-a3b\n",
        [QWEN]: "",
        [RECORD]: QWEN_PASS,
      },
      http: {
        "/props": reply(200, {
          chat_template: "{% if messages[1].role == 'developer' %}",
        }),
      },
    })
    const running = main(["launch"], h.deps)
    await tick()
    const { args, process } = h.spawned[0] ?? fail()
    expect(args[1]).toBe(QWEN)
    expect(args.filter((a) => a.endsWith(".gguf"))).toEqual([QWEN])
    expect(args.slice(-2)).toEqual([
      "--chat-template-kwargs",
      '{"enable_thinking":false}',
    ])
    expect(args).not.toContain("--reasoning")
    expect(h.out.at(-1)).toMatch(
      /; profile qwen3\.6-35b-a3b, chat template has messages\[1\]\.role == 'developer'$/
    )
    h.stop()
    expect(await running).toBe(0)
    expect(process.killed).toEqual(["SIGTERM"])
  })

  it("lets an exported EIDO_LLAMA_MODEL win over the settings file", async () => {
    const h = harness({
      env: { EIDO_LLAMA_MODEL: "gemma-4-26b-a4b" },
      files: { [SETTINGS]: "EIDO_LLAMA_MODEL=qwen3.6-35b-a3b\n" },
    })
    const running = main(["launch"], h.deps)
    await tick()
    expect(h.spawned[0]?.args[1]).toBe(MODEL)
    h.stop()
    expect(await running).toBe(0)
  })

  it("refuses an unverified profile before hashing anything", async () => {
    const h = harness({
      env: { EIDO_LLAMA_MODEL: "qwen3.6-35b-a3b" },
      files: { [QWEN]: "" },
    })
    expect(await main(["launch"], h.deps)).toBe(1)
    expect(h.spawned).toEqual([])
    expect(h.ran).toEqual([])
    expect(h.err).toEqual([
      "FAIL: profile qwen3.6-35b-a3b has not passed llama check-template with llama.cpp b11149 on this machine; run llama check-template --model qwen3.6-35b-a3b",
      "llama-server was not started",
    ])
  })

  it("does not count a recorded pass for another file or another build", async () => {
    for (const record of [
      `qwen3.6-35b-a3b ${"0".repeat(64)} b11149\n`,
      `qwen3.6-35b-a3b ${QWEN_SHA} b11000\n`,
      `gpt-oss-20b ${QWEN_SHA} b11149\n`,
    ]) {
      const h = harness({
        env: { EIDO_LLAMA_MODEL: "qwen3.6-35b-a3b" },
        files: { [QWEN]: "", [RECORD]: record },
      })
      expect(await main(["launch"], h.deps)).toBe(1)
      expect(h.spawned).toEqual([])
    }
  })

  it("passes on a crash exit code so launchd sees the failure", async () => {
    const h = harness()
    const running = main(["launch"], h.deps)
    await tick()
    h.spawned[0]?.process.exit(139)
    expect(await running).toBe(139)
  })

  it("exits 0 when stopped while still waiting for /health", async () => {
    const h = harness({ http: { "/health": reply(503, {}) } })
    const deps = { ...h.deps, sleep: () => (h.stop(), Promise.resolve()) }
    expect(await main(["launch"], deps)).toBe(0)
    expect(h.spawned[0]?.process.killed).toEqual(["SIGTERM"])
  })

  it("stops llama-server when the loaded template is not the profile's", async () => {
    const h = harness({
      http: { "/props": reply(200, { chat_template: "<start_of_turn>" }) },
    })
    expect(await main(["launch"], h.deps)).toBe(1)
    expect(h.spawned[0]?.process.killed).toEqual(["SIGTERM"])
    expect(h.err).toEqual([
      'FAIL: /props chat_template does not contain "<|turn>model"',
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

  it("runs on Windows from %LOCALAPPDATA% with llama-server.exe", async () => {
    const root = "C:\\Users\\s\\AppData\\Local\\eido-dev"
    const bin = `${root}\\llama.cpp\\b11149\\llama-server.exe`
    const model = `${root}\\models\\gemma-4-26B_q4_0-it.gguf`
    const h = harness({
      platform: WIN,
      env: { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" },
      files: { [bin]: "", [model]: "" },
      runs: { [`${bin} --version`]: { code: 0, stdout: "", stderr: VERSION } },
    })
    h.deps.probe.size = (p) => Promise.resolve(p === model ? SIZE : undefined)
    h.deps.probe.sha256 = () => Promise.resolve(SHA)
    const running = main(["launch"], h.deps)
    await tick()
    expect(h.spawned[0]?.command).toBe(bin)
    expect(h.spawned[0]?.args[1]).toBe(model)
    h.stop()
    expect(await running).toBe(0)
  })
})

describe("llama start", () => {
  it("runs on Windows from %LOCALAPPDATA% with llama-server.exe", async () => {
    const root = "C:\\Users\\s\\AppData\\Local\\eido-dev"
    const bin = `${root}\\llama.cpp\\b11149\\llama-server.exe`
    const model = `${root}\\models\\gemma-4-26B_q4_0-it.gguf`
    const h = harness({
      platform: WIN,
      env: { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" },
      files: { [bin]: "", [model]: "" },
      runs: { [`${bin} --version`]: { code: 0, stdout: "", stderr: VERSION } },
    })
    h.deps.probe.size = (p) => Promise.resolve(p === model ? SIZE : undefined)
    h.deps.probe.sha256 = () => Promise.resolve(SHA)
    const running = main(["start"], h.deps)
    await tick()
    expect(h.ran).toEqual([`${bin} --version`])
    expect(h.spawned[0]?.command).toBe(bin)
    expect(h.spawned[0]?.args[1]).toBe(model)
    h.stop()
    expect(await running).toBe(0)
  })

  it("runs on Linux from ~/.local/share/eido-dev with llama-server", async () => {
    const root = `${HOME}/.local/share/eido-dev`
    const bin = `${root}/llama.cpp/b11149/llama-server`
    const model = `${root}/models/gemma-4-26B_q4_0-it.gguf`
    const h = harness({
      platform: { os: "linux", arch: "x64" },
      files: { [bin]: "", [model]: "" },
      runs: { [`${bin} --version`]: { code: 0, stdout: "", stderr: VERSION } },
    })
    h.deps.probe.size = (p) => Promise.resolve(p === model ? SIZE : undefined)
    h.deps.probe.sha256 = () => Promise.resolve(SHA)
    const running = main(["start"], h.deps)
    await tick()
    expect(h.ran).toEqual([`${bin} --version`])
    expect(h.spawned[0]?.command).toBe(bin)
    expect(h.spawned[0]?.args[1]).toBe(model)
    h.stop()
    expect(await running).toBe(0)
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

  it("checks the Windows zip on win32", async () => {
    const zip = "C:\\dl\\llama-b11149-bin-win-vulkan-x64.zip"
    const h = harness({ platform: WIN, files: { [zip]: "" } })
    h.deps.probe.sha256 = () =>
      Promise.resolve(
        "ca432b775c5dcb5af85bbdcf22b06b6e2dca792f30334b19ef4a45ee4a512446"
      )
    expect(await main(["verify-archive", zip], h.deps)).toBe(0)
    const mac = harness({ platform: WIN, files: { [path]: "" } })
    expect(await main(["verify-archive", path], mac.deps)).toBe(1)
    expect(mac.err).toEqual([
      `FAIL: ${path} is not llama-b11149-bin-win-vulkan-x64.zip`,
    ])
  })

  it("needs a path", async () => {
    const h = harness()
    expect(await main(["verify-archive"], h.deps)).toBe(2)
  })
})

describe("llama fetch", () => {
  it("installs the active profile's model from the lock URL when the build is in place", async () => {
    const h = harness({ env: { EIDO_LLAMA_MODEL: "gpt-oss-20b" } })
    h.deps.probe.size = (p) =>
      Promise.resolve(
        p === `${OSS}.partial` ? OSS_SIZE : p === OSS ? undefined : 10
      )
    h.deps.probe.sha256 = () => Promise.resolve(OSS_SHA)
    expect(await main(["fetch"], h.deps)).toBe(0)
    expect(h.downloaded).toEqual([
      `https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/15dcfc7e7c608c6161507211ed43c5b590801b4b/gpt-oss-20b-MXFP4.gguf -> ${OSS}.partial`,
    ])
    expect(h.out[0]).toBe("profile gpt-oss-20b: gpt-oss-20b MXFP4")
    expect(h.out.at(-1)).toBe(
      "ok: b11149 and profile gpt-oss-20b are installed"
    )
  })

  it("re-verifies and downloads nothing when everything is in place", async () => {
    const h = harness()
    expect(await main(["fetch", "--model", "gemma-4-26b-a4b"], h.deps)).toBe(0)
    expect(h.downloaded).toEqual([])
  })

  it("stops when the build does not match", async () => {
    const h = harness({
      version: {
        code: 0,
        stdout: "",
        stderr: "version: 1 (build 1, commit 1234567)",
      },
    })
    expect(await main(["fetch"], h.deps)).toBe(1)
    expect(h.downloaded).toEqual([])
  })

  it("stops when the model does not match", async () => {
    const h = harness({ sha: "0".repeat(64) })
    expect(await main(["fetch"], h.deps)).toBe(1)
    expect(h.err[0]).toMatch(/fetch does not replace an existing file/)
  })

  it("rejects other arguments and unknown profiles", async () => {
    const h = harness()
    expect(await main(["fetch", "--modle", "x"], h.deps)).toBe(2)
    expect(await main(["fetch", "--model", "nope"], h.deps)).toBe(1)
    expect(h.err.at(-1)).toMatch(/^FAIL: unknown model profile "nope"/)
  })
})

describe("llama list", () => {
  it("shows each profile, whether it is on disk and verified, and the default and active one", async () => {
    const h = harness({ files: { [QWEN]: "" } })
    h.deps.probe.size = (p) =>
      Promise.resolve(p === MODEL ? SIZE : p === QWEN ? 5 : undefined)
    expect(await main(["list"], h.deps)).toBe(0)
    expect(h.out).toEqual([
      "* gemma-4-26b-a4b: gemma-4-26B-A4B-it Q4_0 (QAT), on disk, verified, default, active",
      "  qwen3.6-35b-a3b: Qwen3.6-35B-A3B UD-Q4_K_M, wrong size (5 bytes), unverified",
      "  gpt-oss-20b: gpt-oss-20b MXFP4, not on disk, unverified",
    ])
  })

  it("marks a profile verified by a recorded pass, and an added one", async () => {
    const h = harness({
      files: {
        [SETTINGS]: "EIDO_LLAMA_MODEL=qwen3.6-35b-a3b\n",
        [QWEN]: "",
        [RECORD]: QWEN_PASS,
        [PROFILES]: `[profile mine]\nmodel: o/r\nquantization: Q8_0\nfile: m.gguf\nsource: https://example.invalid/m.gguf\nsize: 9\nsha256: ${"e".repeat(64)}\n`,
      },
    })
    expect(await main(["list"], h.deps)).toBe(0)
    expect(h.out.slice(1, 2)).toEqual([
      "* qwen3.6-35b-a3b: Qwen3.6-35B-A3B UD-Q4_K_M, on disk, verified, active",
    ])
    expect(h.out.at(-1)).toBe(
      "  mine: o/r Q8_0, not on disk, unverified, added"
    )
  })

  it("fails when the active id is not a profile", async () => {
    const h = harness({ files: { [SETTINGS]: "EIDO_LLAMA_MODEL=gone\n" } })
    expect(await main(["list"], h.deps)).toBe(1)
    expect(h.out).toHaveLength(3)
    expect(h.err).toEqual([
      'FAIL: the active profile "gone" is not in model.lock; run llama use with one of the ids above',
    ])
  })

  it("fails on a user profile with the id of a lock profile", async () => {
    const h = harness({
      files: {
        [PROFILES]: `[profile gpt-oss-20b]\nmodel: o/r\nquantization: Q8_0\nfile: m.gguf\nsource: https://example.invalid/m.gguf\nsize: 9\nsha256: ${"e".repeat(64)}\n`,
      },
    })
    expect(await main(["list"], h.deps)).toBe(1)
    expect(h.err).toEqual([
      `FAIL: ${PROFILES}: profile gpt-oss-20b is also in model.lock; rename one of them`,
    ])
  })
})

describe("llama use", () => {
  const verified = { [QWEN]: "", [RECORD]: QWEN_PASS }

  it("writes only EIDO_LLAMA_MODEL to the settings file, privately, and keeps the other settings", async () => {
    const h = harness({
      files: {
        ...verified,
        [SETTINGS]: "EIDO_LLAMA_MODEL=gemma-4-26b-a4b\nEIDO_CORE_PORT=4000\n",
      },
    })
    expect(await main(["use", "qwen3.6-35b-a3b"], h.deps)).toBe(0)
    expect(h.written).toEqual({
      [SETTINGS]:
        "# Written by the Eido stack (pnpm stack:setup). Non-secret settings only.\nEIDO_CORE_PORT=4000\nEIDO_LLAMA_MODEL=qwen3.6-35b-a3b\n",
    })
    expect(h.privately).toEqual([SETTINGS])
    expect(h.out).toEqual([
      `ok: EIDO_LLAMA_MODEL=qwen3.6-35b-a3b in ${SETTINGS}`,
      "gui/501/com.eido.llama-server is not installed; nothing to restart",
    ])
  })

  it("creates the settings file under EIDO_STACK_DIR", async () => {
    const h = harness({ env: { EIDO_STACK_DIR: "/stack" } })
    expect(await main(["use", "gemma-4-26b-a4b"], h.deps)).toBe(0)
    expect(h.made).toEqual(["/stack"])
    expect(h.written).toEqual({
      "/stack/stack.env":
        "# Written by the Eido stack (pnpm stack:setup). Non-secret settings only.\nEIDO_LLAMA_MODEL=gemma-4-26b-a4b\n",
    })
  })

  it("refuses a settings file that is not mode 0600, or holds a key outside the allowlist, writing nothing", async () => {
    const open = harness({
      settingsMode: 0o100644,
      files: { [SETTINGS]: "EIDO_LLAMA_MODEL=gemma-4-26b-a4b\n" },
    })
    expect(await main(["use", "gemma-4-26b-a4b"], open.deps)).toBe(1)
    expect(open.err).toEqual([
      `FAIL: ${SETTINGS} has mode 0644, not 0600; fix with: chmod 600 '${SETTINGS}'`,
    ])
    const typo = harness({ files: { [SETTINGS]: "EIDO_LLAMA_MODLE=x\n" } })
    expect(await main(["launch"], typo.deps)).toBe(1)
    expect(typo.err).toEqual([
      `FAIL: ${SETTINGS}: EIDO_LLAMA_MODLE is not a stack setting`,
    ])
    for (const h of [open, typo]) expect(h.written).toEqual({})
  })

  it("restarts the installed LaunchAgent", async () => {
    const h = harness({
      runs: {
        [PRINT]: OK,
        "launchctl kickstart -k gui/501/com.eido.llama-server": OK,
      },
    })
    expect(await main(["use", "gemma-4-26b-a4b"], h.deps)).toBe(0)
    expect(h.ran).toEqual([
      PRINT,
      "launchctl kickstart -k gui/501/com.eido.llama-server",
    ])
    expect(h.out.at(-1)).toBe(
      "ok: restarted gui/501/com.eido.llama-server; it verifies and loads gemma-4-26b-a4b"
    )
  })

  it("reports a failed restart", async () => {
    const h = harness({
      runs: {
        [PRINT]: OK,
        "launchctl kickstart -k gui/501/com.eido.llama-server": {
          code: 113,
          stdout: "",
          stderr: "Could not find service\n",
        },
      },
    })
    expect(await main(["use", "gemma-4-26b-a4b"], h.deps)).toBe(1)
    expect(h.err).toEqual(["FAIL: launchctl kickstart: Could not find service"])
  })

  it("notes an exported EIDO_LLAMA_MODEL that still wins", async () => {
    const h = harness({ env: { EIDO_LLAMA_MODEL: "qwen3.6-35b-a3b" } })
    expect(await main(["use", "gemma-4-26b-a4b"], h.deps)).toBe(0)
    expect(h.out[1]).toBe(
      "note: EIDO_LLAMA_MODEL=qwen3.6-35b-a3b is exported in this shell and wins over the file here"
    )
  })

  it("refuses a profile whose file is not on disk, an unverified one and an unknown id, writing nothing", async () => {
    const missing = harness()
    expect(await main(["use", "gpt-oss-20b"], missing.deps)).toBe(1)
    expect(missing.err).toEqual([
      `FAIL: ${OSS} is not on disk; run llama fetch --model gpt-oss-20b first`,
    ])
    const unverified = harness({ files: { [QWEN]: "" } })
    expect(await main(["use", "qwen3.6-35b-a3b"], unverified.deps)).toBe(1)
    expect(unverified.err[0]).toMatch(
      /^FAIL: profile qwen3\.6-35b-a3b has not passed llama check-template/
    )
    const unknown = harness()
    expect(await main(["use", "nope"], unknown.deps)).toBe(1)
    for (const h of [missing, unverified, unknown])
      expect(h.written).toEqual({})
  })

  it("needs an id", async () => {
    const h = harness()
    expect(await main(["use"], h.deps)).toBe(2)
  })

  it("says there is no LaunchAgent to restart on Windows", async () => {
    const root = "C:\\Users\\s\\AppData\\Local\\eido-dev"
    const model = `${root}\\models\\gemma-4-26B_q4_0-it.gguf`
    const h = harness({
      platform: WIN,
      uid: undefined,
      env: { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" },
      files: { [model]: "" },
    })
    h.deps.uid = undefined
    h.deps.probe.size = (p) => Promise.resolve(p === model ? SIZE : undefined)
    expect(await main(["use", "gemma-4-26b-a4b"], h.deps)).toBe(0)
    expect(h.written).toEqual({
      [`${root}\\stack.env`]:
        "# Written by the Eido stack (pnpm stack:setup). Non-secret settings only.\nEIDO_LLAMA_MODEL=gemma-4-26b-a4b\n",
    })
    expect(h.ran).toEqual([])
    expect(h.out.at(-1)).toBe(
      "no LaunchAgent on this platform (#629); stop and rerun llama launch to load gemma-4-26b-a4b"
    )
  })
})

describe("llama check-template", () => {
  it("checks the running server, and records the pass", async () => {
    const h = harness()
    expect(await main(["check-template"], h.deps)).toBe(0)
    expect(h.out).toEqual([
      "ok: chat template",
      "ok: rendered prompt",
      "ok: JSON-schema request",
      "ok: template check passed on b11149 with gemma-4-26B_q4_0-it.gguf",
      `ok: recorded the pass for gemma-4-26b-a4b in ${RECORD}`,
    ])
    expect(h.written).toEqual({ [RECORD]: `gemma-4-26b-a4b ${SHA} b11149\n` })
  })

  it("fails when the rendered prompt drifts from the reference, and records nothing", async () => {
    const h = harness({
      http: { "/apply-template": reply(200, { prompt: "other" }) },
    })
    expect(await main(["check-template"], h.deps)).toBe(1)
    expect(h.err[0]).toMatch(
      /^FAIL: rendered prompt: rendered prompt differs from the reference at character 0/
    )
    expect(h.written).toEqual({})
  })

  it("says so when there is no reference prompt for the file, and still runs the other checks", async () => {
    const h = harness({
      http: { "/v1/chat/completions": reply(200, { choices: [] }) },
    })
    const deps = { ...h.deps, fixtureDir: "/nowhere" }
    expect(await main(["check-template"], deps)).toBe(1)
    expect(h.out).toEqual([
      `note: no reference prompt at ${join("/nowhere", "gemma-4-26B_q4_0-it.gguf.prompt.txt")}; the rendered prompt is not compared`,
      "ok: chat template",
    ])
    expect(h.requests.some((r) => r.includes("/apply-template"))).toBe(false)
    expect(h.err[0]).toMatch(/^FAIL: JSON-schema request: /)
  })

  it("will not check an unverified active profile, since launch does not run it", async () => {
    const h = harness({ env: { EIDO_LLAMA_MODEL: "qwen3.6-35b-a3b" } })
    expect(await main(["check-template"], h.deps)).toBe(1)
    expect(h.requests).toEqual([])
    expect(h.err).toEqual([
      "FAIL: profile qwen3.6-35b-a3b is not verified, so launch does not run it; run llama check-template --model qwen3.6-35b-a3b",
    ])
  })

  it("with --model starts the profile itself, checks it, stops it and records the pass", async () => {
    const h = harness({
      files: { [QWEN]: "", [RECORD]: `gemma-4-26b-a4b ${SHA} b11149\n` },
      http: {
        "/health": [new Error("ECONNREFUSED"), reply(200, { status: "ok" })],
        "/props": reply(200, {
          chat_template: "{% if messages[1].role == 'developer' %}",
        }),
      },
    })
    expect(
      await main(["check-template", "--model", "qwen3.6-35b-a3b"], h.deps)
    ).toBe(0)
    const { args, process } = h.spawned[0] ?? fail()
    expect(args[1]).toBe(QWEN)
    expect(process.killed).toEqual(["SIGTERM"])
    expect(h.out).toContain(
      `note: no reference prompt at ${join("/repo/infra/llama/fixtures", "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf.prompt.txt")}; the rendered prompt is not compared`
    )
    expect(h.written).toEqual({
      [RECORD]: `gemma-4-26b-a4b ${SHA} b11149\n${QWEN_PASS}`,
    })
  })

  it("with --model stops the server and records nothing when a check fails", async () => {
    const h = harness({
      files: { [QWEN]: "" },
      http: { "/health": [new Error("ECONNREFUSED"), reply(200, {})] },
    })
    expect(
      await main(["check-template", "--model", "qwen3.6-35b-a3b"], h.deps)
    ).toBe(1)
    expect(h.spawned[0]?.process.killed).toEqual(["SIGTERM"])
    expect(h.err).toEqual([
      `FAIL: chat template: /props chat_template does not contain "messages[1].role == 'developer'"`,
    ])
    expect(h.written).toEqual({})
  })

  it("with --model refuses when a server already answers on the port", async () => {
    const h = harness({ files: { [QWEN]: "" } })
    expect(
      await main(["check-template", "--model", "qwen3.6-35b-a3b"], h.deps)
    ).toBe(1)
    expect(h.spawned).toEqual([])
    expect(h.err).toEqual([
      "FAIL: a server already answers on http://127.0.0.1:8080; stop it so check-template can start qwen3.6-35b-a3b there",
    ])
  })

  it("with --model fails without starting anything when the model is not on disk", async () => {
    const h = harness({ http: { "/health": new Error("ECONNREFUSED") } })
    expect(
      await main(["check-template", "--model", "gpt-oss-20b"], h.deps)
    ).toBe(1)
    expect(h.spawned).toEqual([])
    expect(h.err).toEqual([
      `FAIL: no model file at ${OSS}`,
      "llama-server was not started",
    ])
  })

  it("rejects other arguments", async () => {
    const h = harness()
    expect(await main(["check-template", "qwen"], h.deps)).toBe(2)
  })
})

describe("llama add", () => {
  const REPO = "example/Model-GGUF"
  const REV = "1".repeat(40)
  const FILE_SHA = "f".repeat(64)
  const pathsInfo = `/api/models/${REPO}/paths-info/${REV}`
  const entry = (path: string) =>
    reply(200, [
      { type: "file", path, size: 7, lfs: { oid: FILE_SHA, size: 7 } },
    ])

  it("pins the repo's current revision and the Hub's size and sha256 in the user's profiles file", async () => {
    const h = harness({
      http: {
        [`/api/models/${REPO}`]: reply(200, { sha: REV }),
        [pathsInfo]: entry("Model-Q5_K_M.gguf"),
      },
    })
    expect(await main(["add", REPO, "Model-Q5_K_M.gguf"], h.deps)).toBe(0)
    expect(h.requests).toEqual([
      `https://huggingface.co/api/models/${REPO}`,
      `https://huggingface.co${pathsInfo} {"paths":["Model-Q5_K_M.gguf"]}`,
    ])
    expect(h.written).toEqual({
      [PROFILES]: [
        `# llama add ${REPO} Model-Q5_K_M.gguf --revision ${REV}`,
        "[profile model-q5_k_m]",
        `model: ${REPO}`,
        "quantization: Q5_K_M",
        "file: Model-Q5_K_M.gguf",
        `source: https://huggingface.co/${REPO}/resolve/${REV}/Model-Q5_K_M.gguf`,
        "size: 7",
        `sha256: ${FILE_SHA}`,
        "",
      ].join("\n"),
    })
    expect(h.written[`/repo/infra/model.lock`]).toBeUndefined()
    expect(h.out.slice(1)).toEqual([
      "next:",
      "  llama fetch --model model-q5_k_m",
      "  llama check-template --model model-q5_k_m",
      "  then run the model eval (#28) before relying on it",
    ])
  })

  it("appends to an existing file with the given revision, id, marker and kwargs", async () => {
    const before = `[profile mine]\nmodel: o/r\nquantization: Q8_0\nfile: m.gguf\nsource: https://example.invalid/m.gguf\nsize: 9\nsha256: ${"e".repeat(64)}\n`
    const h = harness({
      files: { [PROFILES]: before },
      http: { [pathsInfo]: entry("sub/Model-Q5_K_M.gguf") },
    })
    expect(
      await main(
        [
          "add",
          REPO,
          "sub/Model-Q5_K_M.gguf",
          "--revision",
          REV,
          "--id",
          "big",
          "--marker",
          "<|im_start|>",
          "--kwargs",
          '{"enable_thinking": false}',
        ],
        h.deps
      )
    ).toBe(0)
    expect(h.requests).toHaveLength(1)
    const text = h.written[PROFILES] ?? ""
    expect(text.startsWith(`${before}\n# llama add`)).toBe(true)
    expect(text).toContain("[profile big]\n")
    expect(text).toContain("file: Model-Q5_K_M.gguf\n")
    expect(text).toContain(`/resolve/${REV}/sub/Model-Q5_K_M.gguf\n`)
    expect(text).toContain("chat_template_marker: <|im_start|>\n")
    expect(text).toContain('chat_template_kwargs: {"enable_thinking": false}\n')
  })

  it("writes nothing when the id clashes with model.lock or the kwargs are not JSON", async () => {
    const http = { [pathsInfo]: entry("Model-Q5_K_M.gguf") }
    const clash = harness({ http })
    expect(
      await main(
        [
          "add",
          REPO,
          "Model-Q5_K_M.gguf",
          "--revision",
          REV,
          "--id",
          "gpt-oss-20b",
        ],
        clash.deps
      )
    ).toBe(1)
    expect(clash.err).toEqual([
      `FAIL: ${PROFILES}: profile gpt-oss-20b is also in model.lock; rename one of them`,
    ])
    const bad = harness({ http })
    expect(
      await main(
        [
          "add",
          REPO,
          "Model-Q5_K_M.gguf",
          "--revision",
          REV,
          "--kwargs",
          "off",
        ],
        bad.deps
      )
    ).toBe(1)
    expect(bad.err).toEqual([
      "FAIL: profile model-q5_k_m: chat_template_kwargs must be a JSON object",
    ])
    const again = harness({
      http,
      files: {
        [PROFILES]: `[profile model-q5_k_m]\nmodel: o/r\nquantization: Q8_0\nfile: m.gguf\nsource: https://example.invalid/m.gguf\nsize: 9\nsha256: ${"e".repeat(64)}\n`,
      },
    })
    expect(
      await main(
        ["add", REPO, "Model-Q5_K_M.gguf", "--revision", REV],
        again.deps
      )
    ).toBe(1)
    expect(again.err).toEqual([
      `FAIL: ${PROFILES} line 10: profile model-q5_k_m appears twice`,
    ])
    for (const h of [clash, bad, again]) expect(h.written).toEqual({})
  })

  it("fails on a file the Hub does not have", async () => {
    const h = harness({ http: { [pathsInfo]: reply(200, []) } })
    expect(await main(["add", REPO, "x.gguf", "--revision", REV], h.deps)).toBe(
      1
    )
    expect(h.err).toEqual([`FAIL: ${REPO} has no file x.gguf at ${REV}`])
    expect(h.written).toEqual({})
  })

  it("rejects missing arguments and unknown or repeated flags", async () => {
    const h = harness()
    for (const args of [
      ["add"],
      ["add", REPO],
      ["add", REPO, "a.gguf", "--rev", REV],
      ["add", REPO, "a.gguf", "--id"],
      ["add", REPO, "a.gguf", "--id", "a", "--id", "b"],
    ])
      expect(await main(args, h.deps)).toBe(2)
    expect(h.requests).toEqual([])
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
    expect(h.out[1]).not.toContain("EIDO_LLAMA_MODEL")
    expect(h.out[2]).toBe(`launchctl bootstrap gui/501 ${PLIST}`)
    expect(h.written).toEqual({})
    expect(h.ran).toEqual([])
  })
})

describe("llama install", () => {
  it("writes the plist and bootstraps the agent", async () => {
    const h = harness({
      runs: { [`launchctl bootstrap gui/501 ${PLIST}`]: OK },
    })
    expect(await main(["install"], h.deps)).toBe(0)
    expect(Object.keys(h.written)).toEqual([PLIST])
    expect(h.made).toEqual([`${HOME}/Library/Logs/eido`])
    expect(h.ran).toEqual([PRINT, `launchctl bootstrap gui/501 ${PLIST}`])
  })

  it("boots out an already loaded agent first", async () => {
    const h = harness({
      runs: { [PRINT]: OK, [`launchctl bootstrap gui/501 ${PLIST}`]: OK },
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

  it("installs nothing for an unverified active profile, which launchd would restart in a loop", async () => {
    const h = harness({
      env: { EIDO_LLAMA_MODEL: "qwen3.6-35b-a3b" },
      files: { [QWEN]: "" },
    })
    expect(await main(["install"], h.deps)).toBe(1)
    expect(h.ran).toEqual([])
    expect(h.written).toEqual({})
  })

  it("fetches and verifies the Windows release asset and model on win32", async () => {
    const root = "C:\\Users\\s\\AppData\\Local\\eido-dev"
    const llamaDir = `${root}\\llama.cpp`
    const buildDir = `${llamaDir}\\b11149`
    const staging = `${llamaDir}\\.b11149.partial`
    const archive = `${llamaDir}\\llama-b11149-bin-win-vulkan-x64.zip.partial`
    const bin = `${buildDir}\\llama-server.exe`
    const model = `${root}\\models\\gemma-4-26B_q4_0-it.gguf`
    const winSha =
      "ca432b775c5dcb5af85bbdcf22b06b6e2dca792f30334b19ef4a45ee4a512446"
    const h = harness({
      platform: WIN,
      uid: undefined,
      env: { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" },
      runs: {
        [`tar -xf ${archive} -C ${staging}`]: OK,
        [`${bin} --version`]: { code: 0, stdout: "", stderr: VERSION },
      },
    })
    h.deps.uid = undefined
    h.deps.fs.list = (dir) =>
      dir === staging ? [{ name: "llama-server.exe", directory: false }] : []
    h.deps.probe.size = (p) =>
      Promise.resolve(p === `${model}.partial` ? SIZE : undefined)
    h.deps.probe.sha256 = (p) => Promise.resolve(p === archive ? winSha : SHA)
    expect(await main(["install"], h.deps)).toBe(0)
    expect(h.downloaded).toEqual([
      `https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-win-vulkan-x64.zip -> ${archive}`,
      `https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/d1c082be9cf3c8a514acf63b8761f4b41935842e/gemma-4-26B_q4_0-it.gguf -> ${model}.partial`,
    ])
    expect(h.ran).toEqual([
      `tar -xf ${archive} -C ${staging}`,
      `${bin} --version`,
    ])
    expect(h.out.at(-1)).toBe(
      "ok: b11149 and profile gemma-4-26b-a4b are installed"
    )
  })

  it("fetches and verifies the Linux release asset and model on linux without xattr", async () => {
    const root = `${HOME}/.local/share/eido-dev`
    const llamaDir = `${root}/llama.cpp`
    const buildDir = `${llamaDir}/b11149`
    const staging = `${llamaDir}/.b11149.partial`
    const archive = `${llamaDir}/llama-b11149-bin-ubuntu-vulkan-x64.tar.gz.partial`
    const bin = `${buildDir}/llama-server`
    const model = `${root}/models/gemma-4-26B_q4_0-it.gguf`
    const linuxSha =
      "d93606c124863e26750f0fa02daba8ae73aa39395507534fcbb57f5e7bbe7b55"
    const h = harness({
      platform: { os: "linux", arch: "x64" },
      runs: {
        [`tar -xf ${archive} -C ${staging}`]: OK,
        [`${bin} --version`]: { code: 0, stdout: "", stderr: VERSION },
      },
    })
    h.deps.fs.list = (dir) =>
      dir === staging ? [{ name: "llama-server", directory: false }] : []
    h.deps.probe.size = (p) =>
      Promise.resolve(p === `${model}.partial` ? SIZE : undefined)
    h.deps.probe.sha256 = (p) => Promise.resolve(p === archive ? linuxSha : SHA)
    expect(await main(["install"], h.deps)).toBe(0)
    expect(h.downloaded).toEqual([
      `https://github.com/ggml-org/llama.cpp/releases/download/b11149/llama-b11149-bin-ubuntu-vulkan-x64.tar.gz -> ${archive}`,
      `https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/d1c082be9cf3c8a514acf63b8761f4b41935842e/gemma-4-26B_q4_0-it.gguf -> ${model}.partial`,
    ])
    expect(h.ran).toEqual([
      `tar -xf ${archive} -C ${staging}`,
      `${bin} --version`,
    ])
    expect(h.out.at(-1)).toBe(
      "ok: b11149 and profile gemma-4-26b-a4b are installed"
    )
  })
})

describe("llama uninstall", () => {
  it("boots out the loaded agent and removes the plist", async () => {
    const h = harness({
      files: { [PLIST]: "" },
      runs: {
        [PRINT]: OK,
        "launchctl bootout gui/501/com.eido.llama-server": OK,
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
        [PRINT]: OK,
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
        [PRINT]: {
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
      runs: { [PRINT]: OK },
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

describe("launchd commands outside macOS", () => {
  for (const command of ["plan", "uninstall", "status"])
    for (const platform of [WIN, { os: "linux", arch: "x64" } as const])
      it(`${command} fails clearly on ${platform.os} and runs nothing`, async () => {
        const h = harness({ platform })
        h.deps.uid = undefined
        expect(await main([command], h.deps)).toBe(1)
        expect(h.err).toEqual([
          `FAIL: llama ${command} needs launchd and is not supported on this platform yet (#629)`,
        ])
        expect(h.ran).toEqual([])
        expect(h.written).toEqual({})
      })
})

describe("usage", () => {
  it("rejects an unknown command", async () => {
    const h = harness()
    expect(await main(["stop"], h.deps)).toBe(2)
    expect(h.err).toEqual([
      "usage: llama verify|verify-archive PATH|fetch [--model ID]|list|add REPO FILE [--revision SHA] [--id ID] [--marker TEXT] [--kwargs JSON]|use ID|launch|start|check-template [--model ID]|plan|install|uninstall|status",
    ])
  })
})
