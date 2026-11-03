// `infra/model.lock`: the one pinned model file and llama.cpp build (#29). The file is plain
// `key: value` lines; `#` starts a comment line. Every key below is required exactly once and no
// other key is accepted, so a typo fails loudly instead of being ignored.

export type ModelLock = {
  model: string
  quantization: string
  /** The file name under the model directory. Never a path: no fallback to another file. */
  file: string
  /** An https URL that ends in `/<file>`, pinned to a revision. */
  source: string
  /** Exact size in bytes. */
  size: number
  /** SHA-256 of the file, lowercase hex. */
  sha256: string
  /** The llama.cpp release tag, `b<number>`. */
  llamaCppBuild: string
  /** The commit `llama-server --version` reports for that build (short hex). */
  llamaCppCommit: string
  /** The release asset the build is installed from. */
  llamaCppAsset: string
  /** SHA-256 of that asset, lowercase hex. */
  llamaCppSha256: string
  /** A substring `/props` must report in `chat_template`, so the model's own template is loaded. */
  chatTemplateMarker: string
}

const KEYS = {
  model: "model",
  quantization: "quantization",
  file: "file",
  source: "source",
  size: "size",
  sha256: "sha256",
  llama_cpp_build: "llamaCppBuild",
  llama_cpp_commit: "llamaCppCommit",
  llama_cpp_asset: "llamaCppAsset",
  llama_cpp_sha256: "llamaCppSha256",
  chat_template_marker: "chatTemplateMarker",
} as const satisfies Record<string, keyof ModelLock>

type LockKey = keyof typeof KEYS

const isLockKey = (key: string): key is LockKey => Object.hasOwn(KEYS, key)

const SHA256 = /^[0-9a-f]{64}$/
const FILE_NAME = /^[A-Za-z0-9._-]+$/

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

/** Parses and validates the lock text. Throws an Error naming the line or key at fault. */
export function parseLock(text: string): ModelLock {
  const raw = new Map<LockKey, string>()
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon <= 0)
      throw new Error(`model.lock line ${index + 1}: expected "key: value"`)
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    if (!isLockKey(key))
      throw new Error(
        `model.lock line ${index + 1}: unknown key ${JSON.stringify(key)}`
      )
    if (raw.has(key))
      throw new Error(`model.lock line ${index + 1}: ${key} appears twice`)
    if (value === "")
      throw new Error(`model.lock line ${index + 1}: ${key} is empty`)
    raw.set(key, value)
  }
  const get = (key: LockKey): string => {
    const value = raw.get(key)
    if (value === undefined) throw new Error(`model.lock is missing ${key}`)
    return value
  }

  const file = fileName(get("file"), "file")
  const source = get("source")
  if (!source.startsWith("https://") || !source.endsWith(`/${file}`))
    throw new Error(`source must be an https URL ending in /${file}`)

  const sizeText = get("size")
  if (!/^[1-9]\d*$/.test(sizeText) || !Number.isSafeInteger(Number(sizeText)))
    throw new Error("size must be a whole number of bytes")

  const build = get("llama_cpp_build")
  if (!/^b\d+$/.test(build))
    throw new Error(
      `llama_cpp_build must look like b1234, not ${JSON.stringify(build)}`
    )
  const commit = get("llama_cpp_commit")
  if (!/^[0-9a-f]{7,40}$/.test(commit))
    throw new Error("llama_cpp_commit must be 7 to 40 lowercase hex characters")

  return {
    model: get("model"),
    quantization: get("quantization"),
    file,
    source,
    size: Number(sizeText),
    sha256: sha(get("sha256"), "sha256"),
    llamaCppBuild: build,
    llamaCppCommit: commit,
    llamaCppAsset: fileName(get("llama_cpp_asset"), "llama_cpp_asset"),
    llamaCppSha256: sha(get("llama_cpp_sha256"), "llama_cpp_sha256"),
    chatTemplateMarker: get("chat_template_marker"),
  }
}
