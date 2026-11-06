import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  defaultVaultFile,
  formatCheck,
  meetsEngines,
  quote,
  runDoctor,
  type Check,
  type DoctorDeps,
} from "./doctor.ts"
import type { RunResult } from "./ports.ts"
import type { FileStat } from "./settings.ts"

const HOST = "node.example.ts.net"
const KEYCHAIN = "/home/u/Library/Keychains/eido/eido.keychain-db"
const MODEL =
  "/home/u/Library/Application Support/eido-dev/models/gemma-4-26B_q4_0-it.gguf"
const MODEL_SIZE = 14439363584
const MODEL_SHA =
  "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d"
const LLAMA_BIN =
  "/home/u/Library/Application Support/eido-dev/llama.cpp/b11149/llama-server"
const RUN = "/home/u/Library/Application Support/eido-dev/run"
const SECRET = "client-secret-value-never-printed"

const lockText = readFileSync(new URL("../model.lock", import.meta.url), "utf8")
const statusJson = readFileSync(
  new URL("../tailscale/fixtures/status.json", import.meta.url),
  "utf8"
)
const ok = (stdout = "", stderr = ""): RunResult => ({
  code: 0,
  stdout,
  stderr,
})
const missing: RunResult = { code: 1, stdout: "", stderr: "" }

const webEnv = (baseUrl = `http://localhost:3000,https://${HOST}:8443`) =>
  [
    "AUTH0_DOMAIN=tenant.example.invalid",
    "AUTH0_CLIENT_ID=abc",
    `AUTH0_CLIENT_SECRET=${SECRET}`,
    `AUTH0_SECRET=${SECRET}`,
    `APP_BASE_URL=${baseUrl}`,
    "EIDO_OWNER_EMAIL=owner@example.invalid",
  ].join("\n")

/** A Mac where every check passes; each test breaks one thing. */
function machine() {
  const files = new Map<string, string>([
    ["/repo/package.json", JSON.stringify({ engines: { node: ">=24" } })],
    ["/repo/node_modules/.modules.yaml", ""],
    ["/repo/apps/web/.env.local", webEnv()],
    ["/repo/infra/model.lock", lockText],
  ])
  const stats = new Map<string, FileStat>([
    [KEYCHAIN, { isFile: true, mode: 0o100600, size: 1 }],
    [MODEL, { isFile: true, mode: 0o100644, size: MODEL_SIZE }],
  ])
  const commands = new Map<string, RunResult>([
    ["tailscale status --json", ok(statusJson)],
    [`security show-keychain-info ${KEYCHAIN}`, ok()],
    [
      `${LLAMA_BIN} --version`,
      ok("", "version: 0.5.0-dev (build 11149, commit d2e54583c)"),
    ],
  ])
  const listeners = new Map<number, string>()
  const groups = new Map<number, number>()
  const health = { status: 200 as number | undefined }
  const calls: string[] = []
  let hashed = 0
  const netstat = { stdout: "" }
  const deps: DoctorDeps = {
    platform: "darwin",
    env: {
      EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
      EIDO_PUSH_VAPID_SUBJECT: "mailto:owner@example.invalid",
      EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
      EIDO_GMAIL_READ_CLIENT_ID: "read.example.invalid",
    },
    home: "/home/u",
    repoRoot: "/repo",
    nodeVersion: "v24.3.0",
    exec: (command, args) => {
      const line = [command, ...args].join(" ")
      calls.push(line)
      if (command === "lsof") {
        const port = Number(args[1]?.replace("-iTCP:", ""))
        const out = listeners.get(port)
        return Promise.resolve(out === undefined ? missing : ok(out))
      }
      if (command === "netstat") return Promise.resolve(ok(netstat.stdout))
      if (command === "ps") {
        const group = groups.get(Number(args.at(-1)))
        return Promise.resolve(group === undefined ? missing : ok(`${group}\n`))
      }
      return Promise.resolve(
        commands.get(line) ?? { code: 127, stdout: "", stderr: "not found" }
      )
    },
    fetch: (url) =>
      url === "http://127.0.0.1:8080/health" && health.status !== undefined
        ? Promise.resolve(new Response(null, { status: health.status }))
        : Promise.reject(new Error("ECONNREFUSED")),
    files: {
      exists: (path) => files.has(path),
      read: (path) => files.get(path),
      stat: (path) => stats.get(path),
    },
    sha256: () => {
      hashed++
      return Promise.resolve(MODEL_SHA)
    },
    now: () => 0,
  }
  return {
    deps,
    files,
    stats,
    commands,
    listeners,
    groups,
    netstat,
    health,
    calls,
    hashed: () => hashed,
  }
}

