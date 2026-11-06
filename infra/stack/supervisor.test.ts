import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  validateStackDoctorReport,
  validateStackError,
  validateStackJobStatus,
  validateStackModelList,
  validateStackSettings,
} from "@eido/schemas"

import {
  OK,
  OSS,
  OSS_SHA,
  OSS_SIZE,
  PLIST,
  PRINT,
  QWEN,
  QWEN_PASS,
  RECORD,
  SETTINGS as LLAMA_SETTINGS,
  harness,
} from "../llama/test-support.ts"
import { main } from "./cli.ts"
import {
  createSupervisor,
  supervisorSocketPath,
  type SupervisorDeps,
} from "./supervisor.ts"
import { SETTINGS, STACK, world } from "./test-support.ts"

const RUNNING = { code: 0, stdout: "\tstate = running\n", stderr: "" }
const WAITING = { code: 0, stdout: "\tstate = waiting\n", stderr: "" }
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

function setup(
  options: {
    stack?: Parameters<typeof world>[0]
    llama?: Parameters<typeof harness>[0]
    uid?: number | null
  } = {}
) {
  const w = world(options.stack)
  const h = harness(options.llama)
  const written: { path: string; text: string }[] = []
  const log: string[] = []
  const deps: SupervisorDeps = {
    stack: w.deps,
    llama: h.deps,
    uid: options.uid === null ? undefined : (options.uid ?? 501),
    writeSettings: (path, text) => {
      written.push({ path, text })
      w.files.set(path, text)
      h.files[path] = text
    },
    log: (line) => log.push(line),
  }
  return { w, h, written, log, supervisor: createSupervisor(deps) }
}

const body = (value: unknown) => JSON.stringify(value)

function processOf(reply: { body: unknown }, name: string) {
  const checked = validateStackJobStatus(reply.body)
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value.processes.find((p) => p.name === name)
}

function errorOf(reply: { body: unknown }) {
  const checked = validateStackError(reply.body)
  if (!checked.ok) throw new Error(checked.errors.join("; "))
  return checked.value
}

describe("supervisorSocketPath", () => {
  it("sits in the stack's run directory", () => {
    const { w } = setup()
    expect(supervisorSocketPath(w.deps)).toBe(`${STACK}/run/supervisor.sock`)
  })
})

describe("routes", () => {
  it("answers 404 for any other route or method", async () => {
    const { supervisor } = setup()
    for (const [method, path] of [
      ["GET", "/"],
      ["DELETE", "/settings"],
      ["GET", "/jobs/start"],
      ["POST", "/vault"],
    ] as const) {
      const reply = await supervisor.handle(method, path, "")
      expect(reply.status).toBe(404)
      expect(errorOf(reply).error).toBe("not_found")
    }
  })

  it("refuses a body that is not JSON or fails its schema", async () => {
    const { supervisor } = setup()
    const notJson = await supervisor.handle("POST", "/jobs/start", "{")
    expect(notJson.status).toBe(400)
    expect(errorOf(notJson).message).toBe("the body is not JSON")
    const gate = await supervisor.handle(
      "POST",
      "/jobs/stop",
      body({ names: ["gate"] })
    )
    expect(gate.status).toBe(400)
    expect(errorOf(gate).error).toBe("invalid_body")
  })

  it("answers 500 when a route throws", async () => {
    const { supervisor, h, log } = setup()
    h.deps.readText = () => {
      throw new Error("disk gone")
    }
    const reply = await supervisor.handle("GET", "/models", "")
    expect(reply).toEqual({
      status: 500,
      body: { error: "failed", message: "disk gone" },
    })
    expect(log).toEqual(["supervisor | GET /models failed: disk gone"])
  })
})

