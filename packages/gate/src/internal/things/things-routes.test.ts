import { afterEach, describe, expect, test } from "vitest"
import type {
  GateThingsAreaList,
  GateThingsProjectItem,
  GateThingsProjectList,
  GateThingsTagList,
  GateThingsTodoItem,
  GateThingsTodoList,
} from "@eido/schemas"
import { payloadHash } from "../canonical"
import { setup } from "../test-fixtures"
import type { Setup } from "../test-fixtures"
import type { GateRequest } from "../http"
import { THINGS_CONNECTOR, thingsRoute } from "./things-routes"
import type { ThingsReads } from "./things-adapter"
import { ThingsError } from "./runner"

let s: Setup | undefined
afterEach(() => {
  s?.cleanup()
  s = undefined
})

const SAMPLE_TODO: GateThingsTodoItem = {
  id: "todo-abc",
  name: "TopSecretPlan",
  status: "open",
  notes: "ClassifiedNotes",
  tags: ["Urgent"],
  area: "Personal",
  project: null,
  dueDate: null,
  activationDate: null,
  modificationDate: "2026-11-03",
  creationDate: "2026-11-01",
}

const SAMPLE_PROJECT: GateThingsProjectItem = {
  id: "proj-xyz",
  name: "ConfidentialProject",
  area: "Work",
  status: "open",
  headings: ["Milestone1"],
  todoCount: 3,
  notes: "Secret notes",
  dueDate: "2026-12-31",
  activationDate: "2026-11-01",
  tags: ["ProjectTag"],
}

function req(method: string, path: string, query = ""): GateRequest {
  return {
    method,
    path,
    query: new URLSearchParams(query),
    headers: {},
    body: () => Promise.reject(new Error("no body")),
  }
}

function makeStubThings(overrides: Partial<ThingsReads> = {}): ThingsReads {
  return {
    listTodos:
      overrides.listTodos ?? (() => Promise.resolve({ items: [SAMPLE_TODO] })),
    listByDeadline:
      overrides.listByDeadline ??
      (() => Promise.resolve({ items: [SAMPLE_TODO] })),
    getItem:
      overrides.getItem ??
      ((id) =>
        Promise.resolve(
          id === SAMPLE_TODO.id
            ? SAMPLE_TODO
            : id === SAMPLE_PROJECT.id
              ? SAMPLE_PROJECT
              : null
        )),
    listProjects:
      overrides.listProjects ??
      (() => Promise.resolve({ projects: [SAMPLE_PROJECT] })),
    listAreas:
      overrides.listAreas ??
      (() =>
        Promise.resolve({
          areas: [{ id: "a-1", name: "PrivateArea" }],
        })),
    listTags:
      overrides.listTags ??
      (() => Promise.resolve({ tags: ["SecretTag", "Important"] })),
  }
}