const full = { serve: true, quick: false }

async function only(
  m: ReturnType<typeof machine>,
  id: Check["id"],
  options = full
): Promise<Check[]> {
  return (await runDoctor(m.deps, options)).filter((c) => c.id === id)
}

describe("meetsEngines", () => {
  it("compares major, minor and patch against a >= range", () => {
    expect(meetsEngines("v24.0.0", ">=24")).toBe(true)
    expect(meetsEngines("v23.11.1", ">=24")).toBe(false)
    expect(meetsEngines("v24.1.0", ">=24.2")).toBe(false)
    expect(meetsEngines("v24.2.1", ">=24.2.1")).toBe(true)
    expect(meetsEngines("v24.2.0", "^24")).toBeUndefined()
  })
})

describe("runDoctor", () => {
  it("passes every check on a ready Mac, hashing the model", async () => {
    const m = machine()
    const checks = await runDoctor(m.deps, full)
    expect(checks.filter((c) => c.status !== "ok")).toEqual([])
    expect(checks.map((c) => c.id)).toEqual([
      "node",
      "dependencies",
      "tailscale",
      "web-env",
      "keychain",
      "push",
      "llama-pin",
      "llama-health",
      "gmail",
      "ports",
      "ports",
      "ports",
    ])
    expect(m.hashed()).toBe(1)
  })

  it("skips the model hash in quick mode and the tailnet with serve off", async () => {
    const m = machine()
    const checks = await runDoctor(m.deps, { serve: false, quick: true })
    expect(m.hashed()).toBe(0)
    expect(checks.map((c) => c.id)).not.toContain("tailscale")
    expect(m.calls).not.toContain("tailscale status --json")
  })

  it("fails an old node with the install fix", async () => {
    const m = machine()
    m.deps.nodeVersion = "v22.9.0"
    expect(await only(m, "node")).toEqual([
      {
        id: "node",
        platforms: ["darwin", "win32", "linux"],
        status: "fail",
        summary: "node v22.9.0 does not meet engines >=24",
        fix: { action: "install-node", text: "brew install node" },
      },
    ])
  })

  it("fails without node_modules", async () => {
    const m = machine()
    m.files.delete("/repo/node_modules/.modules.yaml")
    expect((await only(m, "dependencies"))[0]?.fix).toEqual({
      action: "install-dependencies",
      text: "pnpm install --frozen-lockfile",
    })
  })

  it("fails when Tailscale is not running, not connected, or has no MagicDNS", async () => {
    const m = machine()
    m.commands.set("tailscale status --json", {
      code: 1,
      stdout: "",
      stderr: "failed to connect to local tailscaled",
    })
    expect(await only(m, "tailscale")).toEqual([
      {
        id: "tailscale",
        platforms: ["darwin", "win32", "linux"],
        status: "fail",
        summary:
          "tailscale status failed: failed to connect to local tailscaled",
        fix: { action: "start-tailscale", text: "open -a Tailscale" },
      },
    ])
    m.commands.set(
      "tailscale status --json",
      ok(JSON.stringify({ BackendState: "Stopped" }))
    )
    expect((await only(m, "tailscale"))[0]).toMatchObject({
      summary: "Tailscale is not connected (Stopped)",
      fix: { action: "connect-tailscale", text: "tailscale up" },
    })
    m.commands.set(
      "tailscale status --json",
      ok(JSON.stringify({ BackendState: "Running", Self: {} }))
    )
    expect((await only(m, "tailscale"))[0]?.fix).toEqual({
      action: "enable-magicdns",
      text: "tailscale set --accept-dns=true",
    })
  })

  it("fails a missing .env.local with the copy command", async () => {
    const m = machine()
    m.files.delete("/repo/apps/web/.env.local")
    expect((await only(m, "web-env"))[0]?.fix).toEqual({
      action: "create-web-env",
      text: "cp apps/web/.env.example apps/web/.env.local",
    })
  })

  it("names missing .env.local keys and never prints a value", async () => {
    const m = machine()
    m.files.set(
      "/repo/apps/web/.env.local",
      `AUTH0_CLIENT_SECRET=${SECRET}\nAUTH0_SECRET=\nAPP_BASE_URL=https://other.example.invalid`
    )
    const [check] = await only(m, "web-env")
    expect(check).toEqual({
      id: "web-env",
      platforms: ["darwin", "win32", "linux"],
      status: "fail",
      summary:
        "apps/web/.env.local has no value for AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_SECRET, EIDO_OWNER_EMAIL",
      fix: {
        action: "add-web-env-keys",
        text: "set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_SECRET, EIDO_OWNER_EMAIL in apps/web/.env.local (docs/auth0-setup.md)",
      },
    })
  })

  it("fails when APP_BASE_URL lacks the :8443 origin, without printing it", async () => {
    const m = machine()
    m.files.set(
      "/repo/apps/web/.env.local",
      webEnv(`http://localhost:3000,https://${HOST}`)
    )
    const checks = await runDoctor(m.deps, full)
    const check = checks.find((c) => c.id === "web-env")
    expect(check?.fix).toEqual({
      action: "add-base-url",
      text: `add https://${HOST}:8443 to APP_BASE_URL in apps/web/.env.local`,
    })
    const printed = checks.flatMap(formatCheck).join("\n")
    expect(printed).not.toContain(SECRET)
    expect(printed).not.toContain("http://localhost:3000")
  })

  it("fails a missing keychain setting or file with setup as the fix", async () => {
    const m = machine()
    m.stats.delete(KEYCHAIN)
    expect((await only(m, "keychain"))[0]).toMatchObject({
      summary: `no keychain at ${KEYCHAIN}`,
      fix: { action: "run-setup", text: "pnpm stack:setup" },
    })
    m.deps.env = { ...m.deps.env, EIDO_GATE_KEYCHAIN_PATH: "" }
    expect((await only(m, "keychain"))[0]).toMatchObject({
      summary: "EIDO_GATE_KEYCHAIN_PATH is not set",
      fix: { action: "run-setup", text: "pnpm stack:setup" },
    })
  })

  it("fails a keychain that is not a file, has the wrong mode or is locked", async () => {
    const m = machine()
    m.stats.set(KEYCHAIN, { isFile: false, mode: 0o40700, size: 0 })
    expect((await only(m, "keychain"))[0]?.fix?.action).toBe(
      "use-keychain-file"
    )
    m.stats.set(KEYCHAIN, { isFile: true, mode: 0o100644, size: 1 })
    expect((await only(m, "keychain"))[0]).toMatchObject({
      summary: `${KEYCHAIN} has mode 0644, not 0600`,
      fix: { action: "chmod-keychain", text: `chmod 600 '${KEYCHAIN}'` },
    })
    m.stats.set(KEYCHAIN, { isFile: true, mode: 0o100600, size: 1 })
    m.commands.set(`security show-keychain-info ${KEYCHAIN}`, {
      code: 36,
      stdout: "",
      stderr: "User interaction is not allowed.",
    })
    expect((await only(m, "keychain"))[0]).toMatchObject({
      summary: `${KEYCHAIN} is locked or unreadable`,
      fix: {
        action: "unlock-keychain",
        text: `security unlock-keychain '${KEYCHAIN}'`,
      },
    })
  })

  it("warns, not fails, without a VAPID subject or Gmail client ids", async () => {
    const m = machine()
    m.deps.env = { EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN }
    const checks = await runDoctor(m.deps, full)
    expect(checks.filter((c) => c.id === "push" || c.id === "gmail")).toEqual([
      {
        id: "push",
        platforms: ["darwin", "win32", "linux"],
        status: "warn",
        summary: "EIDO_PUSH_VAPID_SUBJECT is not set, so push stays off",
        fix: { action: "run-setup", text: "pnpm stack:setup" },
      },
      {
        id: "gmail",
        platforms: ["darwin", "win32", "linux"],
        status: "warn",
        summary:
          "EIDO_GMAIL_CLIENT_ID and EIDO_GMAIL_READ_CLIENT_ID are not set, so Gmail cannot connect",
        fix: { action: "run-setup", text: "pnpm stack:setup" },
      },
    ])
    expect(checks.filter((c) => c.status === "fail")).toEqual([])
  })

  it("fails a wrong llama build, a missing model and a wrong hash", async () => {
    const m = machine()
    m.commands.set(
      `${LLAMA_BIN} --version`,
      ok("", "version: 0.5.0-dev (build 9000, commit abcdef123)")
    )
    expect((await only(m, "llama-pin"))[0]).toMatchObject({
      summary:
        "llama-server build mismatch: expected b11149 (d2e54583c), actual b9000 (abcdef123)",
      fix: { action: "install-llama-build" },
    })
    m.commands.set(
      `${LLAMA_BIN} --version`,
      ok("", "version: 0.5.0-dev (build 11149, commit d2e54583c)")
    )
    m.stats.delete(MODEL)
    const download = {
      action: "download-model",
      text: `curl -L --fail -o '${MODEL}' 'https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/d1c082be9cf3c8a514acf63b8761f4b41935842e/gemma-4-26B_q4_0-it.gguf'`,
    }
    expect((await only(m, "llama-pin"))[0]?.fix).toEqual(download)
    m.stats.set(MODEL, { isFile: true, mode: 0o100644, size: MODEL_SIZE })
    m.deps.sha256 = () => Promise.resolve("0".repeat(64))
    expect((await only(m, "llama-pin"))[0]).toMatchObject({
      summary: `${MODEL}: sha256 mismatch: expected ${MODEL_SHA}, actual ${"0".repeat(64)}`,
      fix: download,
    })
  })

  it("fails a wrong model size in quick mode without hashing", async () => {
    const m = machine()
    m.stats.set(MODEL, { isFile: true, mode: 0o100644, size: 10 })
    const [check] = await only(m, "llama-pin", { serve: true, quick: true })
    expect(check?.summary).toBe(
      `${MODEL}: size mismatch: expected ${MODEL_SIZE} bytes, actual 10`
    )
    expect(m.hashed()).toBe(0)
  })

  it("fails when llama-server does not answer /health on EIDO_LLAMA_PORT", async () => {
    const m = machine()
    m.health.status = undefined
    expect(await only(m, "llama-health")).toEqual([
      {
        id: "llama-health",
        platforms: ["darwin", "win32", "linux"],
        status: "fail",
        summary: "http://127.0.0.1:8080/health does not answer",
        fix: {
          action: "start-llama",
          text: "pnpm --filter @eido/infra llama install",
        },
      },
    ])
    m.deps.env = { ...m.deps.env, EIDO_LLAMA_PORT: "8090" }
    m.health.status = 200
    expect((await only(m, "llama-health"))[0]?.summary).toBe(
      "http://127.0.0.1:8090/health does not answer"
    )
  })

  it("checks the active profile: EIDO_LLAMA_MODEL from the env or stack.env, or a user profile", async () => {
    const m = machine()
    const QWEN =
      "/home/u/Library/Application Support/eido-dev/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
    m.deps.env = { ...m.deps.env, EIDO_LLAMA_MODEL: "qwen3.6-35b-a3b" }
    expect((await only(m, "llama-pin"))[0]).toMatchObject({
      status: "fail",
      summary: `no model file at ${QWEN}`,
      fix: {
        action: "download-model",
        text: `curl -L --fail -o '${QWEN}' 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/a483e9e6cbd595906af30beda3187c2663a1118c/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'`,
      },
    })
    m.stats.set(QWEN, { isFile: true, mode: 0o100644, size: 22134528992 })
    expect(
      (await only(m, "llama-pin", { serve: true, quick: true }))[0]?.summary
    ).toBe("b11149 and profile qwen3.6-35b-a3b match the pin (size only)")

    m.files.set(
      "/home/u/Library/Application Support/eido-dev/profiles.lock",
      [
        "[profile mine]",
        "model: o/r",
        "quantization: Q8_0",
        "path: /blobs/m.gguf",
        "size: 9",
        `sha256: ${"c".repeat(64)}`,
        "",
      ].join("\n")
    )
    m.deps.env = { ...m.deps.env, EIDO_LLAMA_MODEL: "mine" }
    expect((await only(m, "llama-pin"))[0]).toMatchObject({
      summary: "no model file at /blobs/m.gguf",
      fix: {
        action: "fix-settings",
        text: "point profile mine at an existing GGUF, or run: pnpm --filter @eido/infra llama use gemma-4-26b-a4b",
      },
    })
  })

  it("fails an unknown EIDO_LLAMA_MODEL, naming the profiles", async () => {
    const m = machine()
    m.deps.env = { ...m.deps.env, EIDO_LLAMA_MODEL: "nope" }
    expect((await only(m, "llama-pin"))[0]?.summary).toBe(
      'unknown model profile "nope"; the profiles are gemma-4-26b-a4b, qwen3.6-35b-a3b, gpt-oss-20b'
    )
  })

  it("fails an unreadable model.lock", async () => {
    const m = machine()
    m.files.set("/repo/infra/model.lock", "nope")
    expect((await only(m, "llama-pin"))[0]?.fix).toEqual({
      action: "fix-settings",
      text: "git checkout infra/model.lock",
    })
  })

  it("reports a port held by the running stack as ok, and anything else as a fail", async () => {
    const m = machine()
    m.files.set(
      `${RUN}/gate.pid`,
      JSON.stringify({
        name: "gate",
        pid: 700,
        marker: "src/main.ts",
        mode: "prod",
      })
    )
    m.listeners.set(8788, "p701\ncnode\n")
    m.groups.set(701, 700)
    m.listeners.set(3000, "p5695\ncnode\n")
    m.groups.set(5695, 5695)
    expect((await only(m, "ports")).map((c) => [c.status, c.summary])).toEqual([
      ["ok", "8788 (gate) is held by the running stack (pid 700)"],
      ["ok", "8789 (core) is free"],
      ["fail", "3000 (web) is in use by pid 5695 (node)"],
    ])
    expect((await only(m, "ports"))[2]?.fix).toEqual({
      action: "free-port",
      text: "kill 5695, or set EIDO_WEB_PORT in stack.env",
    })
  })

  it("reports a stack setting the config refuses", async () => {
    const m = machine()
    m.deps.env = { ...m.deps.env, EIDO_WEB_PORT: "8788" }
    expect((await only(m, "stack-config"))[0]).toMatchObject({
      status: "fail",
      summary:
        "EIDO_WEB_PORT, EIDO_CORE_PORT and EIDO_GATE_PHONE_PORT must differ",
      fix: { action: "fix-settings" },
    })
  })
})

