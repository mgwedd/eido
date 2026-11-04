import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createThingsClient } from "../client"
import type { ThingsClient } from "../client"
import type { GateThingsProjectItem, GateThingsTodoItem } from "@eido/schemas"

describe("createThingsClient", () => {
  let tmpDir: string
  let socketPath: string
  let server: ReturnType<typeof createServer>
  let client: ThingsClient

  const sampleTodo: GateThingsTodoItem = {
    id: "todo-1",
    name: "Task One",
    status: "open",
    notes: "Notes",
    tags: ["Work"],
    area: "Office",
    project: null,
    dueDate: "2026-11-20",
    activationDate: null,
    modificationDate: "2026-11-03",
    creationDate: "2026-11-01",
  }

  const sampleProject: GateThingsProjectItem = {
    id: "proj-1",
    name: "Project One",
    area: "Office",
    status: "open",
    headings: ["H1"],
    todoCount: 2,
    notes: "Proj notes",
    dueDate: "2026-12-01",
    activationDate: null,
    tags: ["Work"],
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "things-client-test-"))
    socketPath = join(tmpDir, "gate.sock")
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      if (req.method === "GET" && url.pathname === "/things/lists/Inbox") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ items: [sampleTodo] }))
      } else if (
        req.method === "GET" &&
        url.pathname === "/things/lists/deadline"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ items: [sampleTodo] }))
      } else if (
        req.method === "GET" &&
        url.pathname === "/things/items/todo-1"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(sampleTodo))
      } else if (
        req.method === "GET" &&
        url.pathname === "/things/items/proj-1"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(sampleProject))
      } else if (req.method === "GET" && url.pathname === "/things/projects") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ projects: [sampleProject] }))
      } else if (req.method === "GET" && url.pathname === "/things/areas") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ areas: [{ id: "a-1", name: "Office" }] }))
      } else if (req.method === "GET" && url.pathname === "/things/tags") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ tags: ["Work", "Personal"] }))
      } else {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ code: "not_found", message: "not found" }))
      }
    })

    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    client = createThingsClient({ socketPath })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("listTodos returns parsed items", async () => {
    const items = await client.listTodos("Inbox")
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe("Task One")
  })

  test("listByDeadline returns items", async () => {
    const items = await client.listByDeadline(7)
    expect(items).toHaveLength(1)
    expect(items[0]?.name).toBe("Task One")
  })

  test("getItem returns to-do and project", async () => {
    const todo = await client.getItem("todo-1")
    expect(todo.id).toBe("todo-1")

    const proj = await client.getItem("proj-1")
    expect(proj.id).toBe("proj-1")
  })

  test("listProjects, listAreas, listTags return results", async () => {
    const projs = await client.listProjects("Office")
    expect(projs).toHaveLength(1)

    const areas = await client.listAreas()
    expect(areas).toEqual([{ id: "a-1", name: "Office" }])

    const tags = await client.listTags()
    expect(tags).toEqual(["Work", "Personal"])
  })
})
