import { describe, expect, it } from "vitest"

import { buildConfig, launchEnv, lockPathFrom } from "./config.ts"

const lock = { file: "m.gguf", llamaCppBuild: "b11149" }

describe("buildConfig", () => {
  it("defaults under Application Support/eido-dev, port 8080", () => {
    expect(buildConfig({}, "/Users/u", "/repo/infra/model.lock", lock)).toEqual(
      {
        lockPath: "/repo/infra/model.lock",
        modelDir: "/Users/u/Library/Application Support/eido-dev/models",
        modelPath:
          "/Users/u/Library/Application Support/eido-dev/models/m.gguf",
        binary:
          "/Users/u/Library/Application Support/eido-dev/llama.cpp/b11149/llama-server",
        port: 8080,
      }
    )
  })

  it("takes overrides from the environment, ignoring blank ones", () => {
    const env = {
      EIDO_MODEL_LOCK: "/l/model.lock",
      EIDO_MODEL_DIR: " /models ",
      EIDO_LLAMA_SERVER_BIN: "",
      EIDO_LLAMA_PORT: "18091",
    }
    expect(
      buildConfig(env, "/Users/u", "/repo/infra/model.lock", lock)
    ).toEqual({
      lockPath: "/l/model.lock",
      modelDir: "/models",
      modelPath: "/models/m.gguf",
      binary:
        "/Users/u/Library/Application Support/eido-dev/llama.cpp/b11149/llama-server",
      port: 18091,
    })
  })

  it("rejects a port that is not a port", () => {
    expect(() =>
      buildConfig({ EIDO_LLAMA_PORT: "80a" }, "/Users/u", "/l", lock)
    ).toThrow(/EIDO_LLAMA_PORT/)
  })
})

describe("lockPathFrom", () => {
  it("uses the override or the default", () => {
    expect(lockPathFrom({ EIDO_MODEL_LOCK: "/x" }, "/d")).toBe("/x")
    expect(lockPathFrom({}, "/d")).toBe("/d")
  })
})

describe("launchEnv", () => {
  it("writes every resolved setting, so launchd runs the same config", () => {
    expect(
      launchEnv({
        lockPath: "/l",
        modelDir: "/m",
        modelPath: "/m/f",
        binary: "/b",
        port: 9,
      })
    ).toEqual({
      EIDO_MODEL_LOCK: "/l",
      EIDO_MODEL_DIR: "/m",
      EIDO_LLAMA_SERVER_BIN: "/b",
      EIDO_LLAMA_PORT: "9",
    })
  })
})