const WIN_HOME = "C:\\Users\\s"
const WIN_LOCAL = "C:\\Users\\s\\AppData\\Local"
const WIN_STACK = `${WIN_LOCAL}\\eido-dev`
const WIN_VAULT = `${WIN_STACK}\\gate\\vault.json`
const WIN_REPO = "C:\\repo"
const WIN_BIN = `${WIN_STACK}\\llama.cpp\\b11149\\llama-server.exe`
const WIN_MODEL = `${WIN_STACK}\\models\\gemma-4-26B_q4_0-it.gguf`

/** The healthy Mac moved to Windows: repo paths, the dev vault, llama-server.exe and netstat. */
function windows() {
  const m = machine()
  m.deps.platform = "win32"
  m.deps.home = WIN_HOME
  m.deps.repoRoot = WIN_REPO
  m.deps.env = {
    LOCALAPPDATA: WIN_LOCAL,
    EIDO_DEV_VAULT: "1",
    EIDO_GATE_VAULT_FILE: WIN_VAULT,
    EIDO_PUSH_VAPID_SUBJECT: "mailto:owner@example.invalid",
    EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
    EIDO_GMAIL_READ_CLIENT_ID: "read.example.invalid",
  }
  for (const [path, text] of [...m.files]) {
    m.files.delete(path)
    m.files.set(
      WIN_REPO + path.slice("/repo".length).replaceAll("/", "\\"),
      text
    )
  }
  m.stats.clear()
  m.stats.set(WIN_MODEL, { isFile: true, mode: 0o100666, size: MODEL_SIZE })
  m.commands.set(
    `${WIN_BIN} --version`,
    ok("", "version: 0.5.0-dev (build 11149, commit d2e54583c)")
  )
  return m
}

