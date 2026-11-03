// Checks a model file and a llama-server binary against `infra/model.lock`. The checks take their
// effects (stat, hash, run) as arguments, so tests need no real model or binary.
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

import type { ModelLock } from "./lock.ts"

export type RunResult = { code: number; stdout: string; stderr: string }

export type FileProbe = {
  /** The file's size in bytes, or undefined when there is no regular file at the path. */
  size: (path: string) => Promise<number | undefined>
  sha256: (path: string) => Promise<string>
  now: () => number
}

export type ModelCheck =
  | { ok: true; path: string; sha256: string; hashMs: number }
  | { ok: false; path: string; message: string }

/** Streams the file through SHA-256 and returns lowercase hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
  })
}

/**
 * The model file must exist, have the pinned size and the pinned SHA-256. The file is hashed even
 * when the size is wrong, so the failure always names the expected and the actual digest.
 */
export async function verifyModel(
  path: string,
  lock: Pick<ModelLock, "size" | "sha256">,
  probe: FileProbe
): Promise<ModelCheck> {
  const size = await probe.size(path)
  if (size === undefined)
    return { ok: false, path, message: `no model file at ${path}` }
  const started = probe.now()
  const actual = await probe.sha256(path)
  const hashMs = probe.now() - started
  const problems: string[] = []
  if (actual !== lock.sha256)
    problems.push(`sha256 mismatch: expected ${lock.sha256}, actual ${actual}`)
  if (size !== lock.size)
    problems.push(`size mismatch: expected ${lock.size} bytes, actual ${size}`)
  if (problems.length > 0)
    return { ok: false, path, message: `${path}: ${problems.join("; ")}` }
  return { ok: true, path, sha256: actual, hashMs }
}

export type BuildInfo = { build: string; commit: string }

/** Reads `version: 0.5.0-dev (build 11149, commit d2e54583c)` from `llama-server --version`. */
export function parseVersion(output: string): BuildInfo | undefined {
  const match = /\(build (\d+), commit ([0-9a-f]{7,40})\)/.exec(output)
  if (match === null) return undefined
  const [, build = "", commit = ""] = match
  return { build: `b${build}`, commit }
}

export type BuildCheck = { ok: true } | { ok: false; message: string }

/** The binary must report the pinned build and commit. */
export async function verifyBuild(
  binary: string,
  lock: Pick<ModelLock, "llamaCppBuild" | "llamaCppCommit">,
  run: (command: string, args: readonly string[]) => Promise<RunResult>
): Promise<BuildCheck> {
  const result = await run(binary, ["--version"])
  // llama-server prints its version banner on stderr.
  const info = parseVersion(`${result.stdout}\n${result.stderr}`)
  if (result.code !== 0 || info === undefined)
    return {
      ok: false,
      message: `${binary} --version did not report a build (exit ${result.code})`,
    }
  const expected = `${lock.llamaCppBuild} (${lock.llamaCppCommit})`
  const actual = `${info.build} (${info.commit})`
  // Either commit may be the shorter abbreviation of the same hash.
  const sameCommit =
    info.commit.startsWith(lock.llamaCppCommit) ||
    lock.llamaCppCommit.startsWith(info.commit)
  if (info.build !== lock.llamaCppBuild || !sameCommit)
    return {
      ok: false,
      message: `llama-server build mismatch: expected ${expected}, actual ${actual}`,
    }
  return { ok: true }
}
