import { afterEach, describe, expect, it } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import { openIndex } from "../index/index"
import { ingestBatch } from "../index/ingest"
import { fileSourceRef } from "../connectors/files/reads"
import { ask } from "./ask"
import { extractNoteSearchQuery, isDirectNoteLookup } from "./notes-lookup"
import type { AskDeps } from "./types"
import type { InferenceQueue } from "../inference/queue"
import {
  planReply,
  answerReply,
  scripted,
  type Scripted,
} from "./ask.test-support"

const databases: DatabaseSync[] = []
let model: Scripted | undefined

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await model?.server.close()
  model = undefined
})

function fixtureDb(): DatabaseSync {
  const db = openIndex(":memory:")
  databases.push(db)
  return db
}

function explodingQueue(): InferenceQueue {
  return {
    run: () => {
      throw new Error(
        "model queue should not be invoked for direct note lookup"
      )
    },
  } as unknown as InferenceQueue
}

describe("isDirectNoteLookup", () => {
  it("identifies direct retrieval questions about local notes", () => {
    const directQuestions = [
      "What have I noted about the kitchen remodel?",
      "What did I note regarding the contractor?",
      "Did I write anything down about solar panels?",
      "Have I noted anything about the dentist?",
      "What do my notes say about the budget?",
      "What's in my notes about the roof?",
      "In my notes, what did I write about taxes?",
      "Search my notes for travel checklist",
      "Look up doctor in my notes",
      "Check my notes for insurance policy",
      "Show me my notes about the vacation",
      "Notes on gardening",
      "Any notes about landscaping?",
    ]

    for (const q of directQuestions) {
      expect(isDirectNoteLookup(q), `expected direct lookup for: "${q}"`).toBe(
        true
      )
    }
  })

  it("routes synthesis, drafting, and transformation requests to the model path", () => {
    const synthesisQuestions = [
      "Summarize my notes on the remodel",
      "Summarise what my notes say about the contractor",
      "Based on my notes, draft an email to the plumber",
      "Turn my notes into a project proposal",
      "Synthesize my notes about the roof repair",
      "Compare my notes on vendor A with vendor B",
      "Explain what my notes mean",
      "Rewrite my notes into bullet points",
      "Create an action plan from my notes",
      "Format my notes as a table",
    ]

    for (const q of synthesisQuestions) {
      expect(isDirectNoteLookup(q), `expected model path for: "${q}"`).toBe(
        false
      )
    }
  })

  it("routes general non-notes questions to the model path", () => {
    expect(isDirectNoteLookup("When was the invoice paid?")).toBe(false)
    expect(isDirectNoteLookup("Who sent the flight confirmation?")).toBe(false)
    expect(isDirectNoteLookup("How many messages did Alice send?")).toBe(false)
  })
})

describe("extractNoteSearchQuery", () => {
  it("extracts clean query terms from varied phrasing", () => {
    expect(
      extractNoteSearchQuery("What have I noted about the kitchen remodel?")
    ).toBe("kitchen remodel")
    expect(
      extractNoteSearchQuery("Did I write anything down about solar panels?")
    ).toBe("solar panels")
    expect(
      extractNoteSearchQuery("Search my notes for contractor quotes")
    ).toBe("contractor quotes")
    expect(extractNoteSearchQuery("Look up dentist in my notes")).toBe(
      "dentist"
    )
    expect(
      extractNoteSearchQuery("In my notes, what did I note regarding taxes?")
    ).toBe("taxes")
    expect(extractNoteSearchQuery("Notes on travel checklist")).toBe(
      "travel checklist"
    )
    expect(extractNoteSearchQuery("What's in my notes?")).toBe("")
  })
})

