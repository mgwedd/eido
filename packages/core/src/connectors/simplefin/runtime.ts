import type { DatabaseSync } from "node:sqlite"
import type { GateConnectorHealth } from "@eido/schemas"
import { createHealthAwareSync } from "../health-aware-sync"
import type { ConnectorHealthReader } from "../health-aware-sync"
import { readAccountAssignments } from "./assignments"
import { scrubUrls, SimpleFinError } from "./client"
import type { SimpleFinClient } from "./client"
import { SIMPLEFIN_CONNECTOR, SIMPLEFIN_SYNC_INTERVAL_MS } from "./config"
import type { SimpleFinConfig } from "./config"
import { syncSimpleFin } from "./sync"

// The data plane's scheduled SimpleFIN sync: skipped while the gate holds the connector open, and
// when the last stored window is younger than the interval (so a restart does not spend a request).
// Log fields carry short codes and counts only, never a response body or URL.

export interface SimpleFinRuntimeOptions {
  db: DatabaseSync
  gate: ConnectorHealthReader
  client: SimpleFinClient
  /** The local account-to-entity file; read on every run. */
  accountsFile?: string
  config?: Partial<SimpleFinConfig>
  log: (event: string, fields?: Readonly<Record<string, string>>) => void
  now?: () => number
}

export interface SimpleFinRuntime {
  sync: () => Promise<void>
  /** Messages for `/connectors/health`: the last run's, or the reason it failed locally. */
  messages: () => readonly string[]
}

function lastStoredAt(db: DatabaseSync): number | undefined {
  const row = db
    .prepare(
      "SELECT updated_at FROM cursors WHERE connector = ? AND stream = 'transactions'"
    )
    .get(SIMPLEFIN_CONNECTOR)
  const at = Date.parse(String(row?.["updated_at"]))
  return Number.isNaN(at) ? undefined : at
}

export function createSimpleFinRuntime(
  options: SimpleFinRuntimeOptions
): SimpleFinRuntime {
  const now = options.now ?? Date.now
  let messages: readonly string[] = []
  let running: Promise<void> | undefined
  const healthAware = createHealthAwareSync(options.gate, now)
  const run = async (): Promise<void> => {
    const last = lastStoredAt(options.db)
    if (last !== undefined && now() - last < SIMPLEFIN_SYNC_INTERVAL_MS) return
    try {
      const assignments = readAccountAssignments(options.accountsFile)
      const result = await healthAware(SIMPLEFIN_CONNECTOR, () =>
        syncSimpleFin({
          db: options.db,
          client: options.client,
          assignments,
          ...(options.config === undefined ? {} : { config: options.config }),
          now,
        })
      )
      if (result.status === "skipped") return
      messages = result.result.messages
      options.log("simplefin_synced", {
        windows: String(result.result.windows),
        transactions: String(result.result.transactionsStored),
        rejected: String(result.result.rejectedTransactions),
        unassigned: String(result.result.unassignedAccounts),
      })
    } catch (error) {
      if (error instanceof SimpleFinError) {
        options.log(
          error.code === "daily_limit"
            ? "simplefin_sync_deferred"
            : "simplefin_sync_failed",
          { reason: error.code }
        )
        return
      }
      const reason = scrubUrls(
        error instanceof Error ? error.message : "unknown error"
      )
      messages = [reason]
      options.log("simplefin_sync_failed", { reason })
    }
  }
  return {
    sync: () => {
      running ??= run().finally(() => {
        running = undefined
      })
      return running
    },
    messages: () => messages,
  }
}

/** Adds the runtime's messages to the gate's SimpleFIN health record, when there are any. */
export function withSimpleFinMessages(
  read: () => Promise<GateConnectorHealth["connectors"]>,
  messages: () => readonly string[]
): () => Promise<GateConnectorHealth["connectors"]> {
  return async () => {
    const current = messages()
    return (await read()).map((connector) =>
      connector.name === SIMPLEFIN_CONNECTOR && current.length > 0
        ? { ...connector, messages: [...current] }
        : connector
    )
  }
}
