import type { DatabaseSync } from "node:sqlite"
import { validateIntent } from "@eido/schemas"
import type { AskFollowUp } from "@eido/schemas"
import { LIVE_DOCUMENT_PREDICATE } from "../index/heads"

/** Only matching messages actually read, never surrounding thread context or answer prose. */
export function indexedFollowUps(
  db: DatabaseSync,
  matchingIds: readonly string[],
  packedIds: ReadonlySet<string>
): AskFollowUp[] {
  const messageIds = new Set<string>()
  const lookup = db.prepare(`
    SELECT d.source_ref FROM documents d
    JOIN document_text t ON t.sha256 = d.sha256
    WHERE d.sha256 = ? AND ${LIVE_DOCUMENT_PREDICATE}
      AND d.source = 'gmail' AND d.mime = 'message/rfc822'
      AND t.attachment_of IS NULL
  `)
  for (const id of matchingIds) {
    if (!packedIds.has(id)) continue
    const ref = lookup.get(id)?.["source_ref"]
    if (typeof ref === "string") messageIds.add(ref)
    if (messageIds.size === 50) break
  }
  if (messageIds.size === 0) return []
  const ids = [...messageIds]
  const candidates = [
    {
      label: "Archive matching emails",
      intent: {
        kind: "email.archive",
        connector: "gmail",
        args: { messageIds: ids },
      },
    },
    {
      label: "Mark matching emails as read",
      intent: {
        kind: "email.markRead",
        connector: "gmail",
        args: { messageIds: ids, read: true },
      },
    },
  ]
  return candidates.flatMap(({ label, intent }) => {
    const checked = validateIntent(intent)
    return checked.ok ? [{ label, intent: checked.value }] : []
  })
}