describe("GET /jobs", () => {
  it("reports gate, core and web from their pid files, and llama from launchd", async () => {
    const { w, supervisor } = setup({ llama: { runs: { [PRINT]: RUNNING } } })
    expect(await main(["dev", "--background"], w.deps)).toBe(0)
    const reply = await supervisor.handle("GET", "/jobs", "")
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({
      processes: [
        { name: "gate", state: "running", controllable: false },
        { name: "core", state: "running", controllable: true },
        { name: "web", state: "running", controllable: false },
        { name: "llama", state: "running", controllable: true },
      ],
      tasks: [],
    })
  })

  it("reports llama stopped when loaded but not running, or installed but not loaded", async () => {
    const loaded = setup({ llama: { runs: { [PRINT]: WAITING } } })
    expect(
      processOf(await loaded.supervisor.handle("GET", "/jobs", ""), "llama")
        ?.state
    ).toBe("stopped")
    const installed = setup({ llama: { files: { [PLIST]: "" } } })
    expect(
      processOf(await installed.supervisor.handle("GET", "/jobs", ""), "llama")
        ?.state
    ).toBe("stopped")
  })

  it("reports llama unavailable when not installed, or off macOS", async () => {
    const missing = setup()
    expect(
      processOf(await missing.supervisor.handle("GET", "/jobs", ""), "llama")
    ).toEqual({
      name: "llama",
      state: "unavailable",
      controllable: true,
      message:
        "com.eido.llama-server is not installed; run pnpm --filter @eido/infra llama install",
    })
    const noUid = setup({ uid: null })
    expect(
      processOf(await noUid.supervisor.handle("GET", "/jobs", ""), "llama")
        ?.message
    ).toBe("llama-server runs under launchd, on macOS only so far (#629)")
  })
})

