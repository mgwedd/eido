import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GateConnectorHealth } from "@eido/schemas"
import { openIndex } from "../../index/schema"
import { parseAccountSet, SimpleFinError } from "./client"
import type { SimpleFinClient } from "./client"
import { SIMPLEFIN_SYNC_INTERVAL_MS } from "./config"
import { createSimpleFinRuntime, withSimpleFinMessages } from "./runtime"

// Synthetic accounts only.

const NOW_MS = Date.parse("2026-03-01T00:00:00.000Z")
const ACCOUNT_SET = {
  errors: ["Lorem notice"],
  accounts: [
    {
      id: "acc_1",
      name: "Lorem",
      currency: "USD",
      transactions: [
        {
          id: "t1",
          posted: NOW_MS / 1000 - 60,
          amount: "-1.00",
          description: "Ipsum",
        },
      ],
    },
  ],
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function accountsFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eido-simplefin-"))
  dirs.push(dir)
  const path = join(dir, "accounts.json")
  writeFileSync(path, text)
  return path
}

function setup(
  options: {
    answer?: () => Promise<unknown>
    health?: GateConnectorHealth["connectors"]
    accountsFile?: string
  } = {}
) {
  const db = openIndex(":memory:")
  db.exec(
    "INSERT INTO entities (id, kind, name, tag, created_at) VALUES ('ent_a', 'personal', 'A', 'A', '2026-01-01T00:00:00Z')"
  )
  const answer = options.answer ?? (() => Promise.resolve(ACCOUNT_SET))
  const getAccounts = vi.fn(async () => parseAccountSet(await answer()))
  const client: SimpleFinClient = { getAccounts }
  const log =
    vi.fn<(event: string, fields?: Readonly<Record<string, string>>) => void>()
  let clock = NOW_MS
  const runtime = createSimpleFinRuntime({
    db,
    gate: { getConnectorHealth: () => Promise.resolve(options.health ?? []) },
    client,
    ...(options.accountsFile === undefined
      ? {}
      : { accountsFile: options.accountsFile }),
    log,
    now: () => clock,
  })
  return {
    db,
    runtime,
    getAccounts,
    log,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("SimpleFIN runtime", () => {
  it("syncs, logs counts only, and skips until the interval has passed", async () => {
    const { runtime, getAccounts, log, advance } = setup({
      accountsFile: accountsFile('{"acc_1":"ent_a"}'),
    })
    await runtime.sync()
    expect(log.mock.calls).toEqual([
      [
        "simplefin_synced",
        { windows: "1", transactions: "1", rejected: "0", unassigned: "0" },
      ],
    ])
    expect(runtime.messages()).toEqual(["Lorem notice"])
    advance(SIMPLEFIN_SYNC_INTERVAL_MS - 1)
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(1)
    advance(1)
    await runtime.sync()
    expect(getAccounts).toHaveBeenCalledTimes(2)
  })

  it("reports accounts without an entity when no accounts file exists", async () => {
    const { runtime } = setup({
      accountsFile: "/nonexistent/eido/accounts.json",
    })
    await runtime.sync()
    expect(runtime.messages()).toEqual([
      "1 account needs an entity",
      "Lorem notice",
    ])
  })

  it("runs one sync at a time", async () => {
    const { runtime, getAccounts } = setup()
    await Promise.all([runtime.sync(), runtime.sync()])
    expect(getAccounts).toHaveBeenCalledTimes(1)
  })

  it("defers on the daily limit and logs other gate refusals by code", async () => {
    for (const [code, event] of [
      ["daily_limit", "simplefin_sync_deferred"],
      ["unauthorized", "simplefin_sync_failed"],
    ] as const) {
      const { runtime, log, db } = setup({
        answer: () => Promise.reject(new SimpleFinError(code, "refused")),
      })
      await runtime.sync()
      expect(log.mock.calls).toEqual([[event, { reason: code }]])
      expect(runtime.messages()).toEqual([])
      expect(db.prepare("SELECT COUNT(*) AS n FROM cursors").get()).toEqual({
        n: 0,
      })
    }
  })

  it("does not read while the gate holds the connector open", async () => {
    const { runtime, getAccounts, log } = setup({
      health: [
        {
          name: "simplefin",
          health: "open",
          consecutiveFailures: 3,
          nextAttemptAt: "2026-03-02T00:00:00.000Z",
          lastError: "upstream_5xx",
        },
      ],
    })
    await runtime.sync()
    expect(getAccounts).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it("surfaces a broken accounts file as a health message", async () => {
    const { runtime, getAccounts, log } = setup({
      accountsFile: accountsFile("[1]"),
    })
    await runtime.sync()
    const reason =
      "the SimpleFIN accounts file must be a JSON object of account id to entity id"
    expect(runtime.messages()).toEqual([reason])
    expect(log.mock.calls).toEqual([["simplefin_sync_failed", { reason }]])
    expect(getAccounts).not.toHaveBeenCalled()
  })
})

describe("withSimpleFinMessages", () => {
  const rows: GateConnectorHealth["connectors"] = [
    { name: "gmail", health: "healthy", consecutiveFailures: 0 },
    { name: "simplefin", health: "healthy", consecutiveFailures: 0 },
  ]

  it("adds the runtime's messages to the SimpleFIN record only", async () => {
    const read = withSimpleFinMessages(
      () => Promise.resolve(rows),
      () => ["1 account needs an entity"]
    )
    expect(await read()).toEqual([
      { name: "gmail", health: "healthy", consecutiveFailures: 0 },
      {
        name: "simplefin",
        health: "healthy",
        consecutiveFailures: 0,
        messages: ["1 account needs an entity"],
      },
    ])
  })

  it("leaves the records unchanged when there are no messages", async () => {
    const read = withSimpleFinMessages(
      () => Promise.resolve(rows),
      () => []
    )
    expect(await read()).toEqual(rows)
  })
})
