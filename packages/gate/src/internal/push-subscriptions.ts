import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { GatePushSubscription } from "@eido/schemas"
import { validateGatePushSubscription } from "@eido/schemas"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import {
  approvedControlValue,
  controlApprovalChallenge,
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import type { ControlAuthorization } from "./control-approvals"
import { validatePushKeys } from "./push-crypto"

export type PushSubscription = GatePushSubscription & {
  id: string
  approvalId: string
}

/** An HTTPS subscription is an exact destination, never a wildcard or a connector grant. */
export function checkedSubscription(value: unknown): GatePushSubscription {
  const checked = validateGatePushSubscription(value)
  if (
    !checked.ok ||
    !validatePushKeys(checked.value.p256dh, checked.value.auth)
  )
    throw new Error("invalid push subscription")
  const subscription = checked.value
  let url: URL
  try {
    url = new URL(subscription.endpoint)
  } catch {
    throw new Error("invalid push subscription")
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal)$/i.test(url.hostname) ||
    subscription.endpoint !== url.href
  )
    throw new Error("invalid push subscription")
  return subscription
}

function binding(subscription: GatePushSubscription) {
  return {
    origin: new URL(subscription.endpoint).origin,
    endpointHash: payloadHash(subscription.endpoint),
    keysHash: payloadHash({
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    }),
  }
}
function target(subscription: GatePushSubscription): string {
  return `push:${payloadHash(subscription.endpoint)}`
}
const detail = (hash: string, ref: string) =>
  payloadHash({ subscriptionHash: hash, approvalRefHash: ref })

export function preparePushRegistration(db: DatabaseSync, value: unknown) {
  const subscription = checkedSubscription(value)
  const prepared = prepareControlApproval(
    db,
    "policy.set",
    target(subscription),
    binding(subscription)
  )
  return { ...prepared, challenge: controlApprovalChallenge(prepared) }
}

export function registerPushSubscription(
  db: DatabaseSync,
  value: unknown,
  authorization?: ControlAuthorization
): string {
  const subscription = checkedSubscription(value)
  const hash = payloadHash(binding(subscription))
  return withControlApproval(
    db,
    "policy.set",
    target(subscription),
    hash,
    authorization,
    (ref, approvalId) => {
      const id = randomUUID()
      // Re-registration revokes the previous binding, including its signed egress permission.
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(
        subscription.endpoint
      )
      db.prepare(
        "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at, revoked_at, approval_id) VALUES (?, ?, ?, ?, ?, NULL, ?)"
      ).run(
        id,
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        new Date().toISOString(),
        approvalId
      )
      const { seq } = append(db, {
        actor: "approver",
        action: "push.registered",
        target: target(subscription),
        detailHash: detail(hash, ref),
      })
      return { result: id, auditSeq: seq }
    }
  )
}

export function removePushSubscription(
  db: DatabaseSync,
  id: string,
  actor: "approver" | "system" = "approver"
): void {
  const changed = db
    .prepare(
      "UPDATE push_subscriptions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    )
    .run(new Date().toISOString(), id)
  if (Number(changed.changes))
    append(db, {
      actor,
      action: "push.removed",
      target: id,
      detailHash: payloadHash({ subscriptionId: id }),
    })
}

export function pushSubscriptions(db: DatabaseSync): PushSubscription[] {
  return db
    .prepare(
      "SELECT * FROM push_subscriptions WHERE revoked_at IS NULL ORDER BY id"
    )
    .all()
    .map((row) => ({
      id: String(row["id"]),
      endpoint: String(row["endpoint"]),
      p256dh: String(row["p256dh"]),
      auth: String(row["auth"]),
      approvalId: String(row["approval_id"]),
    }))
}

/** Persisted allowlist provenance is checked at egress, not trusted from a caller or DB row. */
export function pushEgressAllowed(
  db: DatabaseSync,
  subscription: PushSubscription
): boolean {
  try {
    checkedSubscription({
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    })
    const live = pushSubscriptions(db).find((s) => s.id === subscription.id)
    return (
      live !== undefined &&
      live.endpoint === subscription.endpoint &&
      live.p256dh === subscription.p256dh &&
      live.auth === subscription.auth &&
      live.approvalId === subscription.approvalId &&
      approvedControlValue(
        db,
        subscription.approvalId,
        "policy.set",
        target(subscription),
        payloadHash(binding(subscription)),
        "push.registered",
        (ref) => detail(payloadHash(binding(subscription)), ref)
      )
    )
  } catch {
    return false
  }
}
