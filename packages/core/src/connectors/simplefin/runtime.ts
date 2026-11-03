import type { DatabaseSync } from "node:sqlite"
import type { GateConnectorHealth } from "@eido/schemas"
import { createHealthAwareSync } from "../health-aware-sync"
import type { ConnectorHealthReader } from "../health-aware-sync"
import { readAccountAssignments } from "./assignments"
import { scrubUrls, SimpleFinError } from "./client"
import type { SimpleFinClient } from "./client"
import { SIMPLEFIN_CONNECTOR } from "./config"
import type { SimpleFinConfig, SyncTime } from "./config"
import { nextLocalMidnight, nextSyncAtMs, syncDue } from "./schedule"
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
  /** The local time of day to sync at; absent: every SIMPLEFIN_SYNC_INTERVAL_MS. */
  syncTime?: SyncTime
  log: (event: string, fields?: Readonly<Record<string, string>>) => void
  now?: () => number
}

/** Why a sync on request did not run: the daily budget is spent, the gate holds the connector, or the read failed. */
export type SimpleFinSyncNowResult =
  | { status: "synced"; nextSyncAt: string }
  | {
      status: "refused"
      reason: "daily_limit" | "connector_unavailable" | "sync_failed"
      /** Set for daily_limit: the next local midnight, when the budget starts over. */
      nextSyncAt?: string
    }

export interface SimpleFinRuntime {
  /** The scheduled run: does nothing unless a sync is due. */
  sync: () => Promise<void>
  /** A sync now, whatever the schedule. Counts against the daily budget; refused when it is spent. */
  syncNow: () => Promise<SimpleFinSyncNowResult>
  /** Messages for `/connectors/health`: the last run's, or the reason it failed locally. */
  messages: () => readonly string[]
  /** When the next scheduled sync starts (now, when one is due), as an ISO time. */
  nextSyncAt: () => string
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
  let running: Promise<SimpleFinSyncNowResult> | undefined
  const healthAware = createHealthAwareSync(options.gate, now)
  const budgetSpent = async (): Promise<boolean> => {
    const record = (await options.gate.getConnectorHealth()).find(
      (connector) => connector.name === SIMPLEFIN_CONNECTOR
    )
    return (
      record?.requestsToday !== undefined &&
      record.requestLimit !== undefined &&
      record.requestsToday >= record.requestLimit
    )
  }
  const deferred = (): SimpleFinSyncNowResult => {
    options.log("simplefin_sync_deferred", { reason: "daily_limit" })
    return {
      status: "refused",
      reason: "daily_limit",
      nextSyncAt: new Date(nextLocalMidnight(now())).toISOString(),
    }
  }
  const nextSyncAt = (): string =>
    new Date(
      nextSyncAtMs(now(), lastStoredAt(options.db), options.syncTime)
    ).toISOString()
  const run = async (): Promise<SimpleFinSyncNowResult> => {
    try {
      if (await budgetSpent()) return deferred()
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
      if (result.status === "skipped") {
        return { status: "refused", reason: "connector_unavailable" }
      }
      messages = result.result.messages
      options.log("simplefin_synced", {
        windows: String(result.result.windows),
        transactions: String(result.result.transactionsStored),
        linked: String(result.result.paymentsLinked),
        rejected: String(result.result.rejectedTransactions),
        unassigned: String(result.result.unassignedAccounts),
      })
      return { status: "synced", nextSyncAt: nextSyncAt() }
    } catch (error) {
      if (error instanceof SimpleFinError) {
        if (error.code === "daily_limit") return deferred()
        options.log("simplefin_sync_failed", { reason: error.code })
        return { status: "refused", reason: "sync_failed" }
      }
      const reason = scrubUrls(
        error instanceof Error ? error.message : "unknown error"
      )
      messages = [reason]
      options.log("simplefin_sync_failed", { reason })
      return { status: "refused", reason: "sync_failed" }
    }
  }
  // One run at a time: a call that arrives during a run shares its outcome.
  const start = (): Promise<SimpleFinSyncNowResult> => {
    running ??= run().finally(() => {
      running = undefined
    })
    return running
  }
  return {
    sync: async () => {
      if (
        running !== undefined ||
        syncDue(now(), lastStoredAt(options.db), options.syncTime)
      ) {
        await start()
      }
    },
    syncNow: start,
    messages: () => messages,
    nextSyncAt,
  }
}

/**
 * Adds the runtime's messages and, when the gate reports none, the schedule's `nextSyncAt` to the
 * gate's SimpleFIN health record. The gate sets `nextSyncAt` itself when the daily budget is spent
 * (the next local midnight), and an open connector waits on `nextAttemptAt`; both win.
 */
export function withSimpleFinStatus(
  read: () => Promise<GateConnectorHealth["connectors"]>,
  runtime: Pick<SimpleFinRuntime, "messages" | "nextSyncAt">
): () => Promise<GateConnectorHealth["connectors"]> {
  return async () => {
    const current = runtime.messages()
    return (await read()).map((connector) => {
      if (connector.name !== SIMPLEFIN_CONNECTOR) return connector
      return {
        ...connector,
        ...(current.length > 0 ? { messages: [...current] } : {}),
        ...(connector.nextSyncAt === undefined && connector.health !== "open"
          ? { nextSyncAt: runtime.nextSyncAt() }
          : {}),
      }
    })
  }
}
