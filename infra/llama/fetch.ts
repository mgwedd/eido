// `llama fetch`: installs the pinned llama.cpp build and one profile's model from the URLs in
// `infra/model.lock`, and nothing else. Each download lands in a `.partial` file, is checked
// against the lock, and only then moved into place; on a mismatch the partial file is deleted.
// What is already installed and matches is left alone, so a rerun only re-verifies. Effects are
// passed in, so tests use a fake download and never fetch a real build or model. Archives, `.tar.gz`
// on macOS and `.zip` on Windows, are unpacked with the system `tar` (bsdtar reads both, and ships
// with macOS and with Windows 10 and later).
import { serverName, type LlamaConfig } from "./config.ts"
import {
  modelPathOf,
  selectBuild,
  type ModelLock,
  type ModelProfile,
} from "./lock.ts"
import {
  verifyBuild,
  verifyModel,
  type FileProbe,
  type RunResult,
} from "./verify.ts"

export type DirEntry = { name: string; directory: boolean }

export type FetchDeps = {
  probe: FileProbe
  run: (command: string, args: readonly string[]) => Promise<RunResult>
  /** Streams the https URL into a new file at `dest`. Rejects on any HTTP or write error. */
  download: (url: string, dest: string) => Promise<void>
  fs: {
    exists: (path: string) => boolean
    mkdir: (path: string) => void
    rename: (from: string, to: string) => void
    remove: (path: string) => void
    /** Removes a directory this command created, with its contents. */
    removeTree: (path: string) => void
    list: (dir: string) => DirEntry[]
  }
  out: (line: string) => void
  err: (line: string) => void
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The directory under `root`, at most `depth` levels down, that holds the file `name`. */
export function findServerDir(
  fs: Pick<FetchDeps["fs"], "list">,
  join: LlamaConfig["join"],
  root: string,
  name: string,
  depth = 3
): string | undefined {
  const entries = fs.list(root)
  if (entries.some((e) => !e.directory && e.name === name)) return root
  if (depth === 0) return undefined
  for (const entry of entries) {
    if (!entry.directory) continue
    const found = findServerDir(
      fs,
      join,
      join(root, entry.name),
      name,
      depth - 1
    )
    if (found !== undefined) return found
  }
  return undefined
}

async function download(
  deps: FetchDeps,
  url: string,
  partial: string
): Promise<boolean> {
  if (deps.fs.exists(partial)) deps.fs.remove(partial)
  deps.out(`downloading ${url}`)
  try {
    await deps.download(url, partial)
    return true
  } catch (error) {
    if (deps.fs.exists(partial)) deps.fs.remove(partial)
    deps.err(`FAIL: download of ${url}: ${errorText(error)}`)
    return false
  }
}

/** Installs the pinned build into `config.buildDir`, unless a matching binary is already there. */
export async function fetchBuild(
  deps: FetchDeps,
  lock: ModelLock,
  config: LlamaConfig
): Promise<boolean> {
  const { binary, join } = config
  const name = serverName(config.windows)
  if (deps.fs.exists(binary)) {
    const check = await verifyBuild(binary, lock, deps.run)
    if (!check.ok) {
      deps.err(
        `FAIL: ${check.message}; fetch does not replace ${binary}: move it away and run fetch again`
      )
      return false
    }
    deps.out(`ok: ${binary} is ${lock.llamaCppBuild}, already installed`)
    return true
  }
  if (binary !== join(config.buildDir, name)) {
    deps.err(
      `FAIL: no llama-server at ${binary} (EIDO_LLAMA_SERVER_BIN); fetch installs only into ${config.buildDir}`
    )
    return false
  }

  const asset = selectBuild(lock, config.platform)
  const parent = join(config.buildDir, "..")
  const archive = join(parent, `${asset.asset}.partial`)
  const staging = join(parent, `.${lock.llamaCppBuild}.partial`)
  deps.fs.mkdir(parent)
  if (!(await download(deps, asset.source, archive))) return false
  const actual = await deps.probe.sha256(archive)
  if (actual !== asset.sha256) {
    deps.fs.remove(archive)
    deps.err(
      `FAIL: ${asset.asset}: sha256 mismatch: expected ${asset.sha256}, actual ${actual}; deleted the download`
    )
    return false
  }
  deps.out(`ok: ${asset.asset} sha256 ${actual}`)

  if (deps.fs.exists(staging)) deps.fs.removeTree(staging)
  deps.fs.mkdir(staging)
  const cleanUp = () => {
    deps.fs.removeTree(staging)
    deps.fs.remove(archive)
  }
  const untar = await deps.run("tar", ["-xf", archive, "-C", staging])
  if (untar.code !== 0) {
    cleanUp()
    deps.err(`FAIL: tar: ${untar.stderr.trim() || untar.code}`)
    return false
  }
  const found = findServerDir(deps.fs, join, staging, name)
  if (found === undefined) {
    cleanUp()
    deps.err(`FAIL: ${asset.asset} has no ${name}`)
    return false
  }
  deps.fs.rename(found, config.buildDir)
  cleanUp()
  if (!config.windows) {
    // Only this build's directory: nothing else loses its quarantine flag.
    const xattr = await deps.run("xattr", [
      "-dr",
      "com.apple.quarantine",
      config.buildDir,
    ])
    if (xattr.code !== 0) {
      deps.err(`FAIL: xattr: ${xattr.stderr.trim() || xattr.code}`)
      return false
    }
  }
  const check = await verifyBuild(binary, lock, deps.run)
  if (!check.ok) {
    deps.fs.removeTree(config.buildDir)
    deps.err(`FAIL: ${check.message}; removed ${config.buildDir}`)
    return false
  }
  deps.out(`ok: installed ${lock.llamaCppBuild} in ${config.buildDir}`)
  return true
}

/** Downloads the profile's model into the model directory, unless a matching file is there. */
export async function fetchModel(
  deps: FetchDeps,
  profile: ModelProfile,
  config: LlamaConfig
): Promise<boolean> {
  const path = modelPathOf(profile, config.modelDir, config.join)
  if ((await deps.probe.size(path)) !== undefined) {
    const check = await verifyModel(path, profile, deps.probe)
    if (!check.ok) {
      deps.err(
        `FAIL: ${check.message}; fetch does not replace an existing file: move it away and run fetch again`
      )
      return false
    }
    deps.out(`ok: ${path} matches profile ${profile.id}, already present`)
    return true
  }
  if (profile.location.kind === "local") {
    deps.err(
      `FAIL: no model file at ${path}; profile ${profile.id} is a local file, so fetch cannot download it`
    )
    return false
  }

  const partial = `${path}.partial`
  deps.fs.mkdir(config.modelDir)
  if (!(await download(deps, profile.location.source, partial))) return false
  const check = await verifyModel(partial, profile, deps.probe)
  if (!check.ok) {
    deps.fs.remove(partial)
    deps.err(`FAIL: ${check.message}; deleted the download`)
    return false
  }
  deps.fs.rename(partial, path)
  deps.out(`ok: ${path} sha256 ${check.sha256}`)
  return true
}
