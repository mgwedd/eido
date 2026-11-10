import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { FileClient, IntentClient } from "@eido/gate"
import type { GateFileHelperResponse, GateFileRoots } from "@eido/schemas"
import { openIndex } from "../../index/index"
import { search } from "../../index/search"
import { textPdf } from "../../parsers/fixtures.test-support"
import { createParser } from "../../parsers/parse-document"
import { createFilesFacade, fileSourceRef } from "./reads"
import type { FileRootSyncCursor } from "./notes"

const databases: DatabaseSync[] = []
const dataDirs: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const dir of dataDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const encoded = (text: string) => Buffer.from(text, "utf8")
const ROOTS: GateFileRoots = {
  roots: [
    {
      id: "docs",
      root: {
        path: "/synthetic/docs",
        dev: "1",
        ino: "10",
        trashDir: ".eido-trash",
      },
    },
    {
      id: "other",
      root: {
        path: "/synthetic/other",
        dev: "1",
        ino: "11",
        trashDir: ".eido-trash",
      },
    },
  ],
}

/** A real data dir, so PDFs go through the real sandboxed child as in the data plane. */
function dataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "eido-files-")))
  dataDirs.push(dir)
  return dir
}

// The parser's private scratch is unsupported on Windows; there the facade gets no parser.
const SANDBOX = process.platform !== "win32"

function fixture(sandboxed = SANDBOX) {
  const db = openIndex(":memory:")
  databases.push(db)
  const trees = new Map<string, Map<string, Uint8Array>>([
    ["docs", new Map()],
    ["other", new Map()],
  ])
  const roots = vi.fn<FileClient["roots"]>().mockResolvedValue(ROOTS)
  const perform = vi.fn<FileClient["perform"]>((request) => {
    const tree = trees.get(request.root)
    if (tree === undefined)
      return Promise.resolve({
        ok: false,
        code: "invalid_path",
        message: "refused",
      })
    if (request.op === "read") {
      const bytes = tree.get(request.path)
      if (bytes === undefined)
        return Promise.resolve({
          ok: false,
          code: "not_found",
          message: "missing",
        })
      if (bytes.byteLength > request.maxBytes)
        return Promise.resolve({ ok: false, code: "io", message: "too large" })
      return Promise.resolve({
        ok: true,
        op: "read",
        contentBase64: Buffer.from(bytes).toString("base64"),
      })
    }
    const prefix = request.path === "" ? "" : `${request.path}/`
    const names = new Map<string, "file" | "directory">()
    for (const path of tree.keys()) {
      if (!path.startsWith(prefix)) continue
      const relative = path.slice(prefix.length)
      const name = relative.split("/")[0]
      if (name !== undefined)
        names.set(name, relative.includes("/") ? "directory" : "file")
    }
    return Promise.resolve({
      ok: true,
      op: "list",
      entries: [...names].map(([name, kind]) => ({ name, kind })),
      truncated: false,
    })
  })
  const propose = vi
    .fn<IntentClient["propose"]>()
    .mockResolvedValue({ id: "file-intent", tier: "auto", state: "approved" })
  const facade = createFilesFacade({
    db,
    files: { roots, perform },
    intents: { propose },
    parser: sandboxed ? createParser({ dataDir: dataDir() }) : undefined,
  })
  const docs = trees.get("docs")
  const other = trees.get("other")
  if (!docs || !other) throw new Error("missing fixture root")
  return { db, facade, perform, roots, propose, docs, other }
}

