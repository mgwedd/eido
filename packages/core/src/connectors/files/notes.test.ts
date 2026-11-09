import { afterEach, describe, expect, it } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import { openIndex } from "../../index/index"
import { ingestBatch } from "../../index/ingest"
import {
  DEFAULT_NOTE_ROOTS,
  NOTE_MIMES,
  readNotesCoverage,
  searchLocalNotes,
  sliceNoteExcerpt,
  type LocalNoteRecord,
} from "./notes"
import { fileSourceRef } from "./reads"

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixtureDb() {
  const db = openIndex(":memory:")
  databases.push(db)
  return db
}

describe("notes constants", () => {
  it("defines standard defaults for note roots and supported mimes", () => {
    expect(DEFAULT_NOTE_ROOTS).toEqual(["notes"])
    expect(NOTE_MIMES).toEqual(["text/markdown", "text/plain"])
  })
})

describe("sliceNoteExcerpt", () => {
  const sampleNote: LocalNoteRecord = {
    sha256: "a".repeat(64),
    source: "files",
    sourceRef: fileSourceRef("notes", "ideas.md"),
    root: "notes",
    path: "ideas.md",
    mime: "text/markdown",
    title: "ideas.md",
    body: "Line 1: Introduction\nLine 2: Design notes\nLine 3: Conclusion",
    ingestedAt: "2026-11-07T12:00:00Z",
  }

  it("extracts exact verbatim text matching the body slice", () => {
    const excerpt = sliceNoteExcerpt(sampleNote, 8, 20)
    expect(excerpt.text).toBe("Introduction")
    expect(sampleNote.body.slice(8, 20)).toBe(excerpt.text)
    expect(excerpt.documentId).toBe(sampleNote.sha256)
    expect(excerpt.sourceRef).toBe(sampleNote.sourceRef)
    expect(excerpt.root).toBe("notes")
    expect(excerpt.path).toBe("ideas.md")
    expect(excerpt.fromLine).toBe(1)
    expect(excerpt.toLine).toBe(1)
  })

  it("calculates accurate 1-based start and end lines across multi-line spans", () => {
    // Span from "Design" on line 2 to "Conclusion" on line 3
    const start = sampleNote.body.indexOf("Design")
    const end = sampleNote.body.indexOf("Conclusion") + "Conclusion".length
    const excerpt = sliceNoteExcerpt(sampleNote, start, end)
    expect(excerpt.fromLine).toBe(2)
    expect(excerpt.toLine).toBe(3)
    expect(sampleNote.body.slice(start, end)).toBe(excerpt.text)
  })

  it("rejects invalid offset boundaries with RangeError", () => {
    expect(() => sliceNoteExcerpt(sampleNote, -1, 10)).toThrow(RangeError)
    expect(() =>
      sliceNoteExcerpt(sampleNote, 0, sampleNote.body.length + 1)
    ).toThrow(RangeError)
    expect(() => sliceNoteExcerpt(sampleNote, 10, 5)).toThrow(RangeError)
    expect(() => sliceNoteExcerpt(sampleNote, 10, 10)).toThrow(RangeError)
  })
})

describe("readNotesCoverage", () => {
  it("reports source_missing when no configured note root is approved or indexed", () => {
    const db = fixtureDb()
    const coverage = readNotesCoverage(db, {
      noteRoots: ["notes"],
      approvedRoots: ["docs", "downloads"],
    })
    expect(coverage.status).toBe("source_missing")
    expect(coverage.noteCount).toBe(0)
    expect(coverage.skippedCount).toBe(0)
    expect(coverage.lastSyncedAt).toBeNull()
  })

  it("reports index_stale when an approved root has never synced (no cursor)", () => {
    const db = fixtureDb()
    const coverage = readNotesCoverage(db, {
      noteRoots: ["notes"],
      approvedRoots: ["notes"],
    })
    expect(coverage.status).toBe("index_stale")
    expect(coverage.noteCount).toBe(0)
    expect(coverage.lastSyncedAt).toBeNull()
  })

  it("reports index_stale when cursor updated_at exceeds maxStaleMs", () => {
    const db = fixtureDb()
    const now = Date.parse("2026-11-07T12:00:00Z")
    const staleTime = new Date(now - 20 * 60_000).toISOString() // 20m ago

    db.prepare(
      `INSERT INTO cursors (connector, stream, cursor, updated_at)
       VALUES ('files', 'notes', ?, ?)`
    ).run(
      JSON.stringify({
        partial: false,
        indexedFiles: 5,
        noteCount: 3,
        skippedCount: 0,
      }),
      staleTime
    )

    const coverage = readNotesCoverage(db, {
      noteRoots: ["notes"],
      approvedRoots: ["notes"],
      maxStaleMs: 15 * 60_000,
      now,
    })
    expect(coverage.status).toBe("index_stale")
    expect(coverage.lastSyncedAt).toBe(staleTime)
  })

  it("reports partial_sync when scan cursor has partial: true or skippedCount > 0", () => {
    const db = fixtureDb()
    const now = Date.parse("2026-11-07T12:00:00Z")
    const recentTime = new Date(now - 2 * 60_000).toISOString() // 2m ago

    db.prepare(
      `INSERT INTO cursors (connector, stream, cursor, updated_at)
       VALUES ('files', 'notes', ?, ?)`
    ).run(
      JSON.stringify({
        partial: true,
        indexedFiles: 4,
        noteCount: 2,
        skippedCount: 1,
      }),
      recentTime
    )

    const coverage = readNotesCoverage(db, {
      noteRoots: ["notes"],
      approvedRoots: ["notes"],
      maxStaleMs: 15 * 60_000,
      now,
    })
    expect(coverage.status).toBe("partial_sync")
    expect(coverage.skippedCount).toBe(1)
    expect(coverage.lastSyncedAt).toBe(recentTime)
  })

  it("reports available when all configured note roots synced cleanly within maxStaleMs", () => {
    const db = fixtureDb()
    const now = Date.parse("2026-11-07T12:00:00Z")
    const recentTime = new Date(now - 3 * 60_000).toISOString()

    db.prepare(
      `INSERT INTO cursors (connector, stream, cursor, updated_at)
       VALUES ('files', 'notes', ?, ?)`
    ).run(
      JSON.stringify({
        partial: false,
        indexedFiles: 10,
        noteCount: 6,
        skippedCount: 0,
      }),
      recentTime
    )

    const coverage = readNotesCoverage(db, {
      noteRoots: ["notes"],
      approvedRoots: ["notes"],
      maxStaleMs: 15 * 60_000,
      now,
    })
    expect(coverage.status).toBe("available")
    expect(coverage.skippedCount).toBe(0)
    expect(coverage.lastSyncedAt).toBe(recentTime)
  })
})

