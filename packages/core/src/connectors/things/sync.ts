import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { getCursor, ingestBatch } from "../../index/index"
import type { DocumentHeadChange, IndexedDocument } from "../../index/index"
import { insertObligation } from "../../ledger/store"
import type { IngestEntities } from "../ingest-entity"
import { EntityRequiredError } from "../ingest-entity"
import type { ThingsClient } from "@eido/gate"
import type { GateThingsTodoItem } from "@eido/schemas"

export const THINGS_CONNECTOR = "things"
export const THINGS_STREAM = "todos"
export const THINGS_MIME = "application/x-eido-things-todo"

export interface ThingsSyncOptions {
  db: DatabaseSync
  client: ThingsClient
  entities: IngestEntities
  listName?: string
}

export interface ThingsSyncResult {
  itemsFetched: number
  itemsIngested: number
  obligationsCreated: number
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function todoDigest(item: GateThingsTodoItem): string {
  return sha256(
    JSON.stringify({
      id: item.id,
      name: item.name,
      notes: item.notes,
      status: item.status,
      dueDate: item.dueDate,
      area: item.area,
      tags: item.tags,
      mod: item.modificationDate,
    })
  )
}

/**
 * Record the status and due date of every fetched to-do version that is indexed, so the proposal
 * path can list the open ones. Versions indexed before the facts table existed are filled in here
 * too, without re-ingesting them.
 */
function recordTodoFacts(db: DatabaseSync, items: GateThingsTodoItem[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO things_todo_facts (sha256, todo_id, status, due_date)
     SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM documents WHERE sha256 = ?)`
  )
  for (const item of items) {
    const digest = todoDigest(item)
    insert.run(digest, item.id, item.status, item.dueDate, digest)
  }
}

export async function syncThingsTodos({
  db,
  client,
  entities,
  listName = "",
}: ThingsSyncOptions): Promise<ThingsSyncResult> {
  const items = await client.listTodos(listName)
  const stored = getCursor(db, THINGS_CONNECTOR, THINGS_STREAM)
  let lastKnown: Record<string, string> = {}
  if (stored?.cursor) {
    try {
      lastKnown = JSON.parse(stored.cursor) as Record<string, string>
    } catch {
      lastKnown = {}
    }
  }

  const newKnown: Record<string, string> = { ...lastKnown }
  const changedItems: GateThingsTodoItem[] = []

  for (const item of items) {
    const modMarker =
      item.modificationDate ?? `${item.status}:${item.dueDate ?? ""}`
    if (!lastKnown[item.id] || lastKnown[item.id] !== modMarker) {
      changedItems.push(item)
    }
    newKnown[item.id] = modMarker
  }

  if (changedItems.length === 0) {
    recordTodoFacts(db, items)
    return {
      itemsFetched: items.length,
      itemsIngested: 0,
      obligationsCreated: 0,
    }
  }

  const defaultEntity = await entities.getDefaultEntityId()
  const documents: IndexedDocument[] = []
  const heads: DocumentHeadChange[] = []
  const itemsWithDocs: {
    item: GateThingsTodoItem
    doc: IndexedDocument
    entityId: string
  }[] = []

  for (const item of changedItems) {
    let entityId: string | null = null
    if (item.area) {
      const assigned = await entities.entityForAccount(
        THINGS_CONNECTOR,
        item.area
      )
      if (assigned) entityId = assigned.id
    }
    if (!entityId) {
      entityId = defaultEntity
    }
    if (!entityId) {
      throw new EntityRequiredError(THINGS_CONNECTOR)
    }

    const sourceRef = `things:///show?id=${encodeURIComponent(item.id)}`
    const body = item.name + (item.notes ? `\n\n${item.notes}` : "")
    const docDigest = todoDigest(item)

    const doc: IndexedDocument = {
      sha256: docDigest,
      source: THINGS_CONNECTOR,
      sourceRef,
      mime: THINGS_MIME,
      title: item.name,
      body,
      entityId,
      occurredAt: item.modificationDate ?? item.creationDate ?? undefined,
    }

    documents.push(doc)
    heads.push({
      source: THINGS_CONNECTOR,
      sourceRef,
      sha256: docDigest,
    })
    itemsWithDocs.push({ item, doc, entityId })
  }

  ingestBatch(db, {
    connector: THINGS_CONNECTOR,
    stream: THINGS_STREAM,
    documents,
    heads,
    nextCursor: JSON.stringify(newKnown),
  })
  recordTodoFacts(db, items)

  let obligationsCreated = 0
  for (const { item, doc, entityId } of itemsWithDocs) {
    if (item.dueDate) {
      const action = item.name.length > 0 ? item.name : "Things to-do"
      await insertObligation(db, {
        entityId,
        docId: doc.sha256,
        action,
        party: item.area ?? undefined,
        dueAt: item.dueDate,
        status:
          item.status === "completed"
            ? "done"
            : item.status === "canceled"
              ? "dismissed"
              : "open",
        span: { start: 0, end: action.length },
      })
      obligationsCreated++
    }
  }

  return {
    itemsFetched: items.length,
    itemsIngested: documents.length,
    obligationsCreated,
  }
}