describe("runDoctor on Windows", () => {
  it("runs the vault and settings notes instead of the keychain, with no failures", async () => {
    const m = windows()
    const checks = await runDoctor(m.deps, full)
    expect(checks.filter((c) => c.status === "fail")).toEqual([])
    expect(checks.map((c) => c.id)).toEqual([
      "node",
      "dependencies",
      "settings",
      "tailscale",
      "web-env",
      "vault",
      "push",
      "llama-pin",
      "llama-health",
      "gmail",
      "ports",
      "ports",
      "ports",
    ])
    expect(m.calls.some((line) => line.startsWith("security"))).toBe(false)
    expect(m.calls).toContain("netstat -ano -p TCP")
    expect(m.calls.some((line) => line.startsWith("lsof"))).toBe(false)
  })

  it("warns that stack.env permissions are not checked, citing #455", async () => {
    expect(await only(windows(), "settings")).toEqual([
      {
        id: "settings",
        platforms: ["win32"],
        status: "warn",
        summary:
          "stack.env permissions are not checked on Windows; the ACL check is part of #455",
      },
    ])
  })

  it("accepts the dev file vault with a #455 warning, and fails with no vault", async () => {
    const m = windows()
    expect(await only(m, "vault")).toEqual([
      {
        id: "vault",
        platforms: ["win32", "linux"],
        status: "warn",
        summary: `development file vault at ${WIN_VAULT}; a production vault on this platform is not built yet (#455)`,
      },
    ])
    m.deps.env = { ...m.deps.env, EIDO_DEV_VAULT: "" }
    expect((await only(m, "vault"))[0]).toMatchObject({
      status: "fail",
      summary: "no gate vault: set EIDO_DEV_VAULT=1 with EIDO_GATE_VAULT_FILE",
      fix: { action: "run-setup", text: "pnpm stack:setup" },
    })
  })

  it("gives Windows fixes for node, Tailscale and .env.local", async () => {
    const m = windows()
    m.deps.nodeVersion = "v22.9.0"
    m.commands.set("tailscale status --json", {
      code: 1,
      stdout: "",
      stderr: "not running",
    })
    m.files.delete(`${WIN_REPO}\\apps\\web\\.env.local`)
    const fixes = (await runDoctor(m.deps, full))
      .filter((c) => c.status === "fail")
      .map((c) => [c.id, c.fix?.text])
    expect(fixes).toEqual(
      expect.arrayContaining([
        ["node", "winget install OpenJS.NodeJS"],
        ["tailscale", "Start-Service Tailscale"],
        ["web-env", "copy apps\\web\\.env.example apps\\web\\.env.local"],
      ])
    )
  })

  it("finds llama-server.exe under the stack dir and quotes fixes for Windows", async () => {
    const m = windows()
    m.commands.delete(`${WIN_BIN} --version`)
    expect((await only(m, "llama-pin"))[0]?.fix?.text).toBe(
      `install llama.cpp b11149 at ${WIN_BIN}: infra/llama-server.md, "Install the build and a model"`
    )
    m.commands.set(
      `${WIN_BIN} --version`,
      ok("", "version: 0.5.0-dev (build 11149, commit d2e54583c)")
    )
    m.stats.clear()
    expect((await only(m, "llama-pin"))[0]?.fix?.text).toMatch(
      new RegExp(
        `^curl\\.exe -L --fail -o "${WIN_MODEL.replaceAll("\\", "\\\\")}" "https://`
      )
    )
  })

  it("gives the llama-server command itself as the start fix", async () => {
    const m = windows()
    m.health.status = undefined
    expect((await only(m, "llama-health"))[0]?.fix?.text).toMatch(
      new RegExp(
        `^"${WIN_BIN.replaceAll("\\", "\\\\")}" -m "${WIN_MODEL.replaceAll("\\", "\\\\")}" --jinja --host 127\\.0\\.0\\.1 --port 8080 `
      )
    )
  })

  it("honours EIDO_LLAMA_SERVER_BIN and EIDO_MODEL_DIR", async () => {
    const m = windows()
    m.deps.env = {
      ...m.deps.env,
      EIDO_LLAMA_SERVER_BIN: "D:\\llama\\llama-server.exe",
      EIDO_MODEL_DIR: "D:\\models",
    }
    m.stats.clear()
    await only(m, "llama-pin")
    expect(m.calls).toContain("D:\\llama\\llama-server.exe --version")
  })

  it("matches a port's listener pid against the pid file and fixes with taskkill", async () => {
    const m = windows()
    m.files.set(
      `${WIN_STACK}\\run\\gate.pid`,
      JSON.stringify({
        name: "gate",
        pid: 700,
        marker: "src/main.ts",
        mode: "prod",
      })
    )
    m.netstat.stdout = [
      "  TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    700",
      "  TCP    0.0.0.0:3000      0.0.0.0:0    LISTENING    4120",
    ].join("\r\n")
    const ports = await only(m, "ports")
    expect(ports.map((c) => [c.status, c.summary])).toEqual([
      ["ok", "8788 (gate) is held by the running stack (pid 700)"],
      ["ok", "8789 (core) is free"],
      ["fail", "3000 (web) is in use by pid 4120"],
    ])
    expect(ports[2]?.fix?.text).toBe(
      "taskkill /PID 4120, or set EIDO_WEB_PORT in stack.env"
    )
  })
})

