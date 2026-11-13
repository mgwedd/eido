// `infra/model.lock`: the pinned llama.cpp build and the named model profiles (#29, #628). The
// file is plain `key: value` lines; `#` starts a comment line. The release keys come first, then
// one `[build <platform>-<arch>]` section per platform's release asset and one `[profile <id>]`
// section per model. Every key is accepted once per section and no other key is accepted, so a
// typo fails loudly instead of being ignored. Profiles a user adds with `llama add` live in a
// second file of `[profile]` sections only, next to the stack settings, and are never committed.
import { posix, win32 } from "node:path"

/** Where a profile's GGUF lives: downloaded into the model directory, or a file already on disk. */
export type ModelLocation =
  | {
      kind: "download"
      /** The file name under the model directory. Never a path: no fallback to another file. */
      file: string
      /** An https URL that ends in `/<file>`, pinned to a revision. */
      source: string
    }
  | {
      kind: "local"
      /** An absolute path to a GGUF already on disk, such as a blob in Ollama's store. */
      path: string
    }

export type ModelProfile = {
  /** The name `llama use` and `EIDO_LLAMA_MODEL` refer to. */
  id: string
  model: string
  quantization: string
  location: ModelLocation
  /** Exact size in bytes. */
  size: number
  /** SHA-256 of the file, lowercase hex. */
  sha256: string
  /**
   * A substring `/props` must report in `chat_template`, so the model's own template is loaded.
   * Required in model.lock; a user-added profile may leave it out.
   */
  chatTemplateMarker: string | undefined
  /** Passed to llama-server as `--chat-template-kwargs`, so every templated request gets them. */
  chatTemplateKwargs: Record<string, unknown> | undefined
  /**
   * Hidden-reasoning and control tokens a reply must not contain, from `hidden_tokens` in
   * model.lock. Absent: `llama check-template` uses its default set.
   */
  hiddenTokens?: string[] | undefined
  /** Extra llama-server flags, appended after the base flags. */
  flags: string[]
  /**
   * `verified: true` in model.lock: the profile passed `llama check-template` on a real host with
   * the pinned build. Anything else is verified only by a recorded pass on this machine.
   */
  verified: boolean
  /** model.lock, or the user's own profiles file. */
  origin: "lock" | "user"
}

/** One platform's release asset of the pinned build. */
export type BuildAsset = {
  /** `<process.platform>-<process.arch>`, such as `darwin-arm64` or `win32-x64`. */
  platform: string
  /** The release asset file: a `.tar.gz` or a `.zip`. */
  asset: string
  /** An https URL that ends in `/<asset>`. */
  source: string
  /** SHA-256 of that asset, lowercase hex. */
  sha256: string
}

export type ModelLock = {
  /** The llama.cpp release tag, `b<number>`. */
  llamaCppBuild: string
  /** The commit `llama-server --version` reports for that build (short hex). */
  llamaCppCommit: string
  builds: BuildAsset[]
  /** The id of the profile used when none is chosen. */
  defaultProfile: string
  profiles: ModelProfile[]
}

const HEAD_KEYS = [
  "llama_cpp_build",
  "llama_cpp_commit",
  "default_profile",
] as const

const BUILD_KEYS = ["asset", "source", "sha256"] as const

const PROFILE_KEYS = [
  "model",
  "quantization",
  "file",
  "path",
  "source",
  "size",
  "sha256",
  "chat_template_marker",
  "chat_template_kwargs",
  "hidden_tokens",
  "flags",
  "verified",
] as const

type HeadKey = (typeof HEAD_KEYS)[number]
type ProfileKey = (typeof PROFILE_KEYS)[number]

const SHA256 = /^[0-9a-f]{64}$/
const FILE_NAME = /^[A-Za-z0-9._-]+$/
export const PROFILE_ID = /^[a-z0-9][a-z0-9._-]*$/
const SECTION = /^\[(profile|build) ([^\]]*)\]$/
const PLATFORM = /^[a-z0-9]+-[a-z0-9]+$/
const ARCHIVE = /\.(tar\.gz|zip)$/

/**
 * Flags a profile may not set: the launcher fixes the model file, the loopback bind and the port,
 * keeps inference on this machine, and takes the chat template from the GGUF (`--jinja`) with its
 * kwargs from `chat_template_kwargs`.
 */
export const RESERVED_FLAGS = new Set([
  "-m",
  "--model",
  "-mu",
  "--model-url",
  "-hf",
  "-hfr",
  "--hf-repo",
  "-hff",
  "--hf-file",
  "-dr",
  "--docker-repo",
  "--host",
  "--port",
  "--rpc",
  "--jinja",
  "--no-jinja",
  "--chat-template",
  "--chat-template-file",
  "--chat-template-kwargs",
])

function sha(value: string, key: string): string {
  if (!SHA256.test(value))
    throw new Error(`${key} must be 64 lowercase hex characters`)
  return value
}

function fileName(value: string, key: string): string {
  if (!FILE_NAME.test(value) || value === "." || value === "..")
    throw new Error(
      `${key} must be a bare file name, not ${JSON.stringify(value)}`
    )
  return value
}

