import { describe, expect, it } from "vitest"

import {
  checkRequest,
  defaultId,
  hubFile,
  profileSection,
  quantizationOf,
  resolveRevision,
} from "./hf.ts"
import type { Fetch, HttpResponse } from "./server.ts"

const REV = "0123456789abcdef0123456789abcdef01234567"
const SHA = "f".repeat(64)

const reply = (status: number, body: unknown): HttpResponse => ({
  status,
  json: () => Promise.resolve(body),
})

/** Answers by full URL and records each request with its body. */
function hub(answers: Record<string, HttpResponse>) {
  const requests: string[] = []
  const fetch: Fetch = (url, init) => {
    requests.push(
      init === undefined ? url : `${init.method} ${url} ${init.body}`
    )
    const answer = answers[url]
    return answer === undefined
      ? Promise.reject(new Error("ENOTFOUND"))
      : Promise.resolve(answer)
  }
  return { fetch, requests }
}

describe("checkRequest", () => {
  it("accepts a GGUF path in an owner/name repo, in a folder or not", () => {
    expect(() => checkRequest("org/Repo-GGUF", "m-Q4_K_M.gguf")).not.toThrow()
    expect(() => checkRequest("org/Repo.v2", "UD/m.gguf")).not.toThrow()
  })

  it.each([
    ["org", "m.gguf", 'repo must look like owner/name, not "org"'],
    ["org/r/x", "m.gguf", 'repo must look like owner/name, not "org/r/x"'],
    ["org/r", "m.bin", 'file must be a .gguf path in the repo, not "m.bin"'],
    [
      "org/r",
      "../m.gguf",
      'file must be a .gguf path in the repo, not "../m.gguf"',
    ],
    [
      "org/r",
      "a b.gguf",
      'file must be a .gguf path in the repo, not "a b.gguf"',
    ],
    [
      "org/r",
      "m-00001-of-00002.gguf",
      "m-00001-of-00002.gguf is one part of a split GGUF; a profile is a single file",
    ],
  ])("rejects %s %s", (repo, path, message) => {
    expect(() => checkRequest(repo, path)).toThrow(message)
  })
})

describe("resolveRevision", () => {
  it("takes a full commit sha as given, without asking the Hub", async () => {
    const h = hub({})
    expect(await resolveRevision(h.fetch, "org/r", REV)).toBe(REV)
    expect(h.requests).toEqual([])
  })

  it("rejects a branch name or a short sha", async () => {
    for (const revision of ["main", REV.slice(0, 7)])
      await expect(
        resolveRevision(hub({}).fetch, "org/r", revision)
      ).rejects.toThrow("--revision must be a full 40-character commit sha")
  })

  it("asks the Hub for the repo's current commit", async () => {
    const h = hub({
      "https://huggingface.co/api/models/org/r": reply(200, { sha: REV }),
    })
    expect(await resolveRevision(h.fetch, "org/r", undefined)).toBe(REV)
  })

  it("fails on an HTTP error or an answer with no sha", async () => {
    await expect(
      resolveRevision(
        hub({ "https://huggingface.co/api/models/org/r": reply(404, {}) })
          .fetch,
        "org/r",
        undefined
      )
    ).rejects.toThrow(
      "https://huggingface.co/api/models/org/r answered HTTP 404"
    )
    await expect(
      resolveRevision(
        hub({
          "https://huggingface.co/api/models/org/r": reply(200, {
            sha: "main",
          }),
        }).fetch,
        "org/r",
        undefined
      )
    ).rejects.toThrow(
      "https://huggingface.co/api/models/org/r has no commit sha"
    )
  })
})