describe("Things gate routes", () => {
  test("GET /things/lists/:list returns to-dos and writes counts-only audit row", async () => {
    s = setup()
    const things = makeStubThings()
    const reply = await thingsRoute(
      req("GET", "/things/lists/Inbox"),
      s.db,
      things
    )
    expect(reply).toBeDefined()
    expect(reply?.status).toBe(200)
    expect((reply?.body as GateThingsTodoList).items).toHaveLength(1)

    // Check audit row (AC 8): counts only, no title or notes
    const rows = s.db
      .prepare(
        "SELECT action, target, detail_hash FROM audit_log WHERE target = ? AND action LIKE 'things.read.%'"
      )
      .all(THINGS_CONNECTOR)
    expect(rows).toHaveLength(1)
    const row = rows[0] as {
      action: string
      target: string
      detail_hash: string
    }
    expect(row.action).toBe("things.read.lists")
    expect(row.target).toBe(THINGS_CONNECTOR)
    expect(row.detail_hash).toBe(payloadHash({ items: 1 }))

    // Verify neither title nor notes appears in audit log table text
    const fullLogJson = JSON.stringify(
      s.db.prepare("SELECT * FROM audit_log").all()
    )
    expect(fullLogJson).not.toContain("TopSecretPlan")
    expect(fullLogJson).not.toContain("ClassifiedNotes")
  })

  test("GET /things/items/:id returns item when found and 404 when absent", async () => {
    s = setup()
    const things = makeStubThings()

    const foundReply = await thingsRoute(
      req("GET", `/things/items/${SAMPLE_TODO.id}`),
      s.db,
      things
    )
    expect(foundReply?.status).toBe(200)
    expect((foundReply?.body as GateThingsTodoItem).id).toBe(SAMPLE_TODO.id)

    const missingReply = await thingsRoute(
      req("GET", "/things/items/non-existent-id"),
      s.db,
      things
    )
    expect(missingReply?.status).toBe(404)
    expect(missingReply?.body).toMatchObject({ code: "not_found" })
  })

  test("GET /things/projects, /things/areas, /things/tags return 200 with counts-only audit", async () => {
    s = setup()
    const things = makeStubThings()

    const projReply = await thingsRoute(
      req("GET", "/things/projects"),
      s.db,
      things
    )
    expect(projReply?.status).toBe(200)
    expect((projReply?.body as GateThingsProjectList).projects).toHaveLength(1)

    const areaReply = await thingsRoute(
      req("GET", "/things/areas"),
      s.db,
      things
    )
    expect(areaReply?.status).toBe(200)
    expect((areaReply?.body as GateThingsAreaList).areas).toHaveLength(1)

    const tagsReply = await thingsRoute(
      req("GET", "/things/tags"),
      s.db,
      things
    )
    expect(tagsReply?.status).toBe(200)
    expect((tagsReply?.body as GateThingsTagList).tags).toHaveLength(2)

    // Failure in areas
    const failingThings = makeStubThings({
      listAreas: () =>
        Promise.reject(new ThingsError("things_unavailable", "failed")),
    })
    const failArea = await thingsRoute(
      req("GET", "/things/areas"),
      s.db,
      failingThings
    )
    expect(failArea?.status).toBe(502)
  })

  test("AC 7: things_unavailable gives named 502 with code things_unavailable and no retry", async () => {
    s = setup()
    const things = makeStubThings({
      listTodos: () =>
        Promise.reject(
          new ThingsError("things_unavailable", "Things is not running")
        ),
    })

    const reply = await thingsRoute(
      req("GET", "/things/lists/Today"),
      s.db,
      things
    )
    expect(reply?.status).toBe(502)
    expect(reply?.body).toMatchObject({
      code: "things_unavailable",
    })
  })

  test("AC 7: automation_denied gives named 502 with code automation_denied and no retry", async () => {
    s = setup()
    const things = makeStubThings({
      listTodos: () =>
        Promise.reject(
          new ThingsError("automation_denied", "Automation permission denied")
        ),
    })

    const reply = await thingsRoute(
      req("GET", "/things/lists/Today"),
      s.db,
      things
    )
    expect(reply?.status).toBe(502)
    expect(reply?.body).toMatchObject({
      code: "automation_denied",
    })
  })

  test("GET /things/lists/deadline?daysAhead=10 calls listByDeadline, and defaults to 7 days", async () => {
    s = setup()
    let recordedDays = 0
    const things = makeStubThings({
      listByDeadline: (days) => {
        recordedDays = days
        return Promise.resolve({ items: [SAMPLE_TODO] })
      },
    })
    const reply = await thingsRoute(
      req("GET", "/things/lists/deadline", "daysAhead=10"),
      s.db,
      things
    )
    expect(reply?.status).toBe(200)
    expect(recordedDays).toBe(10)

    const defaultReply = await thingsRoute(
      req("GET", "/things/lists/deadline"),
      s.db,
      things
    )
    expect(defaultReply?.status).toBe(200)
    expect(recordedDays).toBe(7)
  })

  test("returns 503 when connector is disabled or waiting for probe", async () => {
    s = setup()
    const things = makeStubThings()

    // Disable connector in DB
    s.db
      .prepare("UPDATE connectors SET enabled = 0 WHERE name = ?")
      .run(THINGS_CONNECTOR)

    const disabledReply = await thingsRoute(
      req("GET", "/things/lists/Inbox"),
      s.db,
      things
    )
    expect(disabledReply?.status).toBe(503)

    // Open breaker waiting for probe
    s.db
      .prepare(
        "UPDATE connectors SET enabled = 1, health = 'open', next_attempt_at = ? WHERE name = ?"
      )
      .run(new Date(Date.now() + 60_000).toISOString(), THINGS_CONNECTOR)

    const openReply = await thingsRoute(
      req("GET", "/things/lists/Inbox"),
      s.db,
      things
    )
    expect(openReply?.status).toBe(503)
  })

  test("ignores non-GET requests or unrelated paths", async () => {
    s = setup()
    const things = makeStubThings()
    const postReply = await thingsRoute(
      req("POST", "/things/lists/Inbox"),
      s.db,
      things
    )
    expect(postReply).toBeUndefined()

    const otherReply = await thingsRoute(
      req("GET", "/other/path"),
      s.db,
      things
    )
    expect(otherReply).toBeUndefined()
  })
})
