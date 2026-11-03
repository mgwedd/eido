import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  parseVersion,
  sha256File,
  verifyBuild,
  verifyModel,
  type FileProbe,
  type RunResult,
} from "./verify.ts"

const GOOD = "a".repeat(64)
const BAD = "c".repeat(64)

function probe(
  size: number | undefined,
  digest: string
): FileProbe & { hashed: string[] } {
  const hashed: string[] = []
  let t = 0
  return {
    hashed,
    size: () => Promise.resolve(size),
    sha256: (path) => {
      hashed.push(path)
      return Promise.resolve(digest)
    },
    now: () => (t += 1500),
  }
}

describe("sha256File", () => {
  it("hashes the file's bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eido-sha-"))
    writeFileSync(join(dir, "f"), "abc")
    // FIPS 180-2 test vector for "abc".
    expect(await sha256File(join(dir, "f"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("rejects when the file cannot be read", async () => {
    await expect(sha256File("/nonexistent/eido/file")).rejects.toThrow(/ENOENT/)
  })
})

describe("verifyModel", () => {
  const lock = { size: 10, sha256: GOOD }

  it("passes a file with the pinned size and digest and reports the hash time", async () => {
    expect(await verifyModel("/m/x.gguf", lock, probe(10, GOOD))).toEqual({
      ok: true,
      path: "/m/x.gguf",
      sha256: GOOD,
      hashMs: 1500,
    })
  })

  it("names the expected and actual digest on a mismatch", async () => {
    const result = await verifyModel("/m/x.gguf", lock, probe(10, BAD))
    expect(result).toEqual({
      ok: false,
      path: "/m/x.gguf",
      message: `/m/x.gguf: sha256 mismatch: expected ${GOOD}, actual ${BAD}`,
    })
  })

  it("still hashes a file of the wrong size, so both digests are logged", async () => {
    const p = probe(9, BAD)
    const result = await verifyModel("/m/x.gguf", lock, p)
    expect(p.hashed).toEqual(["/m/x.gguf"])
    expect(result.ok === false && result.message).toBe(
      `/m/x.gguf: sha256 mismatch: expected ${GOOD}, actual ${BAD}; size mismatch: expected 10 bytes, actual 9`
    )
  })

  it("fails on a size mismatch even when the digest matches", async () => {
    const result = await verifyModel("/m/x.gguf", lock, probe(11, GOOD))
    expect(result.ok === false && result.message).toBe(
      "/m/x.gguf: size mismatch: expected 10 bytes, actual 11"
    )
  })

  it("fails without hashing when there is no file", async () => {
    const p = probe(undefined, GOOD)
    expect(await verifyModel("/m/x.gguf", lock, p)).toEqual({
      ok: false,
      path: "/m/x.gguf",
      message: "no model file at /m/x.gguf",
    })
    expect(p.hashed).toEqual([])
  })
})

const BANNER =
  "0.00.000.508 I srv  llama_server: initializing ...\nversion: 0.5.0-dev (build 11149, commit d2e54583c)\nbuilt with AppleClang for Darwin arm64\n"

describe("parseVersion", () => {
  it("reads the build and commit from the banner", () => {
    expect(parseVersion(BANNER)).toEqual({
      build: "b11149",
      commit: "d2e54583c",
    })
  })

  it("returns undefined for output without a build", () => {
    expect(parseVersion("llama-server: unknown option")).toBeUndefined()
  })
})

describe("verifyBuild", () => {
  const lock = { llamaCppBuild: "b11149", llamaCppCommit: "d2e54583c" }
  const runner =
    (result: RunResult) => (command: string, args: readonly string[]) => {
      expect([command, ...args]).toEqual(["/bin/llama-server", "--version"])
      return Promise.resolve(result)
    }

  it("passes when the binary reports the pinned build on stderr", async () => {
    expect(
      await verifyBuild(
        "/bin/llama-server",
        lock,
        runner({ code: 0, stdout: "", stderr: BANNER })
      )
    ).toEqual({ ok: true })
  })

  it("accepts a longer commit hash that starts with the pinned one", async () => {
    const stdout = "version: 1 (build 11149, commit d2e54583cabc)"
    expect(
      await verifyBuild(
        "/bin/llama-server",
        lock,
        runner({ code: 0, stdout, stderr: "" })
      )
    ).toEqual({ ok: true })
  })

  it("fails on another build", async () => {
    const stdout = "version: 1 (build 11150, commit d2e54583c)"
    expect(
      await verifyBuild(
        "/bin/llama-server",
        lock,
        runner({ code: 0, stdout, stderr: "" })
      )
    ).toEqual({
      ok: false,
      message:
        "llama-server build mismatch: expected b11149 (d2e54583c), actual b11150 (d2e54583c)",
    })
  })

  it("fails on the same build number from another commit", async () => {
    const stdout = "version: 1 (build 11149, commit 1234567)"
    const result = await verifyBuild(
      "/bin/llama-server",
      lock,
      runner({ code: 0, stdout, stderr: "" })
    )
    expect(result.ok).toBe(false)
  })

  it("fails when --version exits non-zero", async () => {
    expect(
      await verifyBuild(
        "/bin/llama-server",
        lock,
        runner({ code: 127, stdout: "", stderr: BANNER })
      )
    ).toEqual({
      ok: false,
      message: "/bin/llama-server --version did not report a build (exit 127)",
    })
  })
})
