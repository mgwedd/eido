import type { DatabaseSync } from "node:sqlite"
import { createModelClient } from "../inference/client"
import { startStubModelServer } from "../inference/stub-server"
import type { StubModelServer, StubReply } from "../inference/stub-server"
import { addDocs, ledgerFixture, testDoc } from "../ledger/ledger.test-support"
import { buildText } from "../parsers/offsets"
import type { Section } from "../parsers/offsets"
import type { ParseResult } from "../parsers/types"
import { createExtractor } from "./pipeline"
import type { ExtractionConfig, Extractor, ExtractorDeps } from "./pipeline"

// Synthetic documents only: invented parties, amounts, dates and reference numbers.

export type Harness = {
  db: DatabaseSync
  docId: string
  entityId: string
  server: StubModelServer
  extractor: Extractor
  /** The parsed text the fake parser returns. */
  text: string
  /** Rows per ledger table, for before/after comparisons. */
  counts(): Record<string, number>
  close(): Promise<void>
}

/** A reply whose content is `value` as JSON. A high prompt count keeps the truncation tripwire quiet. */
export function jsonReply(value: unknown, extra: StubReply = {}): StubReply {
  return { deltas: [JSON.stringify(value)], promptTokens: 1_000_000, ...extra }
}

export const NOTHING_FOUND = jsonReply({ nothing_found: true, items: [] })

/** One message section per string; a `Section[]` is used as given. */
export function parsedText(input: string | Section[]): {
  text: string
  offsets: ReturnType<typeof buildText>["offsets"]
} {
  const sections: Section[] =
    typeof input === "string"
      ? [{ messageId: "<m1@example.invalid>", lines: input.split("\n") }]
      : input
  return buildText(sections)
}

export async function harness(
  input: string | Section[],
  replies: StubReply[],
  opts: {
    config?: Partial<ExtractionConfig>
    contextTokens?: number
    deps?: Partial<ExtractorDeps>
  } = {}
): Promise<Harness> {
  const { db, property } = await ledgerFixture()
  const [docId = ""] = addDocs(db, [
    testDoc("doc", { entityId: property.id, mime: "application/pdf" }),
  ])
  const { text, offsets } = parsedText(input)
  const server = await startStubModelServer({ replies })
  const model = createModelClient({
    baseUrl: server.url,
    contextTokens: opts.contextTokens ?? 1_000_000,
    maxReplyTokens: 1024,
  })
  const parser = {
    parseDocument: (doc: { blobSha256: string }): Promise<ParseResult> =>
      Promise.resolve({
        ok: true,
        sha256: doc.blobSha256,
        trust: "untrusted",
        text,
        offsets,
        pages: null,
      }),
  }
  const extractor = createExtractor({
    db,
    parser,
    model,
    config: { model: "stub-model", ...opts.config },
    now: () => new Date("2030-01-02T03:04:05.000Z"),
    ...opts.deps,
  })
  const tables = [
    "extractions",
    "extraction_field_confidence",
    "obligations",
    "links",
    "documents",
    "document_text",
    "entities",
    "profile_history",
  ]
  return {
    db,
    docId,
    entityId: property.id,
    server,
    extractor,
    text,
    counts: () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]),
        ])
      ),
    close: () => server.close(),
  }
}

/** The chat completion requests the stub received, parsed. */
export function chatRequests(server: StubModelServer): Array<{
  messages: Array<{ role: string; content: string }>
}> {
  return server.completions().map((c) => ({ messages: c.turns }))
}
