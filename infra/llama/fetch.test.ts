import { posix, win32 } from "node:path"
import { describe, expect, it } from "vitest"

import { buildConfig, type Platform } from "./config.ts"
import {
  fetchBuild,
  fetchModel,
  findServerDir,
  type FetchDeps,
} from "./fetch.ts"
import { parseLock, selectProfile } from "./lock.ts"
import type { RunResult } from "./verify.ts"

const MODEL_SHA = "a".repeat(64)
const MAC_SHA = "b".repeat(64)
const WIN_SHA = "c".repeat(64)
const MAC_URL = "https://example.invalid/b100/llama-b100-bin-macos-arm64.tar.gz"
const WIN_URL = "https://example.invalid/b100/llama-b100-bin-win-vulkan-x64.zip"
const MODEL_URL = "https://example.invalid/rev/abc/example.gguf"

const lock = parseLock(`llama_cpp_build: b100
llama_cpp_commit: abcdef1
default_profile: dl

[build darwin-arm64]
asset: llama-b100-bin-macos-arm64.tar.gz
source: ${MAC_URL}
sha256: ${MAC_SHA}

[build win32-x64]
asset: llama-b100-bin-win-vulkan-x64.zip
source: ${WIN_URL}
sha256: ${WIN_SHA}

[profile dl]
model: Example
quantization: Q4_0
file: example.gguf
source: ${MODEL_URL}
size: 1234
sha256: ${MODEL_SHA}
chat_template_marker: <x>

[profile local]
model: Local
quantization: Q8_0
path: /blobs/sha256-x
size: 99
sha256: ${MODEL_SHA}
chat_template_marker: <y>
`)

const MAC: Platform = { os: "darwin", arch: "arm64" }
const WIN: Platform = { os: "win32", arch: "x64" }
const VERSION = "version: 1 (build 100, commit abcdef1)"

type Blob = { size: number; sha256: string }

type Options = {
  platform?: Platform
  env?: Record<string, string>
  /** What each URL downloads as; a URL not listed fails like a 404. */
  blobs?: Record<string, Blob>
  /** Files already on disk. */
  files?: Record<string, Blob>
  /** The archive's layout, relative to the extraction directory. */
  archive?: string[]
  runs?: Record<string, RunResult>
  version?: string
}

