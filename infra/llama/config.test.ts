import { describe, expect, it } from "vitest"

import { buildConfig, dataRoot, launchEnv, lockPathFrom } from "./config.ts"

const lock = { llamaCppBuild: "b11149" }
const mac = { os: "darwin", arch: "arm64" } as const
const windows = { os: "win32", arch: "x64" } as const
const linux = { os: "linux", arch: "x64" } as const

const fields = (config: ReturnType<typeof buildConfig>) =>
  Object.fromEntries(Object.entries(config).filter(([key]) => key !== "join"))

describe("buildConfig on macOS", () => {
  it("defaults under Application Support/eido-dev, port 8080", () => {
    expect(
      fields(buildConfig({}, "/Users/u", "/repo/infra/model.lock", lock, mac))
    ).toEqual({
      platform: "darwin-arm64",
      windows: false,
      lockPath: "/repo/infra/model.lock",
      modelDir: "/Users/u/Library/Application Support/eido-dev/models",
      binary:
        "/Users/u/Library/Application Support/eido-dev/llama.cpp/b11149/llama-server",
      buildDir:
        "/Users/u/Library/Application Support/eido-dev/llama.cpp/b11149",
      port: 8080,
      stackDir: "/Users/u/Library/Application Support/eido-dev",
      profilesPath:
        "/Users/u/Library/Application Support/eido-dev/profiles.lock",
      verifiedPath:
        "/Users/u/Library/Application Support/eido-dev/verified-profiles",
    })
  })

  it("takes overrides from the environment, ignoring blank ones", () => {
    const env = {
      EIDO_MODEL_LOCK: "/l/model.lock",
      EIDO_MODEL_DIR: " /models ",
      EIDO_LLAMA_SERVER_BIN: "",
      EIDO_LLAMA_PORT: "18091",
      EIDO_STACK_DIR: "/stack",
    }
    expect(
      fields(buildConfig(env, "/Users/u", "/repo/infra/model.lock", lock, mac))
    ).toMatchObject({
      lockPath: "/l/model.lock",
      modelDir: "/models",
      binary:
        "/Users/u/Library/Application Support/eido-dev/llama.cpp/b11149/llama-server",
      port: 18091,
      stackDir: "/stack",
      profilesPath: "/stack/profiles.lock",
      verifiedPath: "/stack/verified-profiles",
    })
  })

  it("rejects a port that is not a port", () => {
    expect(() =>
      buildConfig({ EIDO_LLAMA_PORT: "80a" }, "/Users/u", "/l", lock, mac)
    ).toThrow(/EIDO_LLAMA_PORT/)
  })
})

describe("buildConfig on Windows", () => {
  it("defaults under %LOCALAPPDATA%\\eido-dev, with llama-server.exe", () => {
    const config = buildConfig(
      { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" },
      "C:\\Users\\s",
      "C:\\repo\\infra\\model.lock",
      lock,
      windows
    )
    expect(fields(config)).toEqual({
      platform: "win32-x64",
      windows: true,
      lockPath: "C:\\repo\\infra\\model.lock",
      modelDir: "C:\\Users\\s\\AppData\\Local\\eido-dev\\models",
      binary:
        "C:\\Users\\s\\AppData\\Local\\eido-dev\\llama.cpp\\b11149\\llama-server.exe",
      buildDir: "C:\\Users\\s\\AppData\\Local\\eido-dev\\llama.cpp\\b11149",
      port: 8080,
      stackDir: "C:\\Users\\s\\AppData\\Local\\eido-dev",
      profilesPath: "C:\\Users\\s\\AppData\\Local\\eido-dev\\profiles.lock",
      verifiedPath: "C:\\Users\\s\\AppData\\Local\\eido-dev\\verified-profiles",
    })
    expect(config.join("C:\\a", "b")).toBe("C:\\a\\b")
  })
})

describe("buildConfig on Linux", () => {
  it("defaults under ~/.local/share/eido-dev, or $XDG_DATA_HOME/eido-dev", () => {
    const config = buildConfig(
      {},
      "/home/u",
      "/repo/infra/model.lock",
      lock,
      linux
    )
    expect(fields(config)).toEqual({
      platform: "linux-x64",
      windows: false,
      lockPath: "/repo/infra/model.lock",
      modelDir: "/home/u/.local/share/eido-dev/models",
      binary: "/home/u/.local/share/eido-dev/llama.cpp/b11149/llama-server",
      buildDir: "/home/u/.local/share/eido-dev/llama.cpp/b11149",
      port: 8080,
      stackDir: "/home/u/.local/share/eido-dev",
      profilesPath: "/home/u/.local/share/eido-dev/profiles.lock",
      verifiedPath: "/home/u/.local/share/eido-dev/verified-profiles",
    })
    expect(config.join("/a", "b")).toBe("/a/b")

    expect(
      fields(
        buildConfig(
          { XDG_DATA_HOME: "/xdg/data" },
          "/home/u",
          "/repo/infra/model.lock",
          lock,
          linux
        )
      )
    ).toMatchObject({
      modelDir: "/xdg/data/eido-dev/models",
      binary: "/xdg/data/eido-dev/llama.cpp/b11149/llama-server",
      buildDir: "/xdg/data/eido-dev/llama.cpp/b11149",
      stackDir: "/xdg/data/eido-dev",
    })
  })
})

describe("dataRoot", () => {
  it("falls back to AppData\\Local under the home directory without LOCALAPPDATA", () => {
    expect(dataRoot({ LOCALAPPDATA: " " }, "C:\\Users\\s", "win32")).toBe(
      "C:\\Users\\s\\AppData\\Local\\eido-dev"
    )
  })

  it("falls back to .local/share under the home directory without XDG_DATA_HOME", () => {
    expect(dataRoot({ XDG_DATA_HOME: " " }, "/home/u", "linux")).toBe(
      "/home/u/.local/share/eido-dev"
    )
  })
})

describe("lockPathFrom", () => {
  it("uses the override or the default", () => {
    expect(lockPathFrom({ EIDO_MODEL_LOCK: "/x" }, "/d")).toBe("/x")
    expect(lockPathFrom({}, "/d")).toBe("/d")
  })
})

describe("launchEnv", () => {
  it("writes every resolved setting but not the active profile, which the launcher reads at each start", () => {
    const env = launchEnv(
      buildConfig({ EIDO_LLAMA_PORT: "9" }, "/h", "/l", lock, mac)
    )
    expect(env).toEqual({
      EIDO_MODEL_LOCK: "/l",
      EIDO_MODEL_DIR: "/h/Library/Application Support/eido-dev/models",
      EIDO_LLAMA_SERVER_BIN:
        "/h/Library/Application Support/eido-dev/llama.cpp/b11149/llama-server",
      EIDO_LLAMA_PORT: "9",
      EIDO_STACK_DIR: "/h/Library/Application Support/eido-dev",
    })
  })
})