describe("POST /jobs", () => {
  it("stops core and starts it again on the gate's mode, after replying 202", async () => {
    const { w, supervisor } = setup()
    expect(await main(["prod", "--background"], w.deps)).toBe(0)
    const before = w.procs.find((p) => p.spec.name === "core")

    const stop = await supervisor.handle(
      "POST",
      "/jobs/stop",
      body({ names: ["core"] })
    )
    expect(stop.status).toBe(202)
    expect(processOf(stop, "core")?.state).toBe("stopping")
    await supervisor.settled()
    expect(before?.alive).toBe(false)
    expect(
      processOf(await supervisor.handle("GET", "/jobs", ""), "core")?.state
    ).toBe("stopped")

    const start = await supervisor.handle(
      "POST",
      "/jobs/start",
      body({ names: ["core"] })
    )
    expect(start.status).toBe(202)
    expect(processOf(start, "core")?.state).toBe("starting")
    await supervisor.settled()
    const cores = w.procs.filter((p) => p.spec.name === "core")
    expect(cores).toHaveLength(2)
    expect(cores[1]?.alive).toBe(true)
    // The gate runs in prod, so core is started without --watch.
    expect(cores[1]?.spec.args).not.toContain("--watch")
    expect(w.procs.filter((p) => p.spec.name === "gate")).toHaveLength(1)
    expect(
      processOf(await supervisor.handle("GET", "/jobs", ""), "core")?.state
    ).toBe("running")
  })

  it("restarts core into a new process and leaves the gate and web alone", async () => {
    const { w, supervisor } = setup()
    expect(await main(["dev", "--background"], w.deps)).toBe(0)
    await supervisor.handle("POST", "/jobs/restart", body({ names: ["core"] }))
    await supervisor.settled()
    expect(w.procs.map((p) => [p.spec.name, p.alive])).toEqual([
      ["gate", true],
      ["core", false],
      ["web", true],
      ["core", true],
    ])
  })

  it("refuses to start core while the gate is not running", async () => {
    const { w, supervisor } = setup()
    const reply = await supervisor.handle(
      "POST",
      "/jobs/start",
      body({ names: ["core"] })
    )
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toEqual({
      error: "stack_not_running",
      message:
        "the gate is not running; start the stack with pnpm stack:prod --background",
    })
    expect(w.procs).toEqual([])
  })

  it("refuses a second operation while one runs", async () => {
    const { w, supervisor } = setup()
    expect(await main(["dev", "--background"], w.deps)).toBe(0)
    const first = supervisor.handle(
      "POST",
      "/jobs/stop",
      body({ names: ["core"] })
    )
    const second = await supervisor.handle(
      "POST",
      "/jobs/stop",
      body({ names: ["core"] })
    )
    expect(second.status).toBe(409)
    expect(errorOf(second).error).toBe("busy")
    expect((await first).status).toBe(202)
    await supervisor.settled()
  })

  it("keeps the last failure on the process until the next operation", async () => {
    const { w, supervisor, log } = setup()
    expect(await main(["dev", "--background"], w.deps)).toBe(0)
    await supervisor.handle("POST", "/jobs/stop", body({ names: ["core"] }))
    await supervisor.settled()
    // The gate dies between the check and the start.
    const gate = w.procs.find((p) => p.spec.name === "gate")
    const start = supervisor.handle(
      "POST",
      "/jobs/start",
      body({ names: ["core"] })
    )
    gate?.exit(null)
    await start
    await supervisor.settled()
    const core = processOf(await supervisor.handle("GET", "/jobs", ""), "core")
    expect(core).toEqual({
      name: "core",
      state: "stopped",
      controllable: true,
      message: "start failed: the gate is not running",
    })
    expect(log).toContain(
      "supervisor | core start failed: the gate is not running"
    )
  })

  it("bootstraps llama when not loaded, and kickstarts it when loaded but stopped", async () => {
    const bootstrap = `launchctl bootstrap gui/501 ${PLIST}`
    const fresh = setup({
      llama: { files: { [PLIST]: "" }, runs: { [bootstrap]: OK } },
    })
    const reply = await fresh.supervisor.handle(
      "POST",
      "/jobs/start",
      body({ names: ["llama"] })
    )
    expect(reply.status).toBe(202)
    await fresh.supervisor.settled()
    expect(fresh.h.ran).toContain(bootstrap)

    const kick = "launchctl kickstart -k gui/501/com.eido.llama-server"
    const loaded = setup({
      llama: { runs: { [PRINT]: WAITING, [kick]: OK } },
    })
    await loaded.supervisor.handle(
      "POST",
      "/jobs/start",
      body({ names: ["llama"] })
    )
    await loaded.supervisor.settled()
    expect(loaded.h.ran).toContain(kick)
  })

  it("restarts llama with kickstart -k and stops it with bootout", async () => {
    const kill = "launchctl kickstart -k gui/501/com.eido.llama-server"
    const bootout = "launchctl bootout gui/501/com.eido.llama-server"
    const { h, supervisor } = setup({
      llama: { runs: { [PRINT]: RUNNING, [kill]: OK, [bootout]: OK } },
    })
    await supervisor.handle("POST", "/jobs/restart", body({ names: ["llama"] }))
    await supervisor.settled()
    expect(h.ran).toContain(kill)
    await supervisor.handle("POST", "/jobs/stop", body({ names: ["llama"] }))
    await supervisor.settled()
    expect(h.ran).toContain(bootout)
  })

  it("reports launchctl's refusal as the llama failure", async () => {
    const { supervisor } = setup({
      llama: {
        runs: {
          [PRINT]: RUNNING,
          "launchctl bootout gui/501/com.eido.llama-server": {
            code: 5,
            stdout: "",
            stderr: "Boot-out failed: 5: Input/output error\n",
          },
        },
      },
    })
    await supervisor.handle("POST", "/jobs/stop", body({ names: ["llama"] }))
    await supervisor.settled()
    expect(
      processOf(await supervisor.handle("GET", "/jobs", ""), "llama")?.message
    ).toBe(
      "stop failed: launchctl bootout: Boot-out failed: 5: Input/output error"
    )
  })

  it("refuses to start llama when it is not installed", async () => {
    const { supervisor } = setup()
    const reply = await supervisor.handle(
      "POST",
      "/jobs/start",
      body({ names: ["llama"] })
    )
    expect(reply.status).toBe(409)
    expect(errorOf(reply).error).toBe("unavailable")
  })
})