describe("hubFile", () => {
  const url = `https://huggingface.co/api/models/org/r/paths-info/${REV}`

  it("reads the LFS size and sha256 at the revision and pins the download URL to it", async () => {
    const h = hub({
      [url]: reply(200, [
        { type: "file", path: "q/m.gguf", size: 7, lfs: { oid: SHA, size: 7 } },
      ]),
    })
    expect(await hubFile(h.fetch, "org/r", "q/m.gguf", REV)).toEqual({
      repo: "org/r",
      path: "q/m.gguf",
      revision: REV,
      size: 7,
      sha256: SHA,
      source: `https://huggingface.co/org/r/resolve/${REV}/q/m.gguf`,
    })
    expect(h.requests).toEqual([`POST ${url} {"paths":["q/m.gguf"]}`])
  })

  it("checks the request before any network call", async () => {
    const h = hub({})
    await expect(hubFile(h.fetch, "org/r", "m.txt", REV)).rejects.toThrow(
      "file must be a .gguf path"
    )
    expect(h.requests).toEqual([])
  })

  it.each([
    ["a missing file", [], `org/r has no file m.gguf at ${REV}`],
    [
      "a folder",
      [{ type: "directory", path: "m.gguf" }],
      `org/r has no file m.gguf at ${REV}`,
    ],
    [
      "a file outside LFS",
      [{ type: "file", path: "m.gguf", size: 7 }],
      "org/r/m.gguf is not stored with LFS, so the Hub reports no sha256 for it",
    ],
    [
      "a malformed oid",
      [{ type: "file", path: "m.gguf", lfs: { oid: "abc", size: 7 } }],
      "org/r/m.gguf is not stored with LFS",
    ],
    [
      "a zero size",
      [{ type: "file", path: "m.gguf", lfs: { oid: SHA, size: 0 } }],
      "org/r/m.gguf is not stored with LFS",
    ],
  ])("fails on %s", async (_name, entries, message) => {
    await expect(
      hubFile(hub({ [url]: reply(200, entries) }).fetch, "org/r", "m.gguf", REV)
    ).rejects.toThrow(message)
  })
})

describe("defaultId and quantizationOf", () => {
  it.each([
    [
      "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
      "qwen3.6-35b-a3b-ud-q4_k_m",
      "UD-Q4_K_M",
    ],
    ["sub/gpt-oss-20b-MXFP4.gguf", "gpt-oss-20b-mxfp4", "MXFP4"],
    ["Model.IQ3_XS.gguf", "model.iq3_xs", "IQ3_XS"],
    ["_Big Model-BF16.gguf", "big-model-bf16", "BF16"],
    ["plain.gguf", "plain", "plain"],
  ])("%s", (path, id, quantization) => {
    expect(defaultId(path)).toBe(id)
    expect(quantizationOf(path)).toBe(quantization)
  })
})

describe("profileSection", () => {
  const file = {
    repo: "org/r",
    path: "q/m-Q8_0.gguf",
    revision: REV,
    size: 7,
    sha256: SHA,
    source: `https://huggingface.co/org/r/resolve/${REV}/q/m-Q8_0.gguf`,
  }

  it("writes a profile with the given marker and kwargs", () => {
    expect(
      profileSection(file, {
        id: "m",
        marker: "<|im_start|>",
        kwargs: '{"a": 1}',
      })
    ).toBe(
      [
        `# llama add org/r q/m-Q8_0.gguf --revision ${REV}`,
        "[profile m]",
        "model: org/r",
        "quantization: Q8_0",
        "file: m-Q8_0.gguf",
        `source: ${file.source}`,
        "size: 7",
        `sha256: ${SHA}`,
        "chat_template_marker: <|im_start|>",
        'chat_template_kwargs: {"a": 1}',
        "",
      ].join("\n")
    )
  })

  it("names the profile after the file when no id is given, and rejects a bad id", () => {
    expect(
      profileSection(file, {
        id: undefined,
        marker: undefined,
        kwargs: undefined,
      })
    ).toContain("[profile m-q8_0]\n")
    expect(() =>
      profileSection(file, { id: "Big", marker: undefined, kwargs: undefined })
    ).toThrow(
      'profile id must be lowercase letters, digits, dots, dashes or underscores, not "Big"'
    )
  })
})