describe("allowed local file reads and indexing", () => {
  it("reads UTF-8 text only through the gate and marks it untrusted", async () => {
    const f = fixture()
    f.docs.set("note.md", encoded("Café synthetic note"))
    await expect(
      f.facade.file_read_text({ root: "docs", path: "note.md" })
    ).resolves.toEqual({ text: "Café synthetic note", untrusted: true })
    expect(f.perform.mock.calls).toEqual([
      [{ op: "read", root: "docs", path: "note.md", maxBytes: 8388608 }],
    ])
    expect(f.propose).not.toHaveBeenCalled()
  })

  // The sandboxed case spawns the parse child twice; the in-process case is the Windows path.
  it.each(
    [
      { name: "in the sandboxed child", sandboxed: true },
      { name: "in process without a parser", sandboxed: false },
    ].filter((row) => !row.sandboxed || SANDBOX)
  )(
    "extracts text from a generated PDF and rejects a corrupt one with a typed error $name",
    async ({ sandboxed }) => {
      const f = fixture(sandboxed)
      f.docs.set("agenda.pdf", textPdf([["Synthetic agenda", "First session"]]))
      await expect(
        f.facade.file_read_pdf_text({ root: "docs", path: "agenda.pdf" })
      ).resolves.toEqual({
        text: "Synthetic agenda\nFirst session",
        untrusted: true,
      })
      f.docs.set("broken.pdf", encoded("not a PDF"))
      await expect(
        f.facade.file_read_pdf_text({ root: "docs", path: "broken.pdf" })
      ).rejects.toMatchObject({ code: "invalid_pdf" })
    },
    30_000
  )

  it("rejects invalid UTF-8, noncanonical base64 and oversized reads", async () => {
    const f = fixture()
    f.docs.set("binary.txt", new Uint8Array([255]))
    await expect(
      f.facade.file_read_text({ root: "docs", path: "binary.txt" })
    ).rejects.toMatchObject({ code: "invalid_text" })
    f.perform.mockResolvedValue({ ok: true, op: "read", contentBase64: "YQ" })
    await expect(
      f.facade.file_read_text({ root: "docs", path: "file.txt" })
    ).rejects.toMatchObject({ code: "read_failed" })
    f.perform.mockResolvedValue({
      ok: true,
      op: "read",
      contentBase64: Buffer.alloc(8388609).toString("base64"),
    })
    await expect(
      f.facade.file_read_text({ root: "docs", path: "file.txt" })
    ).rejects.toMatchObject({ code: "read_failed" })
  })

  it.each([
    "/outside/file.txt",
    "../file.txt",
    "C:/file.txt",
    "\\\\host\\share\\file.txt",
    "nested/../file.txt",
  ])(
    "rejects outside or aliased read paths %j before any gate call",
    async (path) => {
      const f = fixture()
      for (const read of ["file_read_text", "file_read_pdf_text"] as const)
        await expect(
          f.facade[read]({ root: "docs", path })
        ).rejects.toMatchObject({
          code: "path_not_allowed",
        })
      expect(f.perform).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    [],
    {},
    { root: "docs", path: "note.txt", extra: true },
    { root: "docs", path: 12 },
  ])("validates unknown read arguments %j", async (args) => {
    const f = fixture()
    await expect(f.facade.file_read_text(args)).rejects.toMatchObject({
      code: "invalid_payload",
    })
    expect(f.perform).not.toHaveBeenCalled()
  })

  it.each([
    [
      new GateRequestError(403, "forbidden", "private error"),
      "path_not_allowed",
    ],
    [new GateRequestError(404, "not_found", "private error"), "not_found"],
    [new GateRequestError(503, "unavailable", "private error"), "read_failed"],
    [new GateUnavailableError("private error"), "read_failed"],
  ] as const)(
    "maps %s into %s without exposing gate errors",
    async (failure, code) => {
      const f = fixture()
      f.perform.mockRejectedValue(failure)
      await expect(
        f.facade.file_read_text({ root: "docs", path: "note.txt" })
      ).rejects.toMatchObject({ code, message: code })
      expect(f.perform).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ["invalid_path", "path_not_allowed"],
    ["symlink", "path_not_allowed"],
    ["root_changed", "path_not_allowed"],
    ["not_found", "not_found"],
    ["io", "read_failed"],
  ] as const)("maps helper refusal %s to %s", async (helperCode, code) => {
    const f = fixture()
    f.perform.mockResolvedValue({
      ok: false,
      code: helperCode,
      message: "private error",
    })
    await expect(
      f.facade.file_read_text({ root: "docs", path: "note.txt" })
    ).rejects.toMatchObject({ code, message: code })
  })

  it("searches names and indexed text, scopes hits to the selected root and avoids duplicates", async () => {
    const f = fixture()
    f.docs.set("Quarterly-report.txt", encoded("Ordinary body"))
    f.docs.set("nested/notes.md", encoded("Quarterly agenda"))
    f.docs.set("irrelevant.txt", encoded("Unrelated details"))
    f.other.set("other.txt", encoded("Quarterly elsewhere"))
    await f.facade.sync("other")
    const found = await f.facade.files_search("quarterly", { root: "docs" })
    expect(found.coverage).toBe("complete")
    expect(
      found.hits.map(({ root, path, untrusted }) => ({ root, path, untrusted }))
    ).toEqual([
      { root: "docs", path: "Quarterly-report.txt", untrusted: true },
      { root: "docs", path: "nested/notes.md", untrusted: true },
    ])
    await f.facade.sync("docs")
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM documents WHERE source='files'")
        .get()?.["n"]
    ).toBe(4)
    expect(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM document_heads WHERE source='files'"
        )
        .get()?.["n"]
    ).toBe(4)
  })

  it("updates and tombstones index heads without leaving stale searchable content", async () => {
    const f = fixture()
    f.docs.set("note.txt", encoded("Oldversion content"))
    await f.facade.sync("docs")
    f.docs.set("note.txt", encoded("Newversion content"))
    await f.facade.sync("docs")
    expect(search(f.db, { text: "Oldversion", source: "files" })).toEqual([])
    expect(
      search(f.db, { text: "Newversion", source: "files" }).map(
        (hit) => hit.sourceRef
      )
    ).toEqual([fileSourceRef("docs", "note.txt")])
    f.docs.delete("note.txt")
    await f.facade.sync("docs")
    expect(search(f.db, { text: "Newversion", source: "files" })).toEqual([])
    expect(
      f.db
        .prepare(
          "SELECT sha256 FROM document_heads WHERE source='files' AND source_ref=?"
        )
        .get(fileSourceRef("docs", "note.txt"))?.["sha256"]
    ).toBeNull()
  })

  it("marks truncated scans partial and removes old content for a file whose read failed", async () => {
    const f = fixture()
    f.docs.set("note.txt", encoded("Oldversion content"))
    await f.facade.sync("docs")
    const real = f.perform.getMockImplementation()
    if (!real) throw new Error("missing mock implementation")
    f.perform.mockImplementation((request) =>
      request.op === "read"
        ? Promise.resolve({ ok: false, code: "io", message: "refused" })
        : real(request)
    )
    await expect(f.facade.sync("docs")).resolves.toMatchObject({
      documents: [],
      coverage: "partial",
    })
    expect(search(f.db, { text: "Oldversion", source: "files" })).toEqual([])
    f.perform.mockResolvedValue({
      ok: true,
      op: "list",
      entries: [],
      truncated: true,
    })
    await expect(
      f.facade.files_search("anything", { root: "docs" })
    ).resolves.toEqual({ hits: [], coverage: "partial" })
  })

  it("preserves unseen index heads when a nested directory cannot be scanned", async () => {
    const f = fixture()
    f.docs.set("nested/note.txt", encoded("Preserved history"))
    await f.facade.sync("docs")
    const real = f.perform.getMockImplementation()
    if (!real) throw new Error("missing mock implementation")
    f.perform.mockImplementation((request) =>
      request.op === "list" && request.path === "nested"
        ? Promise.reject(new Error("unavailable"))
        : real(request)
    )
    await expect(f.facade.sync("docs")).resolves.toMatchObject({
      coverage: "partial",
    })
    expect(
      search(f.db, { text: "Preserved", source: "files" }).map(
        (hit) => hit.sourceRef
      )
    ).toEqual([fileSourceRef("docs", "nested/note.txt")])
    await expect(
      f.facade.files_search("Preserved", { root: "docs" })
    ).resolves.toEqual({ hits: [], coverage: "partial" })
  })

  it("requires a currently approved root for search and forwards writes as proposals only", async () => {
    const f = fixture()
    await expect(f.facade.sync("unknown")).rejects.toMatchObject({
      code: "path_not_allowed",
    })
    expect(f.perform).not.toHaveBeenCalled()
    await f.facade.file_rename({
      root: "docs",
      path: "file.txt",
      newName: "renamed.txt",
    })
    expect(f.propose.mock.calls).toEqual([
      [
        {
          intent: {
            kind: "file.rename",
            args: { root: "docs", path: "file.txt", newName: "renamed.txt" },
          },
          origin: "reactive",
        },
      ],
    ])
    await expect(
      f.facade.file_move({
        root: "docs",
        path: "file.txt",
        toPath: "../outside.txt",
      })
    ).rejects.toMatchObject({ code: "path_not_allowed" })
    expect(f.propose).toHaveBeenCalledTimes(1)
  })

  it("normalizes text bodies to NFC and \\n in file_read_text and performScan", async () => {
    const f = fixture()
    // Decomposed e + combining acute: e\u0301 (NFD) and \r\n line breaks
    const nfdText = "Cafe\u0301\r\nSecond line\rThird line"
    f.docs.set("note.md", encoded(nfdText))
    const read = await f.facade.file_read_text({
      root: "docs",
      path: "note.md",
    })
    expect(read.text).toBe("Café\nSecond line\nThird line")

    await f.facade.sync("docs")
    const docRow = f.db
      .prepare(
        "SELECT body FROM document_text WHERE sha256 = (SELECT sha256 FROM document_heads WHERE source_ref = ?)"
      )
      .get(fileSourceRef("docs", "note.md")) as { body: string }
    expect(docRow.body).toBe("Café\nSecond line\nThird line")
  })

  it("classifies file MIME types correctly and records detailed cursor state", async () => {
    const f = fixture()
    f.docs.set("doc.md", encoded("# Markdown"))
    f.docs.set("guide.markdown", encoded("# Full Markdown"))
    f.docs.set("plain.txt", encoded("Plain text"))
    f.docs.set("table.csv", encoded("a,b,c"))
    f.docs.set("config.json", encoded('{"key":"value"}'))
    f.docs.set("page.html", encoded("<html></html>"))
    f.docs.set("page.htm", encoded("<htm></htm>"))
    f.docs.set("cal.ics", encoded("BEGIN:VCALENDAR"))
    f.docs.set("deploy.yaml", encoded("key: value"))
    f.docs.set("deploy.yml", encoded("key: value"))
    f.docs.set("app.log", encoded("2026-11-07 INFO"))
    f.docs.set("image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    const result = await f.facade.sync("docs")
    expect(result.coverage).toBe("complete")

    const rows = f.db
      .prepare(
        "SELECT t.title, d.mime FROM documents d JOIN document_text t ON t.sha256 = d.sha256 WHERE d.source = 'files'"
      )
      .all() as { title: string; mime: string }[]
    const mimeMap = new Map(rows.map((r) => [r.title, r.mime]))

    expect(mimeMap.get("doc.md")).toBe("text/markdown")
    expect(mimeMap.get("guide.markdown")).toBe("text/markdown")
    expect(mimeMap.get("plain.txt")).toBe("text/plain")
    expect(mimeMap.get("table.csv")).toBe("text/csv")
    expect(mimeMap.get("config.json")).toBe("application/json")
    expect(mimeMap.get("page.html")).toBe("text/html")
    expect(mimeMap.get("page.htm")).toBe("text/html")
    expect(mimeMap.get("cal.ics")).toBe("text/calendar")
    expect(mimeMap.get("deploy.yaml")).toBe("application/yaml")
    expect(mimeMap.get("deploy.yml")).toBe("application/yaml")
    expect(mimeMap.get("app.log")).toBe("text/x-log")
    expect(mimeMap.get("image.png")).toBe("application/octet-stream")

    // Verify cursor stored in cursors table
    const cursorRow = f.db
      .prepare(
        "SELECT cursor FROM cursors WHERE connector = 'files' AND stream = 'docs'"
      )
      .get() as { cursor: string }
    const cursor = JSON.parse(cursorRow.cursor) as FileRootSyncCursor
    expect(cursor).toEqual({
      partial: false,
      indexedFiles: 12,
      noteCount: 3, // doc.md, guide.markdown, plain.txt
      skippedCount: 0,
    })
  })

  it("rejects a helper operation mismatch and invalid search text", async () => {
    const f = fixture()
    const response: GateFileHelperResponse = {
      ok: true,
      op: "list",
      entries: [],
      truncated: false,
    }
    f.perform.mockResolvedValue(response)
    await expect(
      f.facade.file_read_text({ root: "docs", path: "file.txt" })
    ).rejects.toMatchObject({ code: "read_failed" })
    await expect(
      f.facade.files_search("x".repeat(2001), { root: "docs" })
    ).rejects.toMatchObject({ code: "invalid_payload" })
  })
})
