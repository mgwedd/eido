import type { CoreApiSimpleFinSync } from "@eido/schemas"
import type { SimpleFinSyncNowResult } from "../connectors/simplefin/runtime"

/** POST /connectors/simplefin/sync (#546): a SimpleFIN sync on request. */
export const SIMPLEFIN_SYNC_PATH = "/connectors/simplefin/sync"

export type SimpleFinSyncer = () => Promise<SimpleFinSyncNowResult>

/** 200 when the sync ran; 409 when it was refused (daily limit, connector held, or a failed read). */
export async function simplefinSyncRoute(
  syncer: SimpleFinSyncer
): Promise<{ status: 200 | 409; body: CoreApiSimpleFinSync }> {
  const result = await syncer()
  return result.status === "synced"
    ? { status: 200, body: result }
    : { status: 409, body: result }
}
