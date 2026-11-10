// `pnpm stack:setup` (#625): the first run, safe to rerun. On macOS it creates the gate keychain
// when it is missing; on Windows and Linux it points the gate at the development file vault, since
// a production vault there is #455. Then it asks for the settings that are not set and writes
// stack.env. It is deliberately small: a setup UI is expected to replace the prompts. `security`
// runs with the terminal inherited, so the keychain password goes from the user to `security` and
// never passes through this process, its arguments or its environment.
import { pathsFor, type Env, type Platform } from "./config.ts"
import { defaultKeychainPath, defaultVaultFile, quote } from "./doctor.ts"
import type { Exec } from "./ports.ts"
import {
  settingProblem,
  writeStackSettings,
  type SettingKey,
  type SettingsFiles,
  type StackSettings,
} from "./settings.ts"

export type SetupDeps = {
  platform: Platform
  /** The environment with stack.env applied. */
  env: Env
  home: string
  exec: Exec
  /** Runs a command with the terminal inherited; resolves with its exit code. */
  interactive: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ) => Promise<number>
  /** Prints `question` and resolves with the line the user types. */
  ask: (question: string) => Promise<string>
  files: SettingsFiles & { setMode: (path: string, mode: number) => void }
  out: (line: string) => void
  err: (line: string) => void
}

/** The settings setup asks for when they are not set, in order. */
export const PROMPTED: readonly SettingKey[] = [
  "EIDO_PUSH_VAPID_SUBJECT",
  "EIDO_GMAIL_CLIENT_ID",
  "EIDO_GMAIL_READ_CLIENT_ID",
]

const set = (env: Env, key: string): string | undefined => {
  const value = env[key]
  return value === undefined || value === "" ? undefined : value
}

async function ensureKeychain(
  deps: SetupDeps,
  settings: StackSettings
): Promise<boolean> {
  const configured = set(deps.env, "EIDO_GATE_KEYCHAIN_PATH")
  const path = configured ?? defaultKeychainPath(deps.home)
  if (deps.files.stat(path) === undefined) {
    if (configured !== undefined && path !== defaultKeychainPath(deps.home)) {
      deps.err(
        `FAIL: EIDO_GATE_KEYCHAIN_PATH names ${path}, which does not exist; setup creates only ${defaultKeychainPath(deps.home)}`
      )
      return false
    }
    deps.files.ensurePrivateDir(pathsFor("darwin").dirname(path))
    deps.out(`$ security create-keychain ${quote(path)}`)
    if ((await deps.interactive("security", ["create-keychain", path])) !== 0) {
      deps.err("FAIL: security create-keychain did not finish")
      return false
    }
    deps.files.setMode(path, 0o600)
    deps.out(`$ security unlock-keychain ${quote(path)}`)
    if ((await deps.interactive("security", ["unlock-keychain", path])) !== 0) {
      deps.err("FAIL: security unlock-keychain did not finish")
      return false
    }
  } else if (
    (await deps.exec("security", ["show-keychain-info", path])).code !== 0
  ) {
    deps.out(`$ security unlock-keychain ${quote(path)}`)
    if ((await deps.interactive("security", ["unlock-keychain", path])) !== 0) {
      deps.err("FAIL: security unlock-keychain did not finish")
      return false
    }
  }
  if (configured === undefined) settings.EIDO_GATE_KEYCHAIN_PATH = path
  deps.out(`keychain: ${path}`)
  return true
}

/** Off macOS: the development file vault (#455), unless the environment or stack.env names one. */
function ensureDevVault(deps: SetupDeps, settings: StackSettings): void {
  const file =
    set(deps.env, "EIDO_GATE_VAULT_FILE") ??
    defaultVaultFile(deps.platform, deps.env, deps.home)
  if (set(deps.env, "EIDO_DEV_VAULT") === undefined)
    settings.EIDO_DEV_VAULT = "1"
  if (set(deps.env, "EIDO_GATE_VAULT_FILE") === undefined) {
    deps.files.ensurePrivateDir(pathsFor(deps.platform).dirname(file))
    settings.EIDO_GATE_VAULT_FILE = file
  }
  deps.out(
    `vault: development file vault at ${file}; a production vault on this platform is #455`
  )
}

async function defaultFor(
  deps: SetupDeps,
  key: SettingKey
): Promise<string | undefined> {
  if (key !== "EIDO_PUSH_VAPID_SUBJECT") return undefined
  const email = (await deps.exec("git", ["config", "user.email"])).stdout.trim()
  return email === "" ? undefined : `mailto:${email}`
}

/**
 * Creates or unlocks the keychain (macOS) or sets the development vault (elsewhere), asks for each prompted setting the environment and stack.env
 * leave unset, and writes stack.env. Returns 0 when it wrote the file.
 */
export async function runSetup(
  deps: SetupDeps,
  settingsPath: string,
  fileSettings: StackSettings
): Promise<number> {
  const settings: StackSettings = { ...fileSettings }
  if (deps.platform === "darwin") {
    if (!(await ensureKeychain(deps, settings))) return 1
  } else ensureDevVault(deps, settings)
  for (const key of PROMPTED) {
    if (set(deps.env, key) !== undefined) continue
    if (
      (key === "EIDO_GMAIL_CLIENT_ID" || key === "EIDO_GMAIL_READ_CLIENT_ID") &&
      (set(deps.env, "EIDO_GOOGLE_CLIENT_ID") !== undefined ||
        set(settings, "EIDO_GOOGLE_CLIENT_ID") !== undefined)
    )
      continue
    const fallback = await defaultFor(deps, key)
    const answer =
      (
        await deps.ask(
          `${key}${fallback === undefined ? "" : ` [${fallback}]`}: `
        )
      ).trim() ||
      fallback ||
      ""
    if (answer === "") {
      deps.out(`${key}: left unset`)
      continue
    }
    const problem = settingProblem(key, answer)
    if (problem !== undefined) {
      deps.err(`${problem}; left unset`)
      continue
    }
    settings[key] = answer
  }
  writeStackSettings(deps.files, settingsPath, settings, deps.platform)
  deps.out(`wrote ${settingsPath}`)
  return 0
}
