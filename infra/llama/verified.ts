// The record of template checks passed on this machine: `<EIDO_STACK_DIR>/verified-profiles`, one
// `<profile id> <sha256> <llama.cpp build>` line per profile. `llama check-template` writes a line
// when every check passes, and launch accepts a profile model.lock does not mark verified only when
// its line matches the file's hash and the pinned build, so a new file or build needs a new pass.
import type { ModelProfile } from "./lock.ts"

export const VERIFIED_FILE = "verified-profiles"

const entry = (line: string) => line.trim().split(/\s+/)

/** Whether the record holds a pass for this profile's file on this build. */
export function hasPass(
  text: string,
  profile: Pick<ModelProfile, "id" | "sha256">,
  build: string
): boolean {
  return text.split("\n").some((line) => {
    const [id, sha256, at] = entry(line)
    return id === profile.id && sha256 === profile.sha256 && at === build
  })
}

/** The record with this profile's pass, replacing any earlier line for the same id. */
export function withPass(
  text: string,
  profile: Pick<ModelProfile, "id" | "sha256">,
  build: string
): string {
  const kept = text
    .split("\n")
    .filter((line) => line.trim() !== "" && entry(line)[0] !== profile.id)
  return `${[...kept, `${profile.id} ${profile.sha256} ${build}`].join("\n")}\n`
}