function harness(o: Options = {}) {
  const platform = o.platform ?? MAC
  const path = platform.os === "win32" ? win32 : posix
  const home = platform.os === "win32" ? "C:\\Users\\s" : "/Users/u"
  const env =
    o.env ??
    (platform.os === "win32"
      ? { LOCALAPPDATA: "C:\\Users\\s\\AppData\\Local" }
      : {})
  const config = buildConfig(
    env,
    home,
    "/repo/infra/model.lock",
    lock,
    platform
  )
  const files = new Map<string, Blob>(Object.entries(o.files ?? {}))
  const dirs = new Set<string>()
  const downloaded: string[] = []
  const ran: string[] = []
  const removed: string[] = []
  const out: string[] = []
  const err: string[] = []
  const under = (dir: string, p: string) => p.startsWith(dir + path.sep)

  const deps: FetchDeps = {
    probe: {
      size: (p) => Promise.resolve(files.get(p)?.size),
      sha256: (p) => Promise.resolve(files.get(p)?.sha256 ?? "0".repeat(64)),
      now: () => 0,
    },
    run: (command, args) => {
      const line = [command, ...args].join(" ")
      ran.push(line)
      if (command === config.binary && args[0] === "--version")
        return Promise.resolve({
          code: 0,
          stdout: "",
          stderr: o.version ?? VERSION,
        })
      if (command === "tar" && o.archive !== undefined) {
        const staging = args[3] ?? ""
        for (const entry of o.archive)
          files.set(path.join(staging, entry), { size: 1, sha256: "" })
        return Promise.resolve({ code: 0, stdout: "", stderr: "" })
      }
      return Promise.resolve(
        o.runs?.[line] ?? { code: 0, stdout: "", stderr: "" }
      )
    },
    download: (url, dest) => {
      downloaded.push(`${url} -> ${dest}`)
      const blob = o.blobs?.[url]
      if (blob === undefined) {
        files.set(dest, { size: 3, sha256: "" })
        return Promise.reject(new Error("HTTP 404"))
      }
      files.set(dest, blob)
      return Promise.resolve()
    },
    fs: {
      exists: (p) =>
        files.has(p) ||
        dirs.has(p) ||
        [...files.keys()].some((f) => under(p, f)),
      mkdir: (p) => void dirs.add(p),
      rename: (from, to) => {
        for (const [key, value] of [...files]) {
          if (key === from) {
            files.delete(key)
            files.set(to, value)
          } else if (under(from, key)) {
            files.delete(key)
            files.set(to + key.slice(from.length), value)
          }
        }
      },
      remove: (p) => {
        removed.push(p)
        files.delete(p)
      },
      removeTree: (p) => {
        removed.push(`${p}/`)
        for (const key of [...files.keys()])
          if (under(p, key)) files.delete(key)
      },
      list: (dir) => {
        const names = new Map<string, boolean>()
        for (const key of files.keys()) {
          if (!under(dir, key)) continue
          const rest = key.slice(dir.length + 1).split(path.sep)
          names.set(rest[0] ?? "", rest.length > 1)
        }
        return [...names].map(([name, directory]) => ({ name, directory }))
      },
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  }
  return { deps, config, files, downloaded, ran, removed, out, err }
}

describe("fetchModel", () => {
  const profile = selectProfile(lock, "dl")
  const MODEL =
    "/Users/u/Library/Application Support/eido-dev/models/example.gguf"

  it("downloads only the lock's URL into a partial file, verifies it and moves it into place", async () => {
    const h = harness({
      blobs: { [MODEL_URL]: { size: 1234, sha256: MODEL_SHA } },
    })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(true)
    expect(h.downloaded).toEqual([`${MODEL_URL} -> ${MODEL}.partial`])
    expect(h.files.get(MODEL)).toEqual({ size: 1234, sha256: MODEL_SHA })
    expect(h.files.has(`${MODEL}.partial`)).toBe(false)
    expect(h.out.at(-1)).toBe(`ok: ${MODEL} sha256 ${MODEL_SHA}`)
  })

  it("refuses a download whose hash does not match and deletes the partial file", async () => {
    const h = harness({
      blobs: { [MODEL_URL]: { size: 1234, sha256: "d".repeat(64) } },
    })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(false)
    expect(h.files.has(MODEL)).toBe(false)
    expect(h.removed).toEqual([`${MODEL}.partial`])
    expect(h.err).toEqual([
      `FAIL: ${MODEL}.partial: sha256 mismatch: expected ${MODEL_SHA}, actual ${"d".repeat(64)}; deleted the download`,
    ])
  })

  it("refuses a download of the wrong size, even with the right hash", async () => {
    const h = harness({
      blobs: { [MODEL_URL]: { size: 1000, sha256: MODEL_SHA } },
    })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(false)
    expect(h.files.has(MODEL)).toBe(false)
    expect(h.err[0]).toContain(
      "size mismatch: expected 1234 bytes, actual 1000"
    )
  })

  it("deletes the partial file when the download fails", async () => {
    const h = harness()
    expect(await fetchModel(h.deps, profile, h.config)).toBe(false)
    expect(h.files.has(`${MODEL}.partial`)).toBe(false)
    expect(h.err).toEqual([`FAIL: download of ${MODEL_URL}: HTTP 404`])
  })

  it("replaces a stale partial file from an earlier run", async () => {
    const h = harness({
      files: { [`${MODEL}.partial`]: { size: 5, sha256: "" } },
      blobs: { [MODEL_URL]: { size: 1234, sha256: MODEL_SHA } },
    })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(true)
    expect(h.removed).toEqual([`${MODEL}.partial`])
  })

  it("is idempotent: a matching file is verified and not downloaded again", async () => {
    const h = harness({ files: { [MODEL]: { size: 1234, sha256: MODEL_SHA } } })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(true)
    expect(h.downloaded).toEqual([])
    expect(h.out).toEqual([`ok: ${MODEL} matches profile dl, already present`])
  })

  it("never replaces an existing file that does not match", async () => {
    const h = harness({
      files: { [MODEL]: { size: 1234, sha256: "e".repeat(64) } },
    })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(false)
    expect(h.downloaded).toEqual([])
    expect(h.removed).toEqual([])
    expect(h.err[0]).toMatch(
      /sha256 mismatch.*fetch does not replace an existing file/
    )
  })

  it("cannot download a local-path profile and says so", async () => {
    const h = harness()
    expect(
      await fetchModel(h.deps, selectProfile(lock, "local"), h.config)
    ).toBe(false)
    expect(h.downloaded).toEqual([])
    expect(h.err).toEqual([
      "FAIL: no model file at /blobs/sha256-x; profile local is a local file, so fetch cannot download it",
    ])
  })

  it("verifies a local-path profile that is on disk", async () => {
    const h = harness({
      files: { "/blobs/sha256-x": { size: 99, sha256: MODEL_SHA } },
    })
    expect(
      await fetchModel(h.deps, selectProfile(lock, "local"), h.config)
    ).toBe(true)
  })

  it("downloads into %LOCALAPPDATA%\\eido-dev\\models on Windows", async () => {
    const h = harness({
      platform: WIN,
      blobs: { [MODEL_URL]: { size: 1234, sha256: MODEL_SHA } },
    })
    expect(await fetchModel(h.deps, profile, h.config)).toBe(true)
    expect(
      h.files.has(
        "C:\\Users\\s\\AppData\\Local\\eido-dev\\models\\example.gguf"
      )
    ).toBe(true)
  })
})

describe("fetchBuild on macOS", () => {
  const ROOT = "/Users/u/Library/Application Support/eido-dev/llama.cpp"
  const BUILD = `${ROOT}/b100`
  const ARCHIVE = `${ROOT}/llama-b100-bin-macos-arm64.tar.gz.partial`
  const STAGING = `${ROOT}/.b100.partial`
  const blobs = { [MAC_URL]: { size: 10, sha256: MAC_SHA } }

  it("downloads the darwin-arm64 asset, verifies, extracts, clears quarantine on the build dir only and checks the build", async () => {
    const h = harness({
      blobs,
      archive: ["llama-b100/llama-server", "llama-b100/libllama.dylib"],
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(true)
    expect(h.downloaded).toEqual([`${MAC_URL} -> ${ARCHIVE}`])
    expect(h.ran).toEqual([
      `tar -xf ${ARCHIVE} -C ${STAGING}`,
      `xattr -dr com.apple.quarantine ${BUILD}`,
      `${BUILD}/llama-server --version`,
    ])
    expect([...h.files.keys()].sort()).toEqual([
      `${BUILD}/libllama.dylib`,
      `${BUILD}/llama-server`,
    ])
    expect(h.out.at(-1)).toBe(`ok: installed b100 in ${BUILD}`)
  })

  it("refuses an archive whose hash does not match, deletes it and extracts nothing", async () => {
    const h = harness({
      blobs: { [MAC_URL]: { size: 10, sha256: "f".repeat(64) } },
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.ran).toEqual([])
    expect(h.files.has(ARCHIVE)).toBe(false)
    expect(h.err).toEqual([
      `FAIL: llama-b100-bin-macos-arm64.tar.gz: sha256 mismatch: expected ${MAC_SHA}, actual ${"f".repeat(64)}; deleted the download`,
    ])
  })

  it("stops on a failed download", async () => {
    const h = harness()
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.err).toEqual([`FAIL: download of ${MAC_URL}: HTTP 404`])
  })

  it("is idempotent: an installed binary of the pinned build is not downloaded again", async () => {
    const h = harness({
      files: { [`${BUILD}/llama-server`]: { size: 1, sha256: "" } },
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(true)
    expect(h.downloaded).toEqual([])
    expect(h.out).toEqual([
      `ok: ${BUILD}/llama-server is b100, already installed`,
    ])
  })

  it("never replaces an installed binary of another build", async () => {
    const h = harness({
      files: { [`${BUILD}/llama-server`]: { size: 1, sha256: "" } },
      version: "version: 1 (build 99, commit 1234567)",
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.downloaded).toEqual([])
    expect(h.err[0]).toMatch(/build mismatch.*fetch does not replace/)
  })

  it("does not install into an EIDO_LLAMA_SERVER_BIN location", async () => {
    const h = harness({
      env: { EIDO_LLAMA_SERVER_BIN: "/opt/llama-server" },
      blobs,
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.downloaded).toEqual([])
    expect(h.err[0]).toBe(
      `FAIL: no llama-server at /opt/llama-server (EIDO_LLAMA_SERVER_BIN); fetch installs only into ${BUILD}`
    )
  })

  it("cleans up after a failed extraction", async () => {
    const h = harness({
      blobs,
      runs: {
        [`tar -xf ${ARCHIVE} -C ${STAGING}`]: {
          code: 1,
          stdout: "",
          stderr: "bad archive\n",
        },
      },
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.removed).toEqual([`${STAGING}/`, ARCHIVE])
    expect(h.err).toEqual(["FAIL: tar: bad archive"])
  })

  it("cleans up when the archive has no llama-server", async () => {
    const h = harness({ blobs, archive: ["README.md"] })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.files.has(`${STAGING}/README.md`)).toBe(false)
    expect(h.err).toEqual([
      "FAIL: llama-b100-bin-macos-arm64.tar.gz has no llama-server",
    ])
  })

  it("clears a stale staging directory first", async () => {
    const h = harness({
      blobs,
      files: { [`${STAGING}/old`]: { size: 1, sha256: "" } },
      archive: ["llama-server"],
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(true)
    expect(h.removed[0]).toBe(`${STAGING}/`)
  })

  it("reports a failed xattr", async () => {
    const h = harness({
      blobs,
      archive: ["llama-server"],
      runs: {
        [`xattr -dr com.apple.quarantine ${BUILD}`]: {
          code: 1,
          stdout: "",
          stderr: "",
        },
      },
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.err).toEqual(["FAIL: xattr: 1"])
  })

  it("removes the new build directory when the binary reports another build", async () => {
    const h = harness({
      blobs,
      archive: ["llama-server"],
      version: "version: 1 (build 99, commit 1234567)",
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(false)
    expect(h.removed.at(-1)).toBe(`${BUILD}/`)
    expect(h.files.has(`${BUILD}/llama-server`)).toBe(false)
  })
})

describe("fetchBuild on Windows", () => {
  const ROOT = "C:\\Users\\s\\AppData\\Local\\eido-dev\\llama.cpp"
  const BUILD = `${ROOT}\\b100`
  const ARCHIVE = `${ROOT}\\llama-b100-bin-win-vulkan-x64.zip.partial`

  it("downloads the win32-x64 zip, extracts it with tar, skips xattr and checks llama-server.exe", async () => {
    const h = harness({
      platform: WIN,
      blobs: { [WIN_URL]: { size: 10, sha256: WIN_SHA } },
      archive: ["llama-server.exe", "ggml-vulkan.dll"],
    })
    expect(await fetchBuild(h.deps, lock, h.config)).toBe(true)
    expect(h.downloaded).toEqual([`${WIN_URL} -> ${ARCHIVE}`])
    expect(h.ran).toEqual([
      `tar -xf ${ARCHIVE} -C ${ROOT}\\.b100.partial`,
      `${BUILD}\\llama-server.exe --version`,
    ])
    expect(h.files.has(`${BUILD}\\llama-server.exe`)).toBe(true)
  })

  it("fails without a build pinned for the platform", async () => {
    const h = harness({ platform: { os: "win32", arch: "arm64" } })
    await expect(fetchBuild(h.deps, lock, h.config)).rejects.toThrow(
      "model.lock has no llama.cpp build for win32-arm64; it has darwin-arm64, win32-x64"
    )
    expect(h.downloaded).toEqual([])
  })
})

const join = (...parts: string[]) => posix.join(...parts)

describe("findServerDir", () => {
  const list = (tree: Record<string, string[]>) => ({
    list: (dir: string) =>
      (tree[dir] ?? []).map((name) => ({
        name: name.replace(/\/$/, ""),
        directory: name.endsWith("/"),
      })),
  })

  it("finds the binary a few levels down, but not deeper than the limit", () => {
    const tree = {
      "/s": ["a/"],
      "/s/a": ["b/"],
      "/s/a/b": ["llama-server"],
    }
    expect(findServerDir(list(tree), join, "/s", "llama-server")).toBe("/s/a/b")
    expect(
      findServerDir(list(tree), join, "/s", "llama-server", 1)
    ).toBeUndefined()
  })

  it("does not take a directory named like the binary", () => {
    expect(
      findServerDir(
        list({ "/s": ["llama-server/"] }),
        join,
        "/s",
        "llama-server"
      )
    ).toBeUndefined()
  })
})
