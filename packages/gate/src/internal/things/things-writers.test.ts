import { describe, expect, test } from "vitest"
import { THINGS_WRITERS, createThingsTransport } from "./things-writers"
import { THINGS_CONNECTOR } from "./things-routes"
import type { ThingsScriptRunner } from "./runner"
import type { WriteRequest } from "../executor"
import type { Intent } from "@eido/schemas"

describe("Things executor writers and transport", () => {
  test("AC 3: add_todo has cancel_todo inverse; other writers have null inverse", () => {
    const addTodoWriter = THINGS_WRITERS.find(
      (w) => w.kind === "things.add_todo"
    )
    expect(addTodoWriter).toBeDefined()
    expect(
      addTodoWriter?.inverse(
        { kind: "things.add_todo", args: { title: "Buy milk" } },
        { id: "todo-abc" }
      )
    ).toEqual({
      kind: "things.cancel_todo",
      args: { id: "todo-abc" },
    })

    expect(
      addTodoWriter?.inverse(
        { kind: "things.add_todo", args: { title: "Buy milk" } },
        null
      )
    ).toBeNull()

    expect(
      addTodoWriter?.inverse(
        { kind: "things.add_todo", args: { title: "Buy milk" } },
        { notId: 123 }
      )
    ).toBeNull()

    const updateWriter = THINGS_WRITERS.find(
      (w) => w.kind === "things.update_todo"
    )
    expect(
      updateWriter?.inverse(
        { kind: "things.update_todo", args: { id: "todo-abc" } },
        { id: "todo-abc" }
      )
    ).toBeNull()
  })

  test("transport runs add-todo with correct arguments and returns id", async () => {
    const recordedCalls: { script: string; argv?: readonly string[] }[] = []
    const fakeRunner: ThingsScriptRunner = (script, argv) => {
      recordedCalls.push({ script, argv })
      return Promise.resolve("new-created-id-456")
    }

    const transport = createThingsTransport(fakeRunner)
    const intent: Intent = {
      kind: "things.add_todo",
      args: {
        title: "Test Task",
        notes: "Detailed description",
        when: "today",
        deadline: "2026-11-30",
        tags: ["Urgent", "Work"],
      },
    }

    const request: WriteRequest = {
      connector: THINGS_CONNECTOR,
      operation: "add_todo",
      url: "things:things.add_todo",
      method: "POST",
      body: JSON.stringify(intent),
      idempotencyKey: "idem-1",
      intentKind: "things.add_todo",
    }

    const result = await transport(request)
    expect(result).toEqual({
      upstreamRef: "new-created-id-456",
      result: { id: "new-created-id-456" },
    })
    expect(recordedCalls).toHaveLength(1)
    expect(recordedCalls[0]).toEqual({
      script: "add-todo",
      argv: [
        "Test Task",
        "Detailed description",
        "today",
        "2026-11-30",
        "Urgent,Work",
      ],
    })
  })

  test("transport runs update, schedule, complete, cancel, add_project", async () => {
    const recordedCalls: { script: string; argv?: readonly string[] }[] = []
    const fakeRunner: ThingsScriptRunner = (script, argv) => {
      recordedCalls.push({ script, argv })
      return Promise.resolve("item-id-789")
    }

    const transport = createThingsTransport(fakeRunner)

    // Complete
    await transport({
      connector: THINGS_CONNECTOR,
      operation: "complete_todo",
      url: "things:things.complete_todo",
      method: "POST",
      body: JSON.stringify({
        kind: "things.complete_todo",
        args: { id: "item-id-789" },
      }),
      idempotencyKey: "idem-2",
      intentKind: "things.complete_todo",
    })
    expect(recordedCalls[0]).toEqual({
      script: "complete-todo",
      argv: ["item-id-789"],
    })

    // Cancel
    await transport({
      connector: THINGS_CONNECTOR,
      operation: "cancel_todo",
      url: "things:things.cancel_todo",
      method: "POST",
      body: JSON.stringify({
        kind: "things.cancel_todo",
        args: { id: "item-id-789" },
      }),
      idempotencyKey: "idem-3",
      intentKind: "things.cancel_todo",
    })
    expect(recordedCalls[1]).toEqual({
      script: "cancel-todo",
      argv: ["item-id-789"],
    })

    // Update
    await transport({
      connector: THINGS_CONNECTOR,
      operation: "update_todo",
      url: "things:things.update_todo",
      method: "POST",
      body: JSON.stringify({
        kind: "things.update_todo",
        args: {
          id: "item-id-789",
          title: "New Title",
          notes: "New Notes",
          when: "tomorrow",
          deadline: "2026-12-01",
          tags: ["Tag1"],
          list: "Inbox",
          project: "proj-1",
          area: "area-1",
        },
      }),
      idempotencyKey: "idem-4",
      intentKind: "things.update_todo",
    })
    expect(recordedCalls[2]).toEqual({
      script: "update-todo",
      argv: [
        "item-id-789",
        "New Title",
        "New Notes",
        "tomorrow",
        "2026-12-01",
        "Tag1",
        "Inbox",
        "proj-1",
        "area-1",
      ],
    })

    // Schedule
    await transport({
      connector: THINGS_CONNECTOR,
      operation: "schedule_todo",
      url: "things:things.schedule_todo",
      method: "POST",
      body: JSON.stringify({
        kind: "things.schedule_todo",
        args: { id: "item-id-789", when: "today" },
      }),
      idempotencyKey: "idem-5",
      intentKind: "things.schedule_todo",
    })
    expect(recordedCalls[3]).toEqual({
      script: "schedule-todo",
      argv: ["item-id-789", "today"],
    })

    // Add project
    await transport({
      connector: THINGS_CONNECTOR,
      operation: "add_project",
      url: "things:things.add_project",
      method: "POST",
      body: JSON.stringify({
        kind: "things.add_project",
        args: {
          title: "New Project",
          notes: "Notes",
          when: "today",
          deadline: "2026-12-31",
          tags: ["ProjTag"],
          area: "area-1",
        },
      }),
      idempotencyKey: "idem-6",
      intentKind: "things.add_project",
    })
    expect(recordedCalls[4]).toEqual({
      script: "add-project",
      argv: [
        "New Project",
        "Notes",
        "today",
        "2026-12-31",
        "ProjTag",
        "area-1",
      ],
    })
  })

  test("transport refuses unsupported connector or invalid intent", async () => {
    const transport = createThingsTransport(() => Promise.resolve(""))
    await expect(
      transport({
        connector: "other-connector",
        operation: "op",
        url: "url",
        method: "POST",
        body: "{}",
        idempotencyKey: "k",
        intentKind: "things.add_todo",
      })
    ).rejects.toThrow("unsupported connector")

    await expect(
      transport({
        connector: THINGS_CONNECTOR,
        operation: "op",
        url: "url",
        method: "POST",
        body: JSON.stringify({ kind: "things.add_todo", args: { title: 123 } }),
        idempotencyKey: "k",
        intentKind: "things.add_todo",
      })
    ).rejects.toThrow("invalid intent")
  })

  test("writer buildRequest and intentFromRequest roundtrip", async () => {
    for (const writer of THINGS_WRITERS) {
      const intent = {
        kind: writer.kind,
        args: { title: "Test", id: "id-1" },
      } as unknown as Intent
      const req = await writer.buildRequest(intent)
      expect(req.method).toBe("POST")
      expect(req.url).toBe(`things:${writer.kind}`)
      expect(req.body).toBe(intent)
      expect(writer.intentFromRequest(req)).toBe(intent)
    }
  })

  test("transport handles empty returned id", async () => {
    const transport = createThingsTransport(() => Promise.resolve("  "))
    const result = await transport({
      connector: THINGS_CONNECTOR,
      operation: "add_todo",
      url: "things:things.add_todo",
      method: "POST",
      body: JSON.stringify({ kind: "things.add_todo", args: {} }),
      idempotencyKey: "k",
      intentKind: "things.add_todo",
    })
    expect(result.upstreamRef).toBeNull()
    expect(result.result).toEqual({ id: "" })
  })

  test("transport handles minimal update_todo and add_project args", async () => {
    const calls: { script: string; argv?: readonly string[] }[] = []
    const transport = createThingsTransport((script, argv) => {
      calls.push({ script, argv })
      return Promise.resolve("res-id")
    })

    await transport({
      connector: THINGS_CONNECTOR,
      operation: "update_todo",
      url: "things:things.update_todo",
      method: "POST",
      body: JSON.stringify({
        kind: "things.update_todo",
        args: { id: "min-id" },
      }),
      idempotencyKey: "k1",
      intentKind: "things.update_todo",
    })
    expect(calls[0]?.argv).toEqual([
      "min-id",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
      "__EIDO_KEEP__",
    ])

    await transport({
      connector: THINGS_CONNECTOR,
      operation: "add_project",
      url: "things:things.add_project",
      method: "POST",
      body: JSON.stringify({
        kind: "things.add_project",
        args: { title: "Simple Project" },
      }),
      idempotencyKey: "k2",
      intentKind: "things.add_project",
    })
    expect(calls[1]?.argv).toEqual(["Simple Project", "", "", "", "", ""])
  })
})
