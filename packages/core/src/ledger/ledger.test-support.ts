import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { ingestBatch } from "../index/ingest"
import type { IndexedDocument } from "../index/ingest"
import { createProfileStore } from "../profile/store"
import type { ProfileStore } from "../profile/store"
import type { Entity } from "../profile/types"
import { openDataDb } from "./db"

export const sha = (s: string): string =>
  createHash("sha256").update(s).digest("hex")

export interface LedgerFixture {
  db: DatabaseSync
  profile: ProfileStore
  property: Entity
  company: Entity
}

/** A fresh in-memory data DB with two synthetic entities created through the profile store (#80). */
export async function ledgerFixture(): Promise<LedgerFixture> {
  const db = openDataDb(":memory:")
  const profile = createProfileStore(db, { audit: () => Promise.resolve() })
  const property = await profile.createEntity({
    kind: "property",
    name: "Test Property",
    tag: "PROP",
  })
  const company = await profile.createEntity({
    kind: "company",
    name: "Test Company",
    tag: "CO",
  })
  return { db, profile, property, company }
}

export function testDoc(
  id: string,
  over: Partial<IndexedDocument> = {}
): IndexedDocument {
  return {
    sha256: sha(id),
    source: "gmail",
    sourceRef: `ref-${id}`,
    mime: "message/rfc822",
    body: `body of ${id}`,
    ...over,
  }
}

/** Store documents through the index's ingest path; returns their sha256s. */
export function addDocs(
  db: DatabaseSync,
  documents: IndexedDocument[]
): string[] {
  ingestBatch(db, {
    connector: "gmail",
    stream: "inbox",
    documents,
    nextCursor: "c1",
  })
  return documents.map((d) => d.sha256)
}
