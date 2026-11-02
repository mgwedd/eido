// Where the launcher finds the lock, the model and llama-server, and which loopback port it uses.
// Every value has a default and an env override; none is a secret.
import { join } from "node:path"

import { parsePort } from "../tailscale/serve-routes.ts"
import type { ModelLock } from "./lock.ts"

export type Env = Readonly<Record<string, string | undefined>>

/** llama-server's own default port. Core reads the same value from EIDO_LLAMA_PORT. */
export const DEFAULT_PORT = 8080

/** Environment variables that override a default; written into the LaunchAgent as resolved. */
export const OVERRIDES = [
  "EIDO_MODEL_LOCK",
  "EIDO_MODEL_DIR",
  "EIDO_LLAMA_SERVER_BIN",
  "EIDO_LLAMA_PORT",
] as const

export type LlamaConfig = {
  lockPath: string
  modelDir: string
  /** `<modelDir>/<lock.file>`: the only file the launcher will load. */
  modelPath: string
  binary: string
  port: number
}

const set = (env: Env, key: (typeof OVERRIDES)[number]): string | undefined => {
  const value = env[key]?.trim()
  return value === undefined || value === "" ? undefined : value
}

/** The lock path alone, needed before the lock is read. */
export const lockPathFrom = (env: Env, defaultLockPath: string): string =>
  set(env, "EIDO_MODEL_LOCK") ?? defaultLockPath

export function buildConfig(
  env: Env,
  home: string,
  defaultLockPath: string,
  lock: Pick<ModelLock, "file" | "llamaCppBuild">
): LlamaConfig {
  const root = join(home, "Library", "Application Support", "eido-dev")
  const modelDir = set(env, "EIDO_MODEL_DIR") ?? join(root, "models")
  const portText = set(env, "EIDO_LLAMA_PORT")
  return {
    lockPath: lockPathFrom(env, defaultLockPath),
    modelDir,
    modelPath: join(modelDir, lock.file),
    binary:
      set(env, "EIDO_LLAMA_SERVER_BIN") ??
      join(root, "llama.cpp", lock.llamaCppBuild, "llama-server"),
    port:
      portText === undefined
        ? DEFAULT_PORT
        : parsePort(portText, "EIDO_LLAMA_PORT"),
  }
}

/** The resolved settings, as the LaunchAgent's environment. */
export function launchEnv(config: LlamaConfig): Record<string, string> {
  return {
    EIDO_MODEL_LOCK: config.lockPath,
    EIDO_MODEL_DIR: config.modelDir,
    EIDO_LLAMA_SERVER_BIN: config.binary,
    EIDO_LLAMA_PORT: String(config.port),
  }
}
