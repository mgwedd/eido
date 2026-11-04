import { DatabaseSync } from "node:sqlite"
import { GateRequestError, GateUnavailableError } from "@eido/gate"
import type { IntentStatus } from "@eido/gate"
import { describe, expect, test } from "vitest"
import {
  liveDraftStatus,
  storedDraftIntentIds,
  threadsWithLiveDraft,
} from "./reply-draft-live"

function gate(answer: Partial<IntentStatus> | Error) {
  return {
    status: (id: string): Promise<IntentStatus> =>
      answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({
            id,
            kind: "email.draft",
            tier: "auto",
            state: "executed",
            edited_from: null,
            discarded: false,
            ...answer,
          }),
  }
}

describe("liveDraftStatus", () => {
  test.each(["proposed", "pending", "approved", "executed"] as const)(
    "a %s draft is live and its status is returned",
    async (state) => {
      expect(await liveDraftStatus(gate({ state }), "int_1")).toEqual({
        id: "int_1",
        kind: "email.draft",
        tier: "auto",
        state,
        edited_from: null,
        discarded: false,
      })
    }
  )

  test.each(["rejected", "failed"] as const)(
    "a %s draft is gone",
    async (state) => {
      expect(await liveDraftStatus(gate({ state }), "int_1")).toBeNull()
    }
  )

  test("an executed draft whose discard executed is gone", async () => {
    expect(await liveDraftStatus(gate({ discarded: true }), "int_1")).toBeNull()
  })

  test("a draft the gate no longer knows is gone", async () => {
    expect(
      await liveDraftStatus(
        gate(new GateRequestError(404, "not_found", "gone")),
        "int_1"
      )
    ).toBeNull()
  })

  test("any other gate error is thrown", async () => {
    const refused = new GateRequestError(500, "internal", "boom")
    await expect(liveDraftStatus(gate(refused), "int_1")).rejects.toBe(refused)
    const down = new GateUnavailableError("the gate is not reachable")
    await expect(liveDraftStatus(gate(down), "int_1")).rejects.toBe(down)
  })
})

function draftsDb(rows: [string, string][]): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  db.exec(
    "CREATE TABLE reply_drafts (thread_key TEXT PRIMARY KEY, obligation_id INTEGER NOT NULL, intent_id TEXT NOT NULL, created_at TEXT NOT NULL)"
  )
  const insert = db.prepare(
    "INSERT INTO reply_drafts VALUES (?, 1, ?, '2026-01-01T00:00:00Z')"
  )
  for (const [thread, intent] of rows) insert.run(thread, intent)
  return db
}

describe("storedDraftIntentIds", () => {
  test("returns the stored intent of each asked thread and no other", () => {
    const db = draftsDb([
      ["t1", "int_1"],
      ["t2", "int_2"],
      ["t3", "int_3"],
    ])
    expect(storedDraftIntentIds(db, ["t1", "t3", "t9"])).toEqual(
      new Map([
        ["t1", "int_1"],
        ["t3", "int_3"],
      ])
    )
  })

  test("a database without reply_drafts has none", () => {
    expect(storedDraftIntentIds(new DatabaseSync(":memory:"), ["t1"])).toEqual(
      new Map()
    )
  })
})

describe("threadsWithLiveDraft", () => {
  test("keeps threads whose draft is live or unanswerable, drops gone ones", async () => {
    const db = draftsDb([
      ["live", "int_live"],
      ["rejected", "int_rejected"],
      ["down", "int_down"],
    ])
    const status = (id: string): Promise<IntentStatus> => {
      if (id === "int_down")
        return Promise.reject(new GateUnavailableError("down"))
      return gate({ state: id === "int_live" ? "pending" : "rejected" }).status(
        id
      )
    }
    expect(
      await threadsWithLiveDraft(db, { status }, ["live", "rejected", "down"])
    ).toEqual(new Set(["live", "down"]))
  })
})