describe("searchLocalNotes", () => {
  it("returns only live head records from configured note roots and excludes superseded/tombstoned", () => {
    const db = fixtureDb()
    const oldSha = "1".repeat(64)
    const newSha = "2".repeat(64)
    const tombstonedSha = "3".repeat(64)
    const otherRootSha = "4".repeat(64)
    const csvSha = "5".repeat(64)

    // Ingest old and new versions of notes/active.md
    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c1",
      documents: [
        {
          sha256: oldSha,
          source: "files",
          sourceRef: fileSourceRef("notes", "active.md"),
          mime: "text/markdown",
          title: "active.md",
          body: "Old draft content",
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "active.md"),
          sha256: oldSha,
        },
      ],
    })

    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c2",
      documents: [
        {
          sha256: newSha,
          source: "files",
          sourceRef: fileSourceRef("notes", "active.md"),
          mime: "text/markdown",
          title: "active.md",
          body: "Updated project roadmap for Q4",
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "active.md"),
          sha256: newSha,
        },
      ],
    })

    // Ingest tombstoned note
    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c3",
      documents: [
        {
          sha256: tombstonedSha,
          source: "files",
          sourceRef: fileSourceRef("notes", "deleted.md"),
          mime: "text/markdown",
          title: "deleted.md",
          body: "Roadmap details that got deleted",
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "deleted.md"),
          sha256: null,
        },
      ],
    })

    // Ingest note in non-configured root "other"
    ingestBatch(db, {
      connector: "files",
      stream: "other",
      nextCursor: "c4",
      documents: [
        {
          sha256: otherRootSha,
          source: "files",
          sourceRef: fileSourceRef("other", "foreign.md"),
          mime: "text/markdown",
          title: "foreign.md",
          body: "Roadmap in other root",
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("other", "foreign.md"),
          sha256: otherRootSha,
        },
      ],
    })

    // Ingest CSV file in notes root (non-note mime)
    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c5",
      documents: [
        {
          sha256: csvSha,
          source: "files",
          sourceRef: fileSourceRef("notes", "data.csv"),
          mime: "text/csv",
          title: "data.csv",
          body: "roadmap,10,20",
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "data.csv"),
          sha256: csvSha,
        },
      ],
    })

    const hits = searchLocalNotes(db, "roadmap", { noteRoots: ["notes"] })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sha256).toBe(newSha)
    expect(hits[0]?.path).toBe("active.md")
    expect(hits[0]?.root).toBe("notes")
    expect(hits[0]?.mime).toBe("text/markdown")
    expect(hits[0]?.excerpt).toBeDefined()
    expect(hits[0]?.excerpt?.text).toBe("roadmap")
    expect(hits[0]?.excerpt?.fromLine).toBe(1)
    expect(hits[0]?.excerpt?.toLine).toBe(1)
  })

  it("slices verbatim excerpts matching query substring with exact offsets", () => {
    const db = fixtureDb()
    const sha = "6".repeat(64)
    const body =
      "Meeting Agenda\n\nDiscussion on executive assistant features.\nAction items listed below."

    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c1",
      documents: [
        {
          sha256: sha,
          source: "files",
          sourceRef: fileSourceRef("notes", "meeting.txt"),
          mime: "text/plain",
          title: "meeting.txt",
          body,
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "meeting.txt"),
          sha256: sha,
        },
      ],
    })

    const hits = searchLocalNotes(db, "executive assistant", {
      noteRoots: ["notes"],
    })
    expect(hits).toHaveLength(1)
    const excerpt = hits[0]?.excerpt
    expect(excerpt).toBeDefined()
    expect(excerpt?.text).toBe("executive assistant")
    expect(body.slice(excerpt!.start, excerpt!.end)).toBe("executive assistant")
    expect(excerpt?.fromLine).toBe(3)
    expect(excerpt?.toLine).toBe(3)
  })
})
