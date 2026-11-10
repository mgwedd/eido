// The stack's settings store (#625): `stack.env` under the stack dir, non-secret `KEY=value`
// lines written by the system (setup, `llama use`, a future setup UI), mode 0600 on macOS and
// Linux. Windows has no mode bits; its ACL check is part of #455, so none is done there yet. Every stack
// command loads it; a variable already set in the environment wins. Only allowlisted keys are
// accepted, so a typo or a secret fails loudly. Secrets never go here: client secrets, the Bridge
// password and tokens stay in the gate vault, and the Auth0 values stay in apps/web/.env.local.
import { posix, win32 } from "node:path"
import { parseEnv } from "node:util"

import { OVERRIDES as LLAMA_OVERRIDES } from "../llama/config.ts"
import { parsePort } from "../tailscale/serve-routes.ts"
import {
  OVERRIDES,
  PASS_THROUGH,
  pathsFor,
  stackDirOf,
  type Env,
  type Platform,
} from "./config.ts"

/** Where `stack.env` lives; read from the environment only, never from the file itself. */
export const STACK_DIR_VARIABLE = "EIDO_STACK_DIR"

export const SETTINGS_FILE = "stack.env"

/** Every key `stack.env` may hold. */
export const SETTING_KEYS = [
  ...OVERRIDES.filter((key) => key !== STACK_DIR_VARIABLE),
  ...PASS_THROUGH.gate,
  ...PASS_THROUGH.core,
  ...LLAMA_OVERRIDES.filter((key) => key !== "EIDO_LLAMA_PORT"),
  // The model id `llama use <id>` selects (#628).
  "EIDO_LLAMA_MODEL",
] as const

export type SettingKey = (typeof SETTING_KEYS)[number]
export type StackSettings = Partial<Record<SettingKey, string>>

const KEYS: ReadonlySet<string> = new Set(SETTING_KEYS)

export const isSettingKey = (key: string): key is SettingKey => KEYS.has(key)

const PORT_KEYS: ReadonlySet<string> = new Set([
  "EIDO_EDGE_PORT",
  "EIDO_WEB_PORT",
  "EIDO_CORE_PORT",
  "EIDO_GATE_PHONE_PORT",
  "EIDO_LLAMA_PORT",
  "EIDO_BRIDGE_IMAP_PORT",
  "EIDO_BRIDGE_SMTP_PORT",
])

/** Loopback hosts each host key accepts: the gate takes Bridge on 127.0.0.1 or ::1 only; core's model client also takes localhost. */
const HOST_KEYS: Readonly<Record<string, readonly string[]>> = {
  EIDO_BRIDGE_HOST: ["127.0.0.1", "::1"],
  EIDO_LLAMA_HOST: ["127.0.0.1", "::1", "localhost"],
}

/** Settings that name a file or directory; the value must be an absolute path. */
const PATH_KEYS: ReadonlySet<string> = new Set([
  "EIDO_STACK_LOG_DIR",
  "EIDO_GATE_DATA_DIR",
  "EIDO_DATA_DIR",
  "EIDO_GATE_SOCKET",
  "EIDO_GATE_CONTROL_SOCKET",
  "EIDO_GATE_KEYCHAIN_PATH",
  "EIDO_FILE_HELPER_PATH",
  "EIDO_BRIDGE_CERT_PATH",
  "EIDO_GATE_VAULT_FILE",
])

/** Settings that are a flag: `0` or `1`. */
const FLAG_KEYS: ReadonlySet<string> = new Set([
  "EIDO_DEV_VAULT",
  "EIDO_BRIDGE_ALLOW_SELF_SIGNED",
  "EIDO_FILES_SYNC",
])

/**
 * Settings the supervisor's `POST /settings` refuses. They choose where the gate's secrets
 * live or weaken its transport checks, so only the setup command (a local terminal) may write
 * them. No web admin page sets them.
 */
export const API_REFUSED_KEYS: ReadonlySet<string> = new Set([
  "EIDO_DEV_VAULT",
  "EIDO_GATE_VAULT_FILE",
  "EIDO_BRIDGE_ALLOW_SELF_SIGNED",
])

/** Why `value` is not a valid `key`, or undefined when it is. */
export function settingProblem(key: string, value: string): string | undefined {
  if (key === STACK_DIR_VARIABLE)
    return `${key} says where ${SETTINGS_FILE} lives; set it in the environment, not in the file`
  if (!isSettingKey(key)) return `${key} is not a stack setting`
  if (/[\r\n]/.test(value)) return `${key} must be one line`
  if (value.includes("'") && value.includes('"'))
    return `${key} cannot hold both quote characters`
  if (PORT_KEYS.has(key) && value !== "") {
    try {
      parsePort(value, key)
    } catch (error) {
      return (error as Error).message
    }
  }
  if (
    key === "EIDO_PUSH_VAPID_SUBJECT" &&
    value !== "" &&
    !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(value)
  )
    return `${key} must be a mailto: address or an https: URL`
  const hosts = HOST_KEYS[key]
  if (hosts !== undefined && value !== "" && !hosts.includes(value))
    return `${key} must be a loopback host: ${hosts.join(", ")}`
  if (
    PATH_KEYS.has(key) &&
    value !== "" &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value)
  )
    return `${key} must be an absolute path`
  if (FLAG_KEYS.has(key) && value !== "" && value !== "0" && value !== "1")
    return `${key} must be 0 or 1`
  return undefined
}