describe("models", () => {
  it("lists the profiles with their disk state and the active one", async () => {
    const { supervisor } = setup()
    const reply = await supervisor.handle("GET", "/models", "")
    expect(reply.status).toBe(200)
    const checked = validateStackModelList(reply.body)
    if (!checked.ok) throw new Error(checked.errors.join("; "))
    expect(checked.value.active).toBe("gemma-4-26b-a4b")
    const byId = Object.fromEntries(
      checked.value.profiles.map((p) => [p.id, p])
    )
    expect(byId["gemma-4-26b-a4b"]).toMatchObject({
      disk: "present",
      isDefault: true,
      origin: "lock",
    })
    expect(byId["gpt-oss-20b"]).toMatchObject({
      disk: "missing",
      isDefault: false,
      sizeBytes: OSS_SIZE,
    })
  })

  it("makes a profile active through the atomic settings writer", async () => {
    const { supervisor, written, h } = setup({
      llama: { files: { [QWEN]: "", [RECORD]: QWEN_PASS } },
    })
    const reply = await supervisor.handle(
      "POST",
      "/models/use",
      body({ id: "qwen3.6-35b-a3b" })
    )
    expect(reply.status).toBe(200)
    expect(written).toEqual([
      {
        path: LLAMA_SETTINGS,
        text: "# Written by the Eido stack (pnpm stack:setup). Non-secret settings only.\nEIDO_LLAMA_MODEL=qwen3.6-35b-a3b\n",
      },
    ])
    // The CLI's own non-atomic writer is never used.
    expect(h.privately).toEqual([])
    const checked = validateStackModelList(reply.body)
    expect(checked.ok && checked.value.active).toBe("qwen3.6-35b-a3b")
  })

  it("answers 404 for an unknown profile", async () => {
    const { supervisor } = setup()
    for (const path of ["/models/use", "/models/fetch"]) {
      const reply = await supervisor.handle("POST", path, body({ id: "nope" }))
      expect(reply.status).toBe(404)
      expect(errorOf(reply).message).toBe("no model profile nope")
    }
  })

  it("passes on the llama CLI's failure for use", async () => {
    const { supervisor } = setup({ llama: { settingsMode: 0o100644 } })
    const reply = await supervisor.handle(
      "POST",
      "/models/use",
      body({ id: "gpt-oss-20b" })
    )
    expect(reply.status).toBe(409)
    expect(errorOf(reply).error).toBe("failed")
  })

  it("downloads a model as a task with its progress, one at a time", async () => {
    const { supervisor, h } = setup()
    // The fake's sizes and hashes are keyed by the final path; the download is checked as .partial.
    h.deps.probe = {
      ...h.deps.probe,
      size: (path) => Promise.resolve(path in h.files ? OSS_SIZE : undefined),
      sha256: () => Promise.resolve(OSS_SHA),
    }
    const reply = await supervisor.handle(
      "POST",
      "/models/fetch",
      body({ id: "gpt-oss-20b" })
    )
    expect(reply.status).toBe(202)
    const busy = await supervisor.handle(
      "POST",
      "/models/fetch",
      body({ id: "gpt-oss-20b" })
    )
    expect(busy.status).toBe(409)
    expect(errorOf(busy).error).toBe("busy")
    await supervisor.settled()
    expect(h.files[OSS]).toBe("")
    const jobs = validateStackJobStatus(
      (await supervisor.handle("GET", "/jobs", "")).body
    )
    if (!jobs.ok) throw new Error(jobs.errors.join("; "))
    expect(jobs.value.tasks).toEqual([
      {
        id: "task-1",
        kind: "model.fetch",
        profile: "gpt-oss-20b",
        state: "succeeded",
        startedAt: "1970-01-01T00:00:00.000Z",
        receivedBytes: OSS_SIZE,
        totalBytes: OSS_SIZE,
      },
    ])
  })

  it("reports a running download's partial size, and a failed one's reason", async () => {
    const { supervisor, h } = setup()
    let fail: (error: Error) => void = () => {}
    h.deps.download = (_url, dest) => {
      h.files[dest] = ""
      return new Promise<void>((_resolve, reject) => {
        fail = reject
      })
    }
    await supervisor.handle(
      "POST",
      "/models/fetch",
      body({ id: "gpt-oss-20b" })
    )
    const running = validateStackJobStatus(
      (await supervisor.handle("GET", "/jobs", "")).body
    )
    expect(running.ok && running.value.tasks[0]).toMatchObject({
      state: "running",
      receivedBytes: 10,
    })
    fail(new Error("connection reset"))
    await supervisor.settled()
    const failed = validateStackJobStatus(
      (await supervisor.handle("GET", "/jobs", "")).body
    )
    expect(failed.ok && failed.value.tasks[0]?.state).toBe("failed")
    expect(failed.ok && failed.value.tasks[0]?.message).toMatch(
      /connection reset/
    )
  })

  it("keeps at most 32 tasks", async () => {
    const { supervisor } = setup()
    for (let i = 0; i < 33; i++) {
      await supervisor.handle(
        "POST",
        "/models/fetch",
        body({ id: "gpt-oss-20b" })
      )
      await supervisor.settled()
    }
    const jobs = validateStackJobStatus(
      (await supervisor.handle("GET", "/jobs", "")).body
    )
    if (!jobs.ok) throw new Error(jobs.errors.join("; "))
    expect(jobs.value.tasks[0]?.id).toBe("task-2")
    expect(jobs.value.tasks.at(-1)?.id).toBe("task-33")
  })
})

