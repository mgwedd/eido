// Synthetic SimpleFIN sync and health payloads for the Settings sync row. Imported by tests only;
// never by app code (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import type { CoreApiSimpleFinSync, GateConnectorHealth } from "@eido/schemas"

export const NEXT_SYNC_AT = "2026-11-04T15:00:00.000Z"
export const MIDNIGHT_AT = "2026-11-05T05:00:00.000Z"

export function health(
  row: Partial<GateConnectorHealth["connectors"][number]> = {}
): GateConnectorHealth {
  return {
    connectors: [
      {
        name: "simplefin",
        health: "healthy",
        consecutiveFailures: 0,
        requestsToday: 3,
        requestLimit: 24,
        nextSyncAt: NEXT_SYNC_AT,
        ...row,
      },
    ],
  }
}

export const synced: CoreApiSimpleFinSync = {
  status: "synced",
  nextSyncAt: NEXT_SYNC_AT,
}

export function refused(
  reason: NonNullable<CoreApiSimpleFinSync["reason"]>,
  nextSyncAt?: string
): CoreApiSimpleFinSync {
  return {
    status: "refused",
    reason,
    ...(nextSyncAt === undefined ? {} : { nextSyncAt }),
  }
}
