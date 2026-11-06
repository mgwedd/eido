import { describe, expect, it } from "vitest"

import {
  applyStackSettings,
  formatStackSettings,
  getStackSetting,
  parseStackSettings,
  readStackSettings,
  settingProblem,
  stackSettingsPath,
  validateSettings,
  writeStackSetting,
  type FileStat,
  type SettingsFiles,
} from "./settings.ts"

const PATH = "/home/u/Library/Application Support/eido-dev/stack.env"

function disk(initial: Record<string, { text: string; mode?: number }> = {}) {
  const texts = new Map<string, string>()
  const stats = new Map<string, FileStat>()
  const dirs: string[] = []
  for (const [path, { text, mode = 0o100600 }] of Object.entries(initial)) {
    texts.set(path, text)
    stats.set(path, { isFile: true, mode, size: text.length })
  }
  const files: SettingsFiles = {
    read: (path) => texts.get(path),
    stat: (path) => stats.get(path),
    write: (path, text) => {
      texts.set(path, text)
      stats.set(path, {
        isFile: true,
        mode: stats.get(path)?.mode ?? 0o100600,
        size: text.length,
      })
    },
    ensurePrivateDir: (path) => dirs.push(path),
  }
  return { files, texts, stats, dirs }
}

describe("stackSettingsPath", () => {
  it("lives in the stack dir, which only the environment can move", () => {
    expect(stackSettingsPath({}, "/home/u", "darwin")).toBe(PATH)
    expect(
      stackSettingsPath({ EIDO_STACK_DIR: "/srv/eido" }, "/home/u", "darwin")
    ).toBe("/srv/eido/stack.env")
  })

  it("follows the platform's stack dir", () => {
    expect(
      stackSettingsPath(
        { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" },
        "C:\\Users\\s",
        "win32"
      )
    ).toBe("C:\\Users\\s\\AppData\\Local\\eido-dev\\stack.env")
    expect(stackSettingsPath({}, "/home/u", "linux")).toBe(
      "/home/u/.local/share/eido-dev/stack.env"
    )
  })
})

describe("settingProblem", () => {
  it("names an unknown key", () => {
    expect(settingProblem("EIDO_GMAIL_CLIENT_SECRET", "x")).toBe(
      "EIDO_GMAIL_CLIENT_SECRET is not a stack setting"
    )
  })

  it("refuses EIDO_STACK_DIR, which says where the file lives", () => {
    expect(settingProblem("EIDO_STACK_DIR", "/x")).toMatch(
      /^EIDO_STACK_DIR says where stack.env lives/
    )
  })

  it("checks ports and the VAPID subject", () => {
    expect(settingProblem("EIDO_WEB_PORT", "70000")).toMatch(/EIDO_WEB_PORT/)
    expect(settingProblem("EIDO_WEB_PORT", "3001")).toBeUndefined()
    expect(settingProblem("EIDO_PUSH_VAPID_SUBJECT", "owner")).toBe(
      "EIDO_PUSH_VAPID_SUBJECT must be a mailto: address or an https: URL"
    )
    expect(
      settingProblem("EIDO_PUSH_VAPID_SUBJECT", "mailto:owner@example.invalid")
    ).toBeUndefined()
  })

  it("refuses a value it cannot write back on one line", () => {
    expect(settingProblem("EIDO_BRIDGE_USERNAME", "a\nb")).toBe(
      "EIDO_BRIDGE_USERNAME must be one line"
    )
    expect(settingProblem("EIDO_BRIDGE_USERNAME", `a'b"c`)).toBe(
      "EIDO_BRIDGE_USERNAME cannot hold both quote characters"
    )
  })

  it("accepts the llama model key written by llama use", () => {
    expect(settingProblem("EIDO_LLAMA_MODEL", "gemma-4")).toBeUndefined()
  })
})

describe("parseStackSettings", () => {
  it("reads KEY=value lines, comments and quotes", () => {
    expect(
      parseStackSettings(
        "# comment\nEIDO_GMAIL_CLIENT_ID=abc.apps.example.invalid\nEIDO_BRIDGE_SEARCH_FOLDERS='INBOX, Archive'\n"
      )
    ).toEqual({
      EIDO_GMAIL_CLIENT_ID: "abc.apps.example.invalid",
      EIDO_BRIDGE_SEARCH_FOLDERS: "INBOX, Archive",
    })
  })

  it("fails on an unknown key, naming it", () => {
    expect(() => parseStackSettings("EIDO_BRIDGE_PASSWORD=hunter2\n")).toThrow(
      "EIDO_BRIDGE_PASSWORD is not a stack setting"
    )
  })
})

describe("formatStackSettings", () => {
  it("writes allowlist order and quotes what needs it, so it parses back", () => {
    const settings = validateSettings({
      EIDO_PUSH_VAPID_SUBJECT: "mailto:owner@example.invalid",
      EIDO_GATE_KEYCHAIN_PATH:
        "/home/u/Library/Keychains/eido/eido.keychain-db",
      EIDO_BRIDGE_SEARCH_FOLDERS: "All Mail#1",
      EIDO_BRIDGE_USERNAME: "it's",
    })
    const text = formatStackSettings(settings)
    expect(text.split("\n").slice(1)).toEqual([
      "EIDO_GATE_KEYCHAIN_PATH=/home/u/Library/Keychains/eido/eido.keychain-db",
      "EIDO_PUSH_VAPID_SUBJECT=mailto:owner@example.invalid",
      'EIDO_BRIDGE_USERNAME="it\'s"',
      "EIDO_BRIDGE_SEARCH_FOLDERS='All Mail#1'",
      "",
    ])
    expect(parseStackSettings(text)).toEqual(settings)
  })
})

describe("readStackSettings", () => {
  it("is empty when there is no file", () => {
    expect(readStackSettings(disk().files, PATH, "darwin")).toEqual({})
  })

  it("refuses a file that is not mode 0600, with the fix", () => {
    const { files } = disk({
      [PATH]: { text: "EIDO_WEB_PORT=3001\n", mode: 0o100644 },
    })
    expect(() => readStackSettings(files, PATH, "darwin")).toThrow(
      `${PATH} has mode 0644, not 0600; fix with: chmod 600 '${PATH}'`
    )
  })

  it("skips the mode check on Windows, which has no mode bits (ACLs are #455)", () => {
    const { files } = disk({
      [PATH]: { text: "EIDO_WEB_PORT=3001\n", mode: 0o100666 },
    })
    expect(readStackSettings(files, PATH, "win32")).toEqual({
      EIDO_WEB_PORT: "3001",
    })
  })

  it("refuses something that is not a regular file", () => {
    const { files, stats } = disk({ [PATH]: { text: "" } })
    stats.set(PATH, { isFile: false, mode: 0o120600, size: 0 })
    expect(() => readStackSettings(files, PATH, "darwin")).toThrow(
      `${PATH} is not a regular file`
    )
  })

  it("names the file and the unknown key", () => {
    const { files } = disk({ [PATH]: { text: "EIDO_NOPE=1\n" } })
    expect(() => readStackSettings(files, PATH, "darwin")).toThrow(
      `${PATH}: EIDO_NOPE is not a stack setting`
    )
  })
})

describe("writeStackSetting", () => {
  it("sets one key and keeps the others, in a private dir", () => {
    const d = disk({ [PATH]: { text: "EIDO_WEB_PORT=3001\n" } })
    writeStackSetting(d.files, PATH, "EIDO_LLAMA_MODEL", "gemma-4", "darwin")
    expect(readStackSettings(d.files, PATH, "darwin")).toEqual({
      EIDO_WEB_PORT: "3001",
      EIDO_LLAMA_MODEL: "gemma-4",
    })
    expect(d.dirs).toEqual(["/home/u/Library/Application Support/eido-dev"])
  })

  it("removes a key set to empty", () => {
    const d = disk({ [PATH]: { text: "EIDO_WEB_PORT=3001\n" } })
    writeStackSetting(d.files, PATH, "EIDO_WEB_PORT", "", "darwin")
    expect(readStackSettings(d.files, PATH, "darwin")).toEqual({})
  })

  it("writes nothing for an invalid value", () => {
    const d = disk()
    expect(() =>
      writeStackSetting(d.files, PATH, "EIDO_CORE_PORT", "nope", "darwin")
    ).toThrow(/EIDO_CORE_PORT/)
    expect(d.texts.size).toBe(0)
  })

  it("creates the file's directory with the platform's path rules", () => {
    const d = disk()
    const path = "C:\\Users\\s\\AppData\\Local\\eido-dev\\stack.env"
    writeStackSetting(d.files, path, "EIDO_DEV_VAULT", "1", "win32")
    expect(d.dirs).toEqual(["C:\\Users\\s\\AppData\\Local\\eido-dev"])
    expect(getStackSetting(d.files, path, "EIDO_DEV_VAULT", "win32")).toBe("1")
  })
})

describe("applyStackSettings", () => {
  it("lets a variable set in the environment win over the file", () => {
    expect(
      applyStackSettings(
        { EIDO_WEB_PORT: "4000", EIDO_CORE_PORT: undefined },
        { EIDO_WEB_PORT: "3001", EIDO_CORE_PORT: "8790" }
      )
    ).toEqual({ EIDO_WEB_PORT: "4000", EIDO_CORE_PORT: "8790" })
  })
})
