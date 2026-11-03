import type { DatabaseSync } from "node:sqlite"
import { validateIntent } from "@eido/schemas"
import type { GateProposeResult } from "@eido/schemas"
import { payloadHash } from "./canonical"
import { executionReceipt } from "./executor"
import { propose } from "./intents"
import { kindTier } from "./policy"
import type { Policy } from "./policy"
import { atomically } from "./transaction"

/** Propose Trash for exactly the message created by a successful Gmail draft write. */
export function proposeDraftDiscard(
  db: DatabaseSync,
  policy: Policy,
  sourceId: string
): GateProposeResult | undefined {
  return atomically(db, () => {
    const source = db
      .prepare(
        "SELECT kind, state, payload_json, payload_hash FROM intents WHERE id=?"
      )
      .get(sourceId)
    const receipt = executionReceipt(db, sourceId)
    if (
      source?.["kind"] !== "email.draft" ||
      source["state"] !== "executed" ||
      receipt === undefined
    )
      return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(String(source["payload_json"]))
    } catch {
      return undefined
    }
    const checked = validateIntent(parsed)
    const result = receipt.result
    if (
      !checked.ok ||
      checked.value.kind !== "email.draft" ||
      checked.value.connector !== "gmail" ||
      payloadHash(checked.value) !== source["payload_hash"] ||
      typeof result !== "object" ||
      result === null ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      result.id.length === 0 ||
      result.id !== receipt.upstreamRef ||
      !("messageId" in result) ||
      typeof result.messageId !== "string"
    )
      return undefined
    const trash = validateIntent({
      kind: "email.trash",
      connector: "gmail",
      args: { messageIds: [result.messageId] },
    })
    // This compensation always requires an ordinary signed approval, even if an owner
    // override allows other Trash proposals to run automatically. Never execute here.
    if (
      !trash.ok ||
      kindTier(db, policy, "email.trash", "gmail").tier !== "approval"
    )
      return undefined
    const proposed = propose(db, policy, {
      intent: trash.value,
      origin: "reactive",
    })
    if (!proposed.ok) return undefined
    return { id: proposed.intentId, tier: proposed.tier, state: proposed.state }
  })
}

/**
 * Whether the executed Gmail draft `draftId` was discarded: an executed email.trash moved the
 * message its receipt names to Trash, and no executed email.untrash restored that trash. A
 * pending or rejected discard leaves the draft in place. False for any other intent.
 */
export function draftDiscarded(db: DatabaseSync, draftId: string): boolean {
  const source = db
    .prepare("SELECT kind, state FROM intents WHERE id=?")
    .get(draftId)
  if (source?.["kind"] !== "email.draft" || source["state"] !== "executed")
    return false
  const result = executionReceipt(db, draftId)?.result
  if (
    typeof result !== "object" ||
    result === null ||
    !("messageId" in result) ||
    typeof result.messageId !== "string"
  )
    return false
  const trashed = db
    .prepare(
      `SELECT 1 FROM intents t, json_each(t.payload_json, '$.args.messageIds') m
       WHERE t.kind = 'email.trash' AND t.state = 'executed' AND m.value = ?
       AND NOT EXISTS (
         SELECT 1 FROM intents u
         WHERE u.kind = 'email.untrash' AND u.state = 'executed'
         AND json_extract(u.payload_json, '$.args.sourceIntentId') = t.id
       )
       LIMIT 1`
    )
    .get(result.messageId)
  return trashed !== undefined
}