describe("settings", () => {
  it("reads stack.env with its hash, and null when there is no file", async () => {
    const text = "EIDO_LLAMA_MODEL=gpt-oss-20b\n"
    const present = setup({ stack: { settings: { text } } })
    const reply = await present.supervisor.handle("GET", "/settings", "")
    expect(reply).toEqual({
      status: 200,
      body: {
        sha256: sha(text),
        settings: { EIDO_LLAMA_MODEL: "gpt-oss-20b" },
      },
    })
    expect(validateStackSettings(reply.body).ok).toBe(true)
    const absent = setup()
    expect(
      (await absent.supervisor.handle("GET", "/settings", "")).body
    ).toEqual({ sha256: null, settings: {} })
  })

  it("writes a change against the hash it was read with; an empty value removes a key", async () => {
    const text = "EIDO_LLAMA_MODEL=gpt-oss-20b\n"
    const { supervisor, written } = setup({ stack: { settings: { text } } })
    const reply = await supervisor.handle(
      "POST",
      "/settings",
      body({
        expectedSha256: sha(text),
        set: { EIDO_LLAMA_MODEL: "", EIDO_WEB_PORT: "9443" },
      })
    )
    const next =
      "# Written by the Eido stack (pnpm stack:setup). Non-secret settings only.\nEIDO_WEB_PORT=9443\n"
    expect(written).toEqual([{ path: SETTINGS, text: next }])
    expect(reply).toEqual({
      status: 200,
      body: { sha256: sha(next), settings: { EIDO_WEB_PORT: "9443" } },
    })
  })

  it("refuses a stale hash and an invalid value, and writes nothing", async () => {
    const text = "EIDO_LLAMA_MODEL=gpt-oss-20b\n"
    const { supervisor, written } = setup({ stack: { settings: { text } } })
    const stale = await supervisor.handle(
      "POST",
      "/settings",
      body({ expectedSha256: null, set: {} })
    )
    expect(stale.status).toBe(409)
    expect(errorOf(stale).error).toBe("stale_settings")
    const bad = await supervisor.handle(
      "POST",
      "/settings",
      body({ expectedSha256: sha(text), set: { EIDO_WEB_PORT: "x" } })
    )
    expect(bad.status).toBe(400)
    expect(errorOf(bad).error).toBe("invalid_body")
    expect(written).toEqual([])
  })
})

describe("GET /doctor", () => {
  it("returns the quick checks in the report shape", async () => {
    const { supervisor } = setup()
    const reply = await supervisor.handle("GET", "/doctor", "")
    expect(reply.status).toBe(200)
    const checked = validateStackDoctorReport(reply.body)
    if (!checked.ok) throw new Error(checked.errors.join("; "))
    const ids = checked.value.checks.map((c) => c.id)
    expect(ids).toContain("node")
    expect(ids).toContain("keychain")
  })
})

describe("source", () => {
  it("never touches the vault, the control plane or the keychain", () => {
    for (const file of [
      "supervisor.ts",
      "supervisor-server.ts",
      "supervisor-main.ts",
    ]) {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
      expect(text).not.toMatch(
        /vault|eido-control|CONTROL_DB|gate-control|CONTROL_SOCKET|controlSocket|keychain/i
      )
    }
  })
})
