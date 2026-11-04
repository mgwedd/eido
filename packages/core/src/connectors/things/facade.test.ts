import { describe, expect, test, vi } from "vitest"
import type { IntentProposal, ThingsClient } from "@eido/gate"
import type {
  GateThingsAreaItem,
  GateThingsProjectItem,
  GateThingsTodoItem,
  Intent,
} from "@eido/schemas"
import { createThingsFacade } from "./facade"

const SAMPLE_TODO: GateThingsTodoItem = {
  id: "todo-1",
  name: "Buy groceries",
  status: "open",
  notes: "Apples, oranges",
  tags: ["Home"],
  area: "Personal",
  project: null,
  dueDate: null,
  activationDate: null,
  modificationDate: "2026-11-03",
  creationDate: "2026-11-01",
}

const SAMPLE_PROJECT: GateThingsProjectItem = {
  id: "proj-1",
  name: "Kitchen Renovation",
  area: "Personal",
  status: "open",
  headings: ["Cabinets", "Plumbing"],
  todoCount: 5,
  notes: "Contractor contact info",
  dueDate: "2026-12-01",
  activationDate: "2026-11-01",
  tags: ["Home", "Renovation"],
}

describe("Things facade", () => {
  test("read verbs forward to ThingsClient methods", async () => {
    const listTodosMock = vi.fn().mockResolvedValue([SAMPLE_TODO])
    const getItemMock = vi.fn().mockResolvedValue(SAMPLE_TODO)
    const listByDeadlineMock = vi.fn().mockResolvedValue([SAMPLE_TODO])
    const listProjectsMock = vi.fn().mockResolvedValue([SAMPLE_PROJECT])
    const listAreasMock = vi
      .fn()
      .mockResolvedValue([{ id: "a-1", name: "Work" }] as GateThingsAreaItem[])
    const listTagsMock = vi.fn().mockResolvedValue(["Work", "Urgent"])

    const client: ThingsClient = {
      listTodos: listTodosMock,
      getItem: getItemMock,
      listByDeadline: listByDeadlineMock,
      listProjects: listProjectsMock,
      listAreas: listAreasMock,
      listTags: listTagsMock,
    }

    const facade = createThingsFacade({
      client,
      intents: { propose: vi.fn() },
    })

    const todos = await facade.list_todos({ list: "Today" })
    expect(todos).toEqual([SAMPLE_TODO])
    expect(listTodosMock).toHaveBeenCalledWith("Today")

    await facade.list_todos()
    expect(listTodosMock).toHaveBeenCalledWith("Today")

    const item = await facade.get_todo({ id: "todo-1" })
    expect(item).toEqual(SAMPLE_TODO)
    expect(getItemMock).toHaveBeenCalledWith("todo-1")

    const deadlineItems = await facade.list_deadline({ daysAhead: 14 })
    expect(deadlineItems).toEqual([SAMPLE_TODO])
    expect(listByDeadlineMock).toHaveBeenCalledWith(14)

    await facade.list_deadline()
    expect(listByDeadlineMock).toHaveBeenCalledWith(7)

    const projects = await facade.list_projects({ area: "Work" })
    expect(projects).toEqual([SAMPLE_PROJECT])
    expect(listProjectsMock).toHaveBeenCalledWith("Work")

    const proj = await facade.get_project({ id: "proj-1" })
    expect(proj).toEqual(SAMPLE_TODO)

    const areas = await facade.list_areas()
    expect(areas).toEqual([{ id: "a-1", name: "Work" }])

    const tags = await facade.list_tags()
    expect(tags).toEqual(["Work", "Urgent"])
  })

  test("AC 2: write verbs propose intents, return intent ID, and spawn zero processes", async () => {
    const proposed: IntentProposal[] = []
    const proposeMock = vi.fn((proposal: IntentProposal) => {
      proposed.push(proposal)
      return Promise.resolve({
        id: `intent-${proposed.length}`,
        tier: "auto" as const,
        state: "proposed" as const,
      })
    })

    const client = {} as ThingsClient
    const facade = createThingsFacade({
      client,
      intents: { propose: proposeMock },
      origin: "reactive",
    })

    // 1. add_todo
    const r1 = await facade.add_todo({
      title: "Clean desk",
      notes: "Dust monitor and keyboard",
      when: "today",
      tags: ["Office"],
    })
    expect(r1).toEqual({ intentId: "intent-1" })
    expect((proposed[0]?.intent as Intent).kind).toBe("things.add_todo")

    // 2. update_todo
    const r2 = await facade.update_todo({
      id: "todo-1",
      title: "Clean desk thoroughly",
    })
    expect(r2).toEqual({ intentId: "intent-2" })
    expect((proposed[1]?.intent as Intent).kind).toBe("things.update_todo")

    // 3. schedule_todo
    const r3 = await facade.schedule_todo({
      id: "todo-1",
      when: "tomorrow",
    })
    expect(r3).toEqual({ intentId: "intent-3" })
    expect((proposed[2]?.intent as Intent).kind).toBe("things.schedule_todo")

    // 4. complete_todo
    const r4 = await facade.complete_todo({
      id: "todo-1",
    })
    expect(r4).toEqual({ intentId: "intent-4" })
    expect((proposed[3]?.intent as Intent).kind).toBe("things.complete_todo")

    // 5. cancel_todo
    const r5 = await facade.cancel_todo({
      id: "todo-1",
    })
    expect(r5).toEqual({ intentId: "intent-5" })
    expect((proposed[4]?.intent as Intent).kind).toBe("things.cancel_todo")

    // 6. add_project
    const r6 = await facade.add_project({
      title: "Office reorganization",
      notes: "Sort supplies and cables",
    })
    expect(r6).toEqual({ intentId: "intent-6" })
    expect((proposed[5]?.intent as Intent).kind).toBe("things.add_project")

    // Zero calls to any external runner process
    expect(proposeMock).toHaveBeenCalledTimes(6)
  })

  test("AC 3: add_todo with sensitive text is escalated to sensitive intent", async () => {
    let capturedIntent: IntentProposal["intent"] | undefined
    const proposeMock = vi.fn((proposal: IntentProposal) => {
      capturedIntent = proposal.intent
      return Promise.resolve({
        id: "intent-sensitive",
        tier: "approval" as const,
        state: "proposed" as const,
      })
    })

    const facade = createThingsFacade({
      client: {} as ThingsClient,
      intents: { propose: proposeMock },
    })

    await facade.add_todo({
      title: "Call Dr. Smith about cardiology prescription",
      notes: "Follow up on biopsy results",
    })

    expect(
      (capturedIntent as { sensitivity?: string } | undefined)?.sensitivity
    ).toBe("sensitive")
  })

  test("write verbs throw on schema validation failure", async () => {
    const facade = createThingsFacade({
      client: {} as ThingsClient,
      intents: { propose: vi.fn() },
    })

    // Missing id for update_todo
    await expect(
      // @ts-expect-error testing missing id
      facade.update_todo({ title: "New title without id" })
    ).rejects.toThrow("invalid payload for things.update_todo")
  })
})