describe("directNoteLookup", () => {
  const note1Sha = "1".repeat(64)
  const note2Sha = "2".repeat(64)
  const foreignSha = "3".repeat(64)

  const note1Body =
    "Kitchen Remodel Notes\n\nContractor bid is $15,000 for tile and cabinets.\nStart date is June 1st."
  const note2Body =
    "Landscaping Ideas\n\nPlant lavender and rosemary along the front walkway."
  const foreignBody = "Kitchen notes in unapproved folder"

  function seedNotes(db: DatabaseSync, nowIso = "2026-11-07T12:00:00Z") {
    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c1",
      documents: [
        {
          sha256: note1Sha,
          source: "files",
          sourceRef: fileSourceRef("notes", "kitchen.md"),
          mime: "text/markdown",
          title: "kitchen.md",
          body: note1Body,
        },
        {
          sha256: note2Sha,
          source: "files",
          sourceRef: fileSourceRef("notes", "garden.txt"),
          mime: "text/plain",
          title: "garden.txt",
          body: note2Body,
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "kitchen.md"),
          sha256: note1Sha,
        },
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "garden.txt"),
          sha256: note2Sha,
        },
      ],
    })

    // Foreign note in other root
    ingestBatch(db, {
      connector: "files",
      stream: "downloads",
      nextCursor: "c2",
      documents: [
        {
          sha256: foreignSha,
          source: "files",
          sourceRef: fileSourceRef("downloads", "kitchen-dl.md"),
          mime: "text/markdown",
          title: "kitchen-dl.md",
          body: foreignBody,
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("downloads", "kitchen-dl.md"),
          sha256: foreignSha,
        },
      ],
    })

    // Seed cursor for notes root
    db.prepare(
      `INSERT OR REPLACE INTO cursors (connector, stream, cursor, updated_at)
       VALUES ('files', 'notes', ?, ?)`
    ).run(
      JSON.stringify({
        partial: false,
        indexedFiles: 2,
        noteCount: 2,
        skippedCount: 0,
      }),
      nowIso
    )
  }

  it("returns matching verbatim excerpts with stable provenance without calling model", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")
    seedNotes(db, now.toISOString())

    const deps: AskDeps = {
      db,
      queue: explodingQueue(),
      budgetTokens: 2000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["notes"],
    }

    const result = await ask(
      "What have I noted about the kitchen remodel?",
      deps
    )

    expect(result.status).toBe("answered")
    expect(result.citations).toHaveLength(1)
    const citation = result.citations[0]!
    expect(citation.tag).toBe("[N1]")
    expect(citation.documentId).toBe(note1Sha)
    expect(citation.source).toBe("files")
    expect(citation.sourceRef).toBe(fileSourceRef("notes", "kitchen.md"))
    expect(citation.title).toBe("kitchen.md")
    expect(citation.excerpt).toBeDefined()

    // Verbatim offset verification
    const passage = citation.excerpt!.passages[0]!
    const slice = note1Body.slice(passage.start, passage.end)
    expect(slice.toLowerCase()).toContain("kitchen")

    // Unrelated notes (garden, foreign downloads) are not returned
    expect(result.citations.some((c) => c.documentId === note2Sha)).toBe(false)
    expect(result.citations.some((c) => c.documentId === foreignSha)).toBe(
      false
    )

    // Answer text quotes the excerpt
    expect(result.answer).toContain("From your local notes:")
    expect(result.answer).toContain("[N1] (kitchen.md, line 1):")
    expect(result.answer).toContain("> Kitchen Remodel")

    // Coverage details
    expect(result.coverage.searched).toBe(2)
    expect(result.coverage.matched).toBe(1)
    expect(result.coverage.label).toBe("1 match over 2 notes")
  })

  it("refuses when note source is missing (source_missing)", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")
    // Notes root is not approved and not indexed
    const deps: AskDeps = {
      db,
      queue: explodingQueue(),
      budgetTokens: 2000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["other"],
    }

    const result = await ask("What did I note about the kitchen?", deps)
    expect(result.status).toBe("refused")
    expect(result.reason).toBe("no local notes source is configured or indexed")
    expect(result.coverage.searched).toBe(0)
    expect(result.coverage.label).toBe(
      "No local notes source is configured or indexed."
    )
  })

  it("refuses when notes index is stale with 0 notes (index_stale)", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")
    // Approved notes root exists but has never synced
    const deps: AskDeps = {
      db,
      queue: explodingQueue(),
      budgetTokens: 2000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["notes"],
    }

    const result = await ask("What did I note about the kitchen?", deps)
    expect(result.status).toBe("refused")
    expect(result.reason).toBe("local notes index is not yet synced")
    expect(result.coverage.searched).toBe(0)
    expect(result.coverage.label).toBe("Local notes index is not yet synced.")
  })

  it("explicitly reports no_match over searched live notes", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")
    seedNotes(db, now.toISOString())

    const deps: AskDeps = {
      db,
      queue: explodingQueue(),
      budgetTokens: 2000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["notes"],
    }

    const result = await ask("What did I note about swimming pools?", deps)
    expect(result.status).toBe("no_match")
    expect(result.answer).toBe("No matching notes found.")
    expect(result.citations).toHaveLength(0)
    expect(result.coverage.searched).toBe(2)
    expect(result.coverage.matched).toBe(0)
    expect(result.coverage.label).toBe("0 matches over 2 notes")
  })

  it("qualifies answer and coverage when index is stale but has notes", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")
    const staleTime = new Date(now.getTime() - 30 * 60_000).toISOString()
    seedNotes(db, staleTime)

    const deps: AskDeps = {
      db,
      queue: explodingQueue(),
      budgetTokens: 2000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["notes"],
      maxNotesStaleMs: 15 * 60_000,
    }

    const result = await ask("What did I note about kitchen?", deps)
    expect(result.status).toBe("answered")
    expect(result.answer).toContain(`index stale since ${staleTime}`)
    expect(result.coverage.label).toContain(`index stale since ${staleTime}`)
  })

  it("qualifies answer and coverage when notes sync was partial", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")

    ingestBatch(db, {
      connector: "files",
      stream: "notes",
      nextCursor: "c1",
      documents: [
        {
          sha256: note1Sha,
          source: "files",
          sourceRef: fileSourceRef("notes", "kitchen.md"),
          mime: "text/markdown",
          title: "kitchen.md",
          body: note1Body,
        },
      ],
      heads: [
        {
          source: "files",
          sourceRef: fileSourceRef("notes", "kitchen.md"),
          sha256: note1Sha,
        },
      ],
    })

    db.prepare(
      `INSERT OR REPLACE INTO cursors (connector, stream, cursor, updated_at)
       VALUES ('files', 'notes', ?, ?)`
    ).run(
      JSON.stringify({
        partial: true,
        indexedFiles: 1,
        noteCount: 1,
        skippedCount: 2,
      }),
      now.toISOString()
    )

    const deps: AskDeps = {
      db,
      queue: explodingQueue(),
      budgetTokens: 2000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["notes"],
    }

    const result = await ask("What did I note about kitchen?", deps)
    expect(result.status).toBe("answered")
    expect(result.answer).toContain("partial sync: 2 skipped")
    expect(result.coverage.label).toContain("partial sync: 2 skipped")
  })

  it("routes synthesis requests through the model path and respects context cap", async () => {
    const db = fixtureDb()
    const now = new Date("2026-11-07T12:00:00Z")
    seedNotes(db, now.toISOString())

    model = await scripted([
      planReply({ terms: ["kitchen"], wants: "summarize" }),
      answerReply("The kitchen project involves cabinets and tile [M1]."),
    ])

    const deps: AskDeps = {
      db,
      queue: model.queue,
      budgetTokens: 3000,
      now: () => now,
      noteRoots: ["notes"],
      approvedNoteRoots: ["notes"],
    }

    const result = await ask("Summarize my notes on the kitchen remodel", deps)
    expect(result.status).toBe("answered")
    expect(result.answer).toContain("The kitchen project involves cabinets")
    expect(model.completions()).toBe(2)
  })
})
