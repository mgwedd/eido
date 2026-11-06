// Where the launcher finds the lock, the models, llama-server and the stack directory, and which
// loopback port it uses. Every value has a default and an env override; none is a secret. The
// defaults depend on the platform, which is passed in so both layouts are tested on any host.
import { posix, win32 } from "node:path"

import { platformOf, stackDirOf } from "../stack/config.ts"
import { parsePort } from "../tailscale/serve-routes.ts"
import type { ModelLock } from "./lock.ts"
import { VERIFIED_FILE } from "./verified.ts"

/** The user's own profiles, written by `llama add`; next to the settings, never committed. */
export const USER_PROFILES_FILE = "profiles.lock"

export type Env = Readonly<Record<string, string | undefined>>

/** llama-server's own default port. Core reads the same value from EIDO_LLAMA_PORT. */
export const DEFAULT_PORT = 8080

/** Environment variables that override a default; written into the LaunchAgent as resolved. */
export const OVERRIDES = [
  "EIDO_MODEL_LOCK",
  "EIDO_MODEL_DIR",
  "EIDO_LLAMA_SERVER_BIN",
  "EIDO_LLAMA_PORT",
  "EIDO_STACK_DIR",
] as const

export type Platform = { os: NodeJS.Platform; arch: string }

export type LlamaConfig = {
  /** `<os>-<arch>`, the key of this platform's `[build]` in the lock. */
  platform: string
  windows: boolean
  /** The platform's path join. */
  join: (...parts: string[]) => string
  lockPath: string
  modelDir: string
  binary: string
  /** The directory `llama fetch` installs the pinned build into. */
  buildDir: string
  port: number
  stackDir: string
  /** `<stackDir>/profiles.lock`, the profiles `llama add` wrote. */
  profilesPath: string
  /** `<stackDir>/verified-profiles`, the template checks passed on this machine. */
  verifiedPath: string
}

export const envValue = (env: Env, key: string): string | undefined => {
  const value = env[key]?.trim()
  return value === undefined || value === "" ? undefined : value
}

const set = (env: Env, key: (typeof OVERRIDES)[number]) => envValue(env, key)

/** The lock path alone, needed before the lock is read. */
export const lockPathFrom = (env: Env, defaultLockPath: string): string =>
  set(env, "EIDO_MODEL_LOCK") ?? defaultLockPath

/** The binary's file name: Windows executables end in `.exe`. */
export const serverName = (windows: boolean): string =>
  windows ? "llama-server.exe" : "llama-server"

/**
 * Eido's per-user data directory: `~/Library/Application Support/eido-dev` on macOS,
 * `%LOCALAPPDATA%\eido-dev` on Windows.
 */
export function dataRoot(env: Env, home: string, os: NodeJS.Platform): string {
  if (os === "win32")
    return win32.join(
      envValue(env, "LOCALAPPDATA") ?? win32.join(home, "AppData", "Local"),
      "eido-dev"
    )
  return posix.join(home, "Library", "Application Support", "eido-dev")
}

export function buildConfig(
  env: Env,
  home: string,
  defaultLockPath: string,
  lock: Pick<ModelLock, "llamaCppBuild">,
  platform: Platform
): LlamaConfig {
  const windows = platform.os === "win32"
  const join = windows
    ? (...parts: string[]) => win32.join(...parts)
    : (...parts: string[]) => posix.join(...parts)
  const root = dataRoot(env, home, platform.os)
  const buildDir = join(root, "llama.cpp", lock.llamaCppBuild)
  const stackDir = stackDirOf(platformOf(platform.os), env, home)
  const portText = set(env, "EIDO_LLAMA_PORT")
  return {
    platform: `${platform.os}-${platform.arch}`,
    windows,
    join,
    lockPath: lockPathFrom(env, defaultLockPath),
    modelDir: set(env, "EIDO_MODEL_DIR") ?? join(root, "models"),
    binary:
      set(env, "EIDO_LLAMA_SERVER_BIN") ?? join(buildDir, serverName(windows)),
    buildDir,
    port:
      portText === undefined
        ? DEFAULT_PORT
        : parsePort(portText, "EIDO_LLAMA_PORT"),
    stackDir,
    profilesPath: join(stackDir, USER_PROFILES_FILE),
    verifiedPath: join(stackDir, VERIFIED_FILE),
  }
}

/**
 * The resolved settings, as the LaunchAgent's environment. The active profile is left out on
 * purpose: the launcher reads it from the settings file at every start, so `llama use` and a
 * restart switch models without rewriting the plist.
 */
export function launchEnv(config: LlamaConfig): Record<string, string> {
  return {
    EIDO_MODEL_LOCK: config.lockPath,
    EIDO_MODEL_DIR: config.modelDir,
    EIDO_LLAMA_SERVER_BIN: config.binary,
    EIDO_LLAMA_PORT: String(config.port),
    EIDO_STACK_DIR: config.stackDir,
  }
}
