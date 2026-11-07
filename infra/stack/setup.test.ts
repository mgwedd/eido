import { describe, expect, it } from "vitest"

import type { RunResult } from "./ports.ts"
import {
  parseStackSettings,
  SETTING_KEYS,
  type FileStat,
  type StackSettings,
} from "./settings.ts"
import { runSetup, type SetupDeps } from "./setup.ts"

const KEYCHAIN = "/home/u/Library/Keychains/eido/eido.keychain-db"
const PATH = "/home/u/Library/Application Support/eido-dev/stack.env"

type Interactive = {
  command: string
  args: readonly string[]
  options: unknown
}

function fake(
  options: {
    platform?: SetupDeps["platform"]
    home?: string
    env?: SetupDeps["env"]
    keychain?: "missing" | "locked" | "unlocked"
    answers?: string[]
    gitEmail?: string
    interactiveCode?: number
  } = {}
) {
  const texts = new Map<string, string>()
  const stats = new Map<string, FileStat>()
  const modes: [string, number][] = []
  const dirs: string[] = []
  const interactive: Interactive[] = []
  const questions: string[] = []
  const out: string[] = []
  const err: string[] = []
  const answers = [...(options.answers ?? [])]
  const keychain = options.keychain ?? "unlocked"
  if (keychain !== "missing")
    stats.set(KEYCHAIN, { isFile: true, mode: 0o100600, size: 1 })
  const deps: SetupDeps = {
    platform: options.platform ?? "darwin",
    env: options.env ?? {},
    home: options.home ?? "/home/u",
    exec: (command, args): Promise<RunResult> => {
      const line = [command, ...args].join(" ")
      if (line === `security show-keychain-info ${KEYCHAIN}`)
        return Promise.resolve({
          code: keychain === "locked" ? 36 : 0,
          stdout: "",
          stderr: "",
        })
      if (line === "git config user.email")
        return Promise.resolve({
          code: options.gitEmail === undefined ? 1 : 0,
          stdout: options.gitEmail === undefined ? "" : `${options.gitEmail}\n`,
          stderr: "",
        })
      return Promise.resolve({ code: 127, stdout: "", stderr: "" })
    },
    interactive: (command, args, runOptions) => {
      interactive.push({ command, args, options: runOptions })
      if (args[0] === "create-keychain")
        stats.set(KEYCHAIN, { isFile: true, mode: 0o100644, size: 1 })
      return Promise.resolve(options.interactiveCode ?? 0)
    },
    ask: (question) => {
      questions.push(question)
      return Promise.resolve(answers.shift() ?? "")
    },
    files: {
      read: (path) => texts.get(path),
      stat: (path) => stats.get(path),
      write: (path, text) => {
        texts.set(path, text)
        stats.set(path, { isFile: true, mode: 0o100600, size: text.length })
      },
      ensurePrivateDir: (path) => dirs.push(path),
      setMode: (path, mode) => modes.push([path, mode]),
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  }
  const written = (path = PATH): StackSettings =>
    parseStackSettings(texts.get(path) ?? "")
  return {
    deps,
    interactive,
    questions,
    modes,
    dirs,
    out,
    err,
    texts,
    written,
  }
}

describe("runSetup", () => {
  it("creates and unlocks the keychain with the terminal, never passing a password", async () => {
    const f = fake({ keychain: "missing" })
    expect(await runSetup(f.deps, PATH, {})).toBe(0)
    expect(f.interactive).toEqual([
      {
        command: "security",
        args: ["create-keychain", KEYCHAIN],
        options: undefined,
      },
      {
        command: "security",
        args: ["unlock-keychain", KEYCHAIN],
        options: undefined,
      },
    ])
    expect(f.dirs[0]).toBe("/home/u/Library/Keychains/eido")
    expect(f.modes).toEqual([[KEYCHAIN, 0o600]])
    expect(f.written().EIDO_GATE_KEYCHAIN_PATH).toBe(KEYCHAIN)
  })

  it("unlocks an existing locked keychain and creates nothing", async () => {
    const f = fake({ keychain: "locked" })
    await runSetup(f.deps, PATH, {})
    expect(f.interactive.map((i) => i.args)).toEqual([
      ["unlock-keychain", KEYCHAIN],
    ])
  })

  it("leaves an unlocked keychain alone", async () => {
    const f = fake()
    await runSetup(f.deps, PATH, {})
    expect(f.interactive).toEqual([])
  })

  it("stops when security fails", async () => {
    const f = fake({ keychain: "missing", interactiveCode: 1 })
    expect(await runSetup(f.deps, PATH, {})).toBe(1)
    expect(f.err).toEqual(["FAIL: security create-keychain did not finish"])
    expect(f.texts.size).toBe(0)
  })

  it("does not create a keychain at a custom path it was not asked to make", async () => {
    const f = fake({
      keychain: "missing",
      env: { EIDO_GATE_KEYCHAIN_PATH: "/elsewhere/k.keychain-db" },
    })
    expect(await runSetup(f.deps, PATH, {})).toBe(1)
    expect(f.interactive).toEqual([])
  })

  it("asks for each unset setting, offering mailto: plus the owner address", async () => {
    const f = fake({
      gitEmail: "owner@example.invalid",
      answers: ["", "send.example.invalid", "read.example.invalid"],
    })
    expect(await runSetup(f.deps, PATH, {})).toBe(0)
    expect(f.questions).toEqual([
      "EIDO_PUSH_VAPID_SUBJECT [mailto:owner@example.invalid]: ",
      "EIDO_GMAIL_CLIENT_ID: ",
      "EIDO_GMAIL_READ_CLIENT_ID: ",
    ])
    expect(f.written()).toEqual({
      EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
      EIDO_PUSH_VAPID_SUBJECT: "mailto:owner@example.invalid",
      EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
      EIDO_GMAIL_READ_CLIENT_ID: "read.example.invalid",
    })
  })

  it("skips what the environment or the file already sets, and keeps the file's keys", async () => {
    const f = fake({
      env: {
        EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
        EIDO_PUSH_VAPID_SUBJECT: "mailto:a@example.invalid",
        EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
      },
      answers: [""],
    })
    await runSetup(f.deps, PATH, {
      EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
      EIDO_WEB_PORT: "3001",
    })
    expect(f.questions).toEqual(["EIDO_GMAIL_READ_CLIENT_ID: "])
    expect(f.out).toContain("EIDO_GMAIL_READ_CLIENT_ID: left unset")
    expect(f.written()).toEqual({
      EIDO_GMAIL_CLIENT_ID: "send.example.invalid",
      EIDO_WEB_PORT: "3001",
    })
  })

  it("skips Gmail client id prompts when EIDO_GOOGLE_CLIENT_ID is set in env or stack.env", async () => {
    const f = fake({
      env: {
        EIDO_GATE_KEYCHAIN_PATH: KEYCHAIN,
        EIDO_PUSH_VAPID_SUBJECT: "mailto:a@example.invalid",
        EIDO_GOOGLE_CLIENT_ID: "google.example.invalid",
      },
      answers: [],
    })
    await runSetup(f.deps, PATH, {})
    expect(f.questions).toEqual([])
  })

  it("refuses an invalid answer and leaves the key unset", async () => {
    const f = fake({ answers: ["not-a-contact", "", ""] })
    await runSetup(f.deps, PATH, {})
    expect(f.err).toEqual([
      "EIDO_PUSH_VAPID_SUBJECT must be a mailto: address or an https: URL; left unset",
    ])
    expect(f.written()).not.toHaveProperty("EIDO_PUSH_VAPID_SUBJECT")
  })

  it("writes only allowlisted keys", async () => {
    const f = fake({
      keychain: "missing",
      gitEmail: "owner@example.invalid",
      answers: ["", "a.example.invalid", "b.example.invalid"],
    })
    await runSetup(f.deps, PATH, {})
    const keys: readonly string[] = SETTING_KEYS
    const lines = (f.texts.get(PATH) ?? "")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
    expect(lines.map((line) => line.split("=")[0])).toEqual([
      "EIDO_GATE_KEYCHAIN_PATH",
      "EIDO_PUSH_VAPID_SUBJECT",
      "EIDO_GMAIL_CLIENT_ID",
      "EIDO_GMAIL_READ_CLIENT_ID",
    ])
    expect(lines.every((line) => keys.includes(line.split("=")[0] ?? ""))).toBe(
      true
    )
  })
})

describe("runSetup off macOS", () => {
  const WIN_HOME = "C:\\Users\\s"
  const WIN_LOCAL = "C:\\Users\\s\\AppData\\Local"
  const WIN_PATH = `${WIN_LOCAL}\\eido-dev\\stack.env`
  const WIN_VAULT = `${WIN_LOCAL}\\eido-dev\\gate\\vault.json`

  it("sets the development file vault on Windows and never runs security", async () => {
    const f = fake({
      platform: "win32",
      home: WIN_HOME,
      env: { LOCALAPPDATA: WIN_LOCAL },
      answers: ["", "", ""],
    })
    expect(await runSetup(f.deps, WIN_PATH, {})).toBe(0)
    expect(f.interactive).toEqual([])
    expect(f.written(WIN_PATH)).toEqual({
      EIDO_DEV_VAULT: "1",
      EIDO_GATE_VAULT_FILE: WIN_VAULT,
    })
    expect(f.dirs).toEqual([
      `${WIN_LOCAL}\\eido-dev\\gate`,
      `${WIN_LOCAL}\\eido-dev`,
    ])
    expect(f.out).toContain(
      `vault: development file vault at ${WIN_VAULT}; a production vault on this platform is #455`
    )
  })

  it("keeps a vault file the environment already names", async () => {
    const f = fake({
      platform: "win32",
      home: WIN_HOME,
      env: {
        LOCALAPPDATA: WIN_LOCAL,
        EIDO_DEV_VAULT: "1",
        EIDO_GATE_VAULT_FILE: "D:\\vault.json",
      },
      answers: ["", "", ""],
    })
    await runSetup(f.deps, WIN_PATH, {})
    expect(f.written(WIN_PATH)).toEqual({})
    expect(f.dirs).toEqual([`${WIN_LOCAL}\\eido-dev`])
  })

  it("uses the XDG data dir on Linux", async () => {
    const path = "/home/u/.local/share/eido-dev/stack.env"
    const f = fake({ platform: "linux", answers: ["", "", ""] })
    await runSetup(f.deps, path, {})
    expect(f.written(path)).toEqual({
      EIDO_DEV_VAULT: "1",
      EIDO_GATE_VAULT_FILE: "/home/u/.local/share/eido-dev/gate/vault.json",
    })
  })
})