function httpsEndingIn(value: string, key: string, file: string): string {
  if (!value.startsWith("https://") || !value.endsWith(`/${file}`))
    throw new Error(`${key} must be an https URL ending in /${file}`)
  return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function kwargs(value: string, where: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = undefined
  }
  if (!isRecord(parsed))
    throw new Error(`${where}: chat_template_kwargs must be a JSON object`)
  return parsed
}

function flags(value: string, where: string): string[] {
  const tokens = value.split(/\s+/)
  for (const token of tokens) {
    const name = token.split("=")[0] ?? token
    if (RESERVED_FLAGS.has(name))
      throw new Error(`${where}: flags may not set ${name}; the launcher does`)
  }
  return tokens
}

type Section = {
  kind: "head" | "build" | "profile"
  id: string
  values: Map<string, string>
}

/** Absolute and normalized, as a POSIX path or a Windows one. */
function absolutePath(path: string): boolean {
  return [posix, win32].some(
    (flavor) => flavor.isAbsolute(path) && flavor.normalize(path) === path
  )
}

function buildOf(section: Section): BuildAsset {
  const where = `build ${section.id}`
  const need = (key: string): string => {
    const value = section.values.get(key)
    if (value === undefined)
      throw new Error(`model.lock ${where} is missing ${key}`)
    return value
  }
  const asset = fileName(need("asset"), `${where}: asset`)
  if (!ARCHIVE.test(asset))
    throw new Error(`model.lock ${where}: asset must be a .tar.gz or a .zip`)
  return {
    platform: section.id,
    asset,
    source: httpsEndingIn(need("source"), `${where}: source`, asset),
    sha256: sha(need("sha256"), `${where}: sha256`),
  }
}

function profileOf(
  section: Section,
  name: string,
  origin: ModelProfile["origin"]
): ModelProfile {
  const where = `profile ${section.id}`
  const get = (key: ProfileKey): string | undefined => section.values.get(key)
  const need = (key: ProfileKey): string => {
    const value = get(key)
    if (value === undefined)
      throw new Error(`${name} ${where} is missing ${key}`)
    return value
  }

  const file = get("file")
  const path = get("path")
  const source = get("source")
  let location: ModelLocation
  if (file !== undefined && path !== undefined)
    throw new Error(`${name} ${where}: set file or path, not both`)
  if (path !== undefined) {
    if (!absolutePath(path))
      throw new Error(
        `${name} ${where}: path must be absolute and normalized, not ${JSON.stringify(path)}`
      )
    if (source !== undefined)
      throw new Error(
        `${name} ${where}: a local path has no source; fetch never downloads it`
      )
    location = { kind: "local", path }
  } else {
    const name = fileName(need("file"), `${where}: file`)
    location = {
      kind: "download",
      file: name,
      source: httpsEndingIn(need("source"), `${where}: source`, name),
    }
  }

  const sizeText = need("size")
  if (!/^[1-9]\d*$/.test(sizeText) || !Number.isSafeInteger(Number(sizeText)))
    throw new Error(`${where}: size must be a whole number of bytes`)

  const kwargsText = get("chat_template_kwargs")
  const flagsText = get("flags")
  const hiddenText = get("hidden_tokens")
  const verifiedText = get("verified")
  if (verifiedText !== undefined && origin === "user")
    throw new Error(
      `${name} ${where}: verified is for model.lock; llama check-template records a pass on this machine`
    )
  if (
    verifiedText !== undefined &&
    verifiedText !== "true" &&
    verifiedText !== "false"
  )
    throw new Error(`${where}: verified must be true or false`)
  return {
    id: section.id,
    model: need("model"),
    quantization: need("quantization"),
    location,
    size: Number(sizeText),
    sha256: sha(need("sha256"), `${where}: sha256`),
    chatTemplateMarker:
      origin === "lock"
        ? need("chat_template_marker")
        : get("chat_template_marker"),
    chatTemplateKwargs:
      kwargsText === undefined ? undefined : kwargs(kwargsText, where),
    hiddenTokens:
      hiddenText === undefined ? undefined : hiddenText.split(/\s+/),
    flags: flagsText === undefined ? [] : flags(flagsText, where),
    verified: verifiedText === "true",
    origin,
  }
}

