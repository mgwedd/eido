import { describe, expect, test } from "vitest"
import type { ThingsClient } from "@eido/gate"
import type { GateThingsTodoItem } from "@eido/schemas"
import { openDataDb } from "../../ledger/db"
import { listObligations } from "../../ledger/store"
import { syncThingsTodos, THINGS_CONNECTOR, THINGS_MIME } from "./sync"
import type { IngestEntities } from "../ingest-entity"
import { EntityRequiredError } from "../ingest-entity"

describe("Things sync", () => {
  function setupTestDb() {
    const db = openDataDb(":memory:")
    // Insert an entity for testing
    db.prepare(
      `INSERT INTO entities (id, kind, name, tag, created_at)
       VALUES ('entity-work', 'company', 'Work Entity', 'work', datetime('now')),
              ('entity-default', 'personal', 'Default Entity', 'default', datetime('now'))`
    ).run()
    return db
  }

  const sampleTodo: GateThingsTodoItem = {
    id: "todo-abc-123",
    name: "File tax return",
    status: "open",
    notes: "Review W-2 and deductions",
    tags: ["Finance", "Taxes"],
    area: "FinanceArea",
    project: null,
    dueDate: "2026-04-15",
    activationDate: "2026-04-01",
    modificationDate: "2026-04-01T10:00:00Z",
    creationDate: "2026-04-01T09:00:00Z",
  }

  test("AC 9: ingests to-dos with deep link and entity; deadline creates obligation", async () => {
    const db = setupTestDb()
    const client: ThingsClient = {
      listTodos: () => Promise.resolve([sampleTodo]),
      getItem: () => Promise.resolve(sampleTodo),
      listByDeadline: () => Promise.resolve([sampleTodo]),
      listProjects: () => Promise.resolve([]),
      listAreas: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    }

    const entities: IngestEntities = {
      entityForAccount: (_conn, area) => {
        if (area === "FinanceArea") {
          return Promise.resolve({
            id: "entity-work",
            kind: "company",
            name: "Work Entity",
            tag: "work",
            createdAt: "2026-01-01T00:00:00Z",
          })
        }
        return Promise.resolve(null)
      },
      getDefaultEntityId: () => Promise.resolve("entity-default"),
    }

    const result = await syncThingsTodos({
      db,
      client,
      entities,
    })

    expect(result).toEqual({
      itemsFetched: 1,
      itemsIngested: 1,
      obligationsCreated: 1,
    })

    // Verify document was stored with correct sourceRef and entity
    const docRow = db
      .prepare(
        "SELECT sha256, source, source_ref, mime, entity_id FROM documents WHERE source = ?"
      )
      .get(THINGS_CONNECTOR) as {
      sha256: string
      source: string
      source_ref: string
      mime: string
      entity_id: string
    }

    expect(docRow).toBeDefined()
    expect(docRow.source_ref).toBe("things:///show?id=todo-abc-123")
    expect(docRow.mime).toBe(THINGS_MIME)
    expect(docRow.entity_id).toBe("entity-work")

    // Verify obligation was created linked to this document
    const obligations = listObligations(db, { entityId: "entity-work" })
    expect(obligations).toHaveLength(1)
    expect(obligations[0]).toMatchObject({
      docId: docRow.sha256,
      entity: { id: "entity-work" },
      action: "File tax return",
      dueAt: "2026-04-15",
      status: "open",
      party: "FinanceArea",
    })
  })

  test("diffs on item id + modification date: second run with no changes ingests 0", async () => {
    const db = setupTestDb()
    const client: ThingsClient = {
      listTodos: () => Promise.resolve([sampleTodo]),
      getItem: () => Promise.resolve(sampleTodo),
      listByDeadline: () => Promise.resolve([sampleTodo]),
      listProjects: () => Promise.resolve([]),
      listAreas: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    }
    const entities: IngestEntities = {
      entityForAccount: () => Promise.resolve(null),
      getDefaultEntityId: () => Promise.resolve("entity-default"),
    }

    const first = await syncThingsTodos({ db, client, entities })
    expect(first.itemsIngested).toBe(1)

    // Re-run with identical item
    const second = await syncThingsTodos({ db, client, entities })
    expect(second.itemsFetched).toBe(1)
    expect(second.itemsIngested).toBe(0)
    expect(second.obligationsCreated).toBe(0)

    // Modify item's modification date
    const updatedTodo: GateThingsTodoItem = {
      ...sampleTodo,
      modificationDate: "2026-04-02T12:00:00Z",
      status: "completed",
    }
    const modifiedClient: ThingsClient = {
      ...client,
      listTodos: () => Promise.resolve([updatedTodo]),
    }

    const third = await syncThingsTodos({
      db,
      client: modifiedClient,
      entities,
    })
    expect(third.itemsIngested).toBe(1)
    expect(third.obligationsCreated).toBe(1)

    // New obligation has done status
    const obligations = listObligations(db, { entityId: "entity-default" })
    expect(obligations).toHaveLength(2)
    const latest = obligations.find((o) => o.status === "done")
    expect(latest).toBeDefined()
  })

  test("to-do without deadline does not create obligation", async () => {
    const db = setupTestDb()
    const noDeadlineTodo: GateThingsTodoItem = {
      ...sampleTodo,
      id: "no-deadline",
      dueDate: null,
    }
    const client: ThingsClient = {
      listTodos: () => Promise.resolve([noDeadlineTodo]),
      getItem: () => Promise.resolve(noDeadlineTodo),
      listByDeadline: () => Promise.resolve([]),
      listProjects: () => Promise.resolve([]),
      listAreas: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    }
    const entities: IngestEntities = {
      entityForAccount: () => Promise.resolve(null),
      getDefaultEntityId: () => Promise.resolve("entity-default"),
    }

    const res = await syncThingsTodos({ db, client, entities })
    expect(res.itemsIngested).toBe(1)
    expect(res.obligationsCreated).toBe(0)

    const obligations = listObligations(db)
    expect(obligations).toHaveLength(0)
  })

  test("throws EntityRequiredError when area has no entity and default entity is null", async () => {
    const db = setupTestDb()
    const client: ThingsClient = {
      listTodos: () => Promise.resolve([sampleTodo]),
      getItem: () => Promise.resolve(sampleTodo),
      listByDeadline: () => Promise.resolve([]),
      listProjects: () => Promise.resolve([]),
      listAreas: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    }
    const entities: IngestEntities = {
      entityForAccount: () => Promise.resolve(null),
      getDefaultEntityId: () => Promise.resolve(null),
    }

    await expect(syncThingsTodos({ db, client, entities })).rejects.toThrow(
      EntityRequiredError
    )
  })

  test("handles corrupted cursor JSON safely", async () => {
    const db = setupTestDb()
    db.prepare(
      `INSERT INTO cursors (connector, stream, cursor, updated_at)
       VALUES ('things', 'todos', 'not-valid-json', datetime('now'))`
    ).run()

    const client: ThingsClient = {
      listTodos: () => Promise.resolve([sampleTodo]),
      getItem: () => Promise.resolve(sampleTodo),
      listByDeadline: () => Promise.resolve([]),
      listProjects: () => Promise.resolve([]),
      listAreas: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    }
    const entities: IngestEntities = {
      entityForAccount: () => Promise.resolve(null),
      getDefaultEntityId: () => Promise.resolve("entity-default"),
    }

    const result = await syncThingsTodos({ db, client, entities })
    expect(result.itemsIngested).toBe(1)
  })

  test("handles item with empty notes, null dates, null area, canceled status, and empty name", async () => {
    const db = setupTestDb()
    const minimalTodo: GateThingsTodoItem = {
      id: "todo-minimal",
      name: "",
      status: "canceled",
      notes: "",
      tags: [],
      area: null,
      project: null,
      dueDate: "2026-05-01",
      activationDate: null,
      modificationDate: null,
      creationDate: null,
    }

    const client: ThingsClient = {
      listTodos: () => Promise.resolve([minimalTodo]),
      getItem: () => Promise.resolve(minimalTodo),
      listByDeadline: () => Promise.resolve([]),
      listProjects: () => Promise.resolve([]),
      listAreas: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    }
    const entities: IngestEntities = {
      entityForAccount: () => Promise.resolve(null),
      getDefaultEntityId: () => Promise.resolve("entity-default"),
    }

    const res = await syncThingsTodos({ db, client, entities })
    expect(res.itemsIngested).toBe(1)
    expect(res.obligationsCreated).toBe(1)

    const obligations = listObligations(db, { entityId: "entity-default" })
    expect(obligations[0]).toMatchObject({
      action: "Things to-do",
      status: "dismissed",
      party: null,
    })
  })
})
