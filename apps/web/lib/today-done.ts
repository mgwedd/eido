import type { AuditEntry } from "@/lib/activity"

/** How many automatic actions the Today card shows. */
export const DONE_LIMIT = 3

/**
 * The latest automatic actions that can be undone or already were. Entries come newest
 * first from the gate. Automatic rows with no undo (access events, for example) are not
 * "done for you", so they stay in the audit log only.
 */
export function selectDoneAutomatically(
  entries: readonly AuditEntry[],
  limit: number = DONE_LIMIT
): AuditEntry[] {
  return entries
    .filter((entry) => entry.displayActor === "auto" && entry.undo !== "none")
    .slice(0, limit)
}
