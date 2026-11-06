// The stack settings file (#625): `<EIDO_STACK_DIR>/stack.env`, non-secret `KEY=value` lines, mode
// 0600. The llama launcher reads and `llama use` writes one key in it, EIDO_LLAMA_MODEL, the active
// model profile. Until #625 exports shared helpers, these pure functions handle that one key and
// keep every other line as it is.
import { parseEnv } from "node:util"

/** The key holding the active profile id. An exported variable of the same name wins over the file. */
export const MODEL_KEY = "EIDO_LLAMA_MODEL"

export const SETTINGS_FILE = "stack.env"

/** The value of `key` in the settings text, or undefined when it is unset or blank. */
export function readSetting(text: string, key: string): string | undefined {
  const value = parseEnv(text)[key]?.trim()
  return value === undefined || value === "" ? undefined : value
}

const assignment = (key: string) =>
  new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)

/**
 * The settings text with `key` set to `value`. The first line assigning the key is replaced and
 * any later one dropped; every other line is kept. A missing key is appended.
 */
export function withSetting(text: string, key: string, value: string): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n")
  const matches = assignment(key)
  let written = false
  const kept: string[] = []
  for (const line of lines) {
    if (!matches.test(line)) kept.push(line)
    else if (!written) {
      kept.push(`${key}=${value}`)
      written = true
    }
  }
  if (!written) kept.push(`${key}=${value}`)
  return `${kept.join("\n")}\n`
}