/** The head and the sections of a lock-format file, keys checked; `name` prefixes every error. */
function sectionsOf(
  text: string,
  name: string
): { head: Section; sections: Section[] } {
  const head: Section = { kind: "head", id: "", values: new Map() }
  const sections: Section[] = []
  let current: Section = head
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const at = `${name} line ${index + 1}`
    const header = SECTION.exec(trimmed)
    if (header !== null) {
      const kind = header[1] === "build" ? "build" : "profile"
      const id = header[2] ?? ""
      if (kind === "profile" && !PROFILE_ID.test(id))
        throw new Error(
          `${at}: profile id must be lowercase letters, digits, dots, dashes or underscores, not ${JSON.stringify(id)}`
        )
      if (kind === "build" && !PLATFORM.test(id))
        throw new Error(
          `${at}: build must be named <platform>-<arch>, such as darwin-arm64, not ${JSON.stringify(id)}`
        )
      if (sections.some((s) => s.kind === kind && s.id === id))
        throw new Error(`${at}: ${kind} ${id} appears twice`)
      current = { kind, id, values: new Map<string, string>() }
      sections.push(current)
      continue
    }
    const colon = trimmed.indexOf(":")
    if (colon <= 0) throw new Error(`${at}: expected "key: value"`)
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    const allowed: readonly string[] = {
      head: HEAD_KEYS,
      build: BUILD_KEYS,
      profile: PROFILE_KEYS,
    }[current.kind]
    if (!allowed.includes(key))
      throw new Error(
        `${at}: unknown key ${JSON.stringify(key)}${current.kind === "head" ? " before the first section" : ` in ${current.kind} ${current.id}`}`
      )
    if (current.values.has(key)) throw new Error(`${at}: ${key} appears twice`)
    if (value === "") throw new Error(`${at}: ${key} is empty`)
    current.values.set(key, value)
  }
  return { head, sections }
}

/** Parses and validates the lock text. Throws an Error naming the line, section or key at fault. */
export function parseLock(text: string): ModelLock {
  const { head, sections } = sectionsOf(text, "model.lock")
  const get = (key: HeadKey): string => {
    const value = head.values.get(key)
    if (value === undefined) throw new Error(`model.lock is missing ${key}`)
    return value
  }
  const build = get("llama_cpp_build")
  if (!/^b\d+$/.test(build))
    throw new Error(
      `llama_cpp_build must look like b1234, not ${JSON.stringify(build)}`
    )
  const commit = get("llama_cpp_commit")
  if (!/^[0-9a-f]{7,40}$/.test(commit))
    throw new Error("llama_cpp_commit must be 7 to 40 lowercase hex characters")

  const builds = sections.filter((s) => s.kind === "build").map(buildOf)
  if (builds.length === 0) throw new Error("model.lock has no [build] section")
  for (const asset of builds)
    if (!asset.asset.includes(build))
      throw new Error(
        `model.lock build ${asset.platform}: asset ${asset.asset} is not from ${build}`
      )
  const profiles = sections
    .filter((s) => s.kind === "profile")
    .map((s) => profileOf(s, "model.lock", "lock"))
  if (profiles.length === 0)
    throw new Error("model.lock has no [profile] section")
  const defaultProfile = get("default_profile")
  if (!profiles.some((p) => p.id === defaultProfile))
    throw new Error(
      `default_profile ${JSON.stringify(defaultProfile)} is not a profile in model.lock`
    )

  return {
    llamaCppBuild: build,
    llamaCppCommit: commit,
    builds,
    defaultProfile,
    profiles,
  }
}

/**
 * The user's own profiles file (`llama add` writes it): `[profile]` sections only. Throws, naming
 * the file, on anything model.lock would reject, and on a `verified` key.
 */
export function parseUserProfiles(text: string, name: string): ModelProfile[] {
  const { head, sections } = sectionsOf(text, name)
  if (head.values.size > 0 || sections.some((s) => s.kind !== "profile"))
    throw new Error(`${name} holds [profile] sections only`)
  return sections.map((s) => profileOf(s, name, "user"))
}

/** The lock with the user's profiles after its own. An id in both is an error, not an override. */
export function withUserProfiles(
  lock: ModelLock,
  user: readonly ModelProfile[],
  name: string
): ModelLock {
  for (const profile of user)
    if (lock.profiles.some((p) => p.id === profile.id))
      throw new Error(
        `${name}: profile ${profile.id} is also in model.lock; rename one of them`
      )
  return { ...lock, profiles: [...lock.profiles, ...user] }
}

/** The release asset for this platform. Throws, listing the lock's platforms, when there is none. */
export function selectBuild(lock: ModelLock, platform: string): BuildAsset {
  const asset = lock.builds.find((b) => b.platform === platform)
  if (asset === undefined)
    throw new Error(
      `model.lock has no llama.cpp build for ${platform}; it has ${lock.builds.map((b) => b.platform).join(", ")}`
    )
  return asset
}

/** The profile with this id. Throws, listing the lock's ids, when there is none. */
export function selectProfile(lock: ModelLock, id: string): ModelProfile {
  const profile = lock.profiles.find((p) => p.id === id)
  if (profile === undefined)
    throw new Error(
      `unknown model profile ${JSON.stringify(id)}; the profiles are ${lock.profiles.map((p) => p.id).join(", ")}`
    )
  return profile
}

/** The one file the launcher loads for this profile. `join` is the platform's path join. */
export const modelPathOf = (
  profile: ModelProfile,
  modelDir: string,
  join: (...parts: string[]) => string = (...parts) => posix.join(...parts)
): string =>
  profile.location.kind === "local"
    ? profile.location.path
    : join(modelDir, profile.location.file)