describe("runDoctor on Linux", () => {
  it("starts tailscaled with systemctl and keeps POSIX paths", async () => {
    const m = machine()
    m.deps.platform = "linux"
    m.deps.env = {
      EIDO_DEV_VAULT: "1",
      EIDO_GATE_VAULT_FILE: "/home/u/.local/share/eido-dev/gate/vault.json",
    }
    m.commands.set("tailscale status --json", {
      code: 1,
      stdout: "",
      stderr: "down",
    })
    const checks = await runDoctor(m.deps, full)
    expect(checks.find((c) => c.id === "tailscale")?.fix?.text).toBe(
      "sudo systemctl start tailscaled"
    )
    expect(checks.map((c) => c.id)).not.toContain("settings")
    expect(checks.find((c) => c.id === "vault")?.status).toBe("warn")
    expect(m.calls).toContain(
      "/home/u/.local/share/eido-dev/llama.cpp/b11149/llama-server --version"
    )
  })
})

describe("quote and defaultVaultFile", () => {
  it("quotes for POSIX shells and for Windows", () => {
    expect(quote("it's")).toBe(`'it'\\''s'`)
    expect(quote('a "b"', "win32")).toBe('"a ""b"""')
  })

  it("puts the dev vault under the platform's stack dir", () => {
    expect(
      defaultVaultFile("win32", { LOCALAPPDATA: WIN_LOCAL }, WIN_HOME)
    ).toBe(WIN_VAULT)
  })
})

describe("formatCheck", () => {
  it("prints the status and summary, and the fix under a warn or fail", () => {
    expect(
      formatCheck({
        id: "push",
        platforms: ["darwin"],
        status: "warn",
        summary: "off",
        fix: { action: "run-setup", text: "pnpm stack:setup" },
      })
    ).toEqual(["WARN push: off", "     fix: pnpm stack:setup"])
    expect(
      formatCheck({
        id: "vault",
        platforms: ["win32"],
        status: "warn",
        summary: "dev vault",
      })
    ).toEqual(["WARN vault: dev vault"])
    expect(
      formatCheck({
        id: "node",
        platforms: ["darwin"],
        status: "ok",
        summary: "v24",
      })
    ).toEqual(["OK   node: v24"])
  })
})
