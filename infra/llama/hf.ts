// `llama add`: turns a Hugging Face repo and file into a profile, with the size and sha256 the Hub
// reports for that file at a pinned revision (its LFS size and oid), so nobody hashes a model by
// hand. The default revision is the repo's current commit. Requests go through an injected fetch.
import { PROFILE_ID } from "./lock.ts"
import type { Fetch } from "./server.ts"

export const HF = "https://huggingface.co"

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const SEGMENT = /^[A-Za-z0-9._-]+$/
const REVISION = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const SPLIT = /-\d{5}-of-\d{5}\.gguf$/

export type HubFile = {
  repo: string
  /** The path in the repo, which may sit in a folder. */
  path: string
  revision: string
  size: number
  sha256: string
  /** The download URL, pinned to the revision. */
  source: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Throws unless `repo` is `owner/name` and `path` a single-file GGUF inside it. */
export function checkRequest(repo: string, path: string): void {
  if (!REPO.test(repo))
    throw new Error(
      `repo must look like owner/name, not ${JSON.stringify(repo)}`
    )
  const segments = path.split("/")
  if (
    !path.endsWith(".gguf") ||
    segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")
  )
    throw new Error(
      `file must be a .gguf path in the repo, not ${JSON.stringify(path)}`
    )
  if (SPLIT.test(path))
    throw new Error(
      `${path} is one part of a split GGUF; a profile is a single file`
    )
}

async function getJson(
  fetch: Fetch,
  url: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : { method: "POST", body: JSON.stringify(body) }
  )
  if (response.status !== 200)
    throw new Error(`${url} answered HTTP ${response.status}`)
  return response.json()
}

/** The repo's current commit, or `revision` after checking it is a full commit sha. */
export async function resolveRevision(
  fetch: Fetch,
  repo: string,
  revision: string | undefined
): Promise<string> {
  if (revision !== undefined) {
    if (!REVISION.test(revision))
      throw new Error("--revision must be a full 40-character commit sha")
    return revision
  }
  const info = await getJson(fetch, `${HF}/api/models/${repo}`)
  const sha = isRecord(info) ? info["sha"] : undefined
  if (typeof sha !== "string" || !REVISION.test(sha))
    throw new Error(`${HF}/api/models/${repo} has no commit sha`)
  return sha
}

/** The file's size and sha256 at the revision, from the Hub's paths-info API. */
export async function hubFile(
  fetch: Fetch,
  repo: string,
  path: string,
  revision: string | undefined
): Promise<HubFile> {
  checkRequest(repo, path)
  const at = await resolveRevision(fetch, repo, revision)
  const url = `${HF}/api/models/${repo}/paths-info/${at}`
  const entries = await getJson(fetch, url, { paths: [path] })
  const list: readonly unknown[] = Array.isArray(entries) ? entries : []
  const entry = list.find((e) => isRecord(e) && e["path"] === path)
  if (!isRecord(entry) || entry["type"] !== "file")
    throw new Error(`${repo} has no file ${path} at ${at}`)
  const lfs = entry["lfs"]
  const size = isRecord(lfs) ? lfs["size"] : undefined
  const sha256 = isRecord(lfs) ? lfs["oid"] : undefined
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256)
  )
    throw new Error(
      `${repo}/${path} is not stored with LFS, so the Hub reports no sha256 for it`
    )
  return {
    repo,
    path,
    revision: at,
    size,
    sha256,
    source: `${HF}/${repo}/resolve/${at}/${path}`,
  }
}

const fileName = (path: string): string => path.split("/").at(-1) ?? path

/** A profile id from the file name: lowercase, `.gguf` dropped, other characters as dashes. */
export function defaultId(path: string): string {
  return fileName(path)
    .replace(/\.gguf$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
}

/** The quantization named in the file name, such as `UD-Q4_K_M` or `MXFP4`, else the whole name. */
export function quantizationOf(path: string): string {
  const stem = fileName(path).replace(/\.gguf$/, "")
  const match =
    /(?:^|[-_.])((?:UD-)?(?:I?Q\d[A-Za-z0-9_]*|MXFP4|BF16|F16|F32))$/i.exec(
      stem
    )
  return match?.[1] ?? stem
}

export type AddOptions = {
  id: string | undefined
  marker: string | undefined
  kwargs: string | undefined
}

/** The `[profile]` section `llama add` appends to the user's profiles file. */
export function profileSection(file: HubFile, options: AddOptions): string {
  const id = options.id ?? defaultId(file.path)
  if (!PROFILE_ID.test(id))
    throw new Error(
      `profile id must be lowercase letters, digits, dots, dashes or underscores, not ${JSON.stringify(id)}`
    )
  const lines = [
    `# llama add ${file.repo} ${file.path} --revision ${file.revision}`,
    `[profile ${id}]`,
    `model: ${file.repo}`,
    `quantization: ${quantizationOf(file.path)}`,
    `file: ${fileName(file.path)}`,
    `source: ${file.source}`,
    `size: ${file.size}`,
    `sha256: ${file.sha256}`,
    ...(options.marker === undefined
      ? []
      : [`chat_template_marker: ${options.marker}`]),
    ...(options.kwargs === undefined
      ? []
      : [`chat_template_kwargs: ${options.kwargs}`]),
  ]
  return `${lines.join("\n")}\n`
}