/** Like `settingProblem`, plus the keys the supervisor's settings endpoint refuses outright. */
export function apiSettingProblem(
  key: string,
  value: string
): string | undefined {
  if (API_REFUSED_KEYS.has(key))
    return `${key} cannot be changed through the settings endpoint; run the setup command on this machine`
  return settingProblem(key, value)
}

/** Checks every entry; throws an Error naming the first bad key. */
export function validateSettings(
  values: Readonly<Record<string, string | undefined>>
): StackSettings {
  const settings: StackSettings = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    const problem = settingProblem(key, value)
    if (problem !== undefined || !isSettingKey(key))
      throw new Error(problem ?? `${key} is not a stack setting`)
    settings[key] = value
  }
  return settings
}

/** Parses `stack.env` text with node's own dotenv parser, then validates it. */
export function parseStackSettings(text: string): StackSettings {
  return validateSettings(parseEnv(text))
}

const BARE = /^[A-Za-z0-9_./:@+,=-]*$/

/** The file text for `settings`, keys in allowlist order, one `KEY=value` line each. */
export function formatStackSettings(settings: StackSettings): string {
  const lines = [
    "# Written by the Eido stack (pnpm stack:setup). Non-secret settings only.",
  ]
  for (const key of SETTING_KEYS) {
    const value = settings[key]
    if (value === undefined) continue
    const problem = settingProblem(key, value)
    if (problem !== undefined) throw new Error(problem)
    const quoted = BARE.test(value)
      ? value
      : value.includes("'")
        ? `"${value}"`
        : `'${value}'`
    lines.push(`${key}=${quoted}`)
  }
  return `${lines.join("\n")}\n`
}

export function stackSettingsPath(
  env: Env,
  home: string,
  platform: Platform
): string {
  return pathsFor(platform).join(stackDirOf(platform, env, home), SETTINGS_FILE)
}

export type FileStat = { isFile: boolean; mode: number; size: number }

export type SettingsFiles = {
  read: (path: string) => string | undefined
  /** lstat: a symlink is not a regular file. Undefined when nothing is at the path. */
  stat: (path: string) => FileStat | undefined
  /** Writes the file, creating it with mode 0600. */
  write: (path: string, text: string) => void
  /** mkdir -p, then chmod 700. */
  ensurePrivateDir: (path: string) => void
}

const permissions = (mode: number) => mode & 0o777

/**
 * The settings in `path`, or none when there is no file. Refuses anything but a regular file,
 * a mode other than 0600 (POSIX only), and any key outside the allowlist.
 */
export function readStackSettings(
  files: Pick<SettingsFiles, "read" | "stat">,
  path: string,
  platform: Platform
): StackSettings {
  const stat = files.stat(path)
  if (stat === undefined) return {}
  if (!stat.isFile) throw new Error(`${path} is not a regular file`)
  if (platform !== "win32" && permissions(stat.mode) !== 0o600)
    throw new Error(
      `${path} has mode ${permissions(stat.mode).toString(8).padStart(4, "0")}, not 0600; fix with: chmod 600 '${path}'`
    )
  const text = files.read(path) ?? ""
  try {
    return parseStackSettings(text)
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`)
  }
}

/** Replaces the whole file with `settings`. */
export function writeStackSettings(
  files: SettingsFiles,
  path: string,
  settings: StackSettings,
  platform: Platform
): void {
  const text = formatStackSettings(settings)
  files.ensurePrivateDir(pathsFor(platform).dirname(path))
  files.write(path, text)
}

/** Sets one key, keeping the rest of the file. An empty value removes the key. */
export function writeStackSetting(
  files: SettingsFiles,
  path: string,
  key: SettingKey,
  value: string,
  platform: Platform
): StackSettings {
  const problem = settingProblem(key, value)
  if (problem !== undefined) throw new Error(problem)
  const settings = { ...readStackSettings(files, path, platform) }
  if (value === "") delete settings[key]
  else settings[key] = value
  writeStackSettings(files, path, settings, platform)
  return settings
}

/** The environment the stack runs with: `stack.env` under the real environment, which wins. */
export function applyStackSettings(env: Env, settings: StackSettings): Env {
  const merged: Record<string, string | undefined> = { ...settings }
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) merged[key] = value
  return merged
}

/** One key from `stack.env`, or undefined when the file does not set it. */
export function getStackSetting(
  files: Pick<SettingsFiles, "read" | "stat">,
  path: string,
  key: SettingKey,
  platform: Platform
): string | undefined {
  return readStackSettings(files, path, platform)[key]
}
