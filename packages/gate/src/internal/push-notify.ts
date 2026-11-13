import type { DatabaseSync } from "node:sqlite"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import { encryptPush, vapidAuthorization } from "./push-crypto"
import {
  pushEgressAllowed,
  pushSubscriptions,
  removePushSubscription,
} from "./push-subscriptions"
import { atomically } from "./transaction"

export type PushClock = () => number
export type PushOptions = {
  db: DatabaseSync
  privateKey: () => Promise<string | undefined>
  subject: string
  fetch: typeof fetch
  now?: PushClock
  windowMs?: number
}

/** The only wire payload. Callers cannot pass an intent or its contents. */
export function pushPayload(pending: number): string {
  if (!Number.isSafeInteger(pending) || pending < 0)
    throw new Error("invalid pending count")
  return JSON.stringify({ v: 1, pending })
}

/** The recovery alert's only wire payload: that a recovery started, and nothing about it. */
export function recoveryPayload(): string {
  return JSON.stringify({ v: 1, recovery: "started" })
}

function auditRecoveryPush(db: DatabaseSync, action: string, id: string): void {
  append(db, {
    actor: "system",
    action: `push.recovery_${action}`,
    target: id,
    detailHash: payloadHash({ subscriptionId: id, recovery: "started" }),
  })
}

function pendingCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS count FROM intents WHERE state = 'pending'")
    .get()
  return Number(row?.["count"] ?? 0)
}

function auditPush(
  db: DatabaseSync,
  action: string,
  id: string,
  count: number
): void {
  append(db, {
    actor: "system",
    action: `push.${action}`,
    target: id,
    detailHash: payloadHash({ subscriptionId: id, pending: count }),
  })
}

/** Durable window: a restart resumes a scheduled push, and no pending intent body is stored. */
export function createPushNotifier(options: PushOptions) {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? 60_000
  if (!Number.isSafeInteger(windowMs) || windowMs < 1)
    throw new Error("invalid push window")
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let sending = false

  function dueAt(): number | undefined {
    const value = options.db
      .prepare("SELECT due_at FROM push_state WHERE singleton = 1")
      .get()?.["due_at"]
    return typeof value === "number" ? value : undefined
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer)
    if (closed) return
    const due = dueAt()
    if (due === undefined) return
    timer = setTimeout(
      () => {
        void flushDue().catch(() => undefined)
      },
      Math.max(0, due - now())
    )
    timer.unref()
  }

  function notifyPending(): void {
    if (closed) return
    atomically(options.db, () => {
      const row = options.db
        .prepare(
          "SELECT due_at, last_attempt_at FROM push_state WHERE singleton = 1"
        )
        .get()
      if (row?.["due_at"] !== null) return
      const last =
        typeof row?.["last_attempt_at"] === "number"
          ? row["last_attempt_at"]
          : 0
      options.db
        .prepare("UPDATE push_state SET due_at = ? WHERE singleton = 1")
        .run(Math.max(now() + windowMs, last + windowMs))
    })
    schedule()
  }

  async function deliver(
    subscription: ReturnType<typeof pushSubscriptions>[number],
    payload: string,
    key: string | undefined,
    current: number,
    record: (action: string) => void
  ): Promise<void> {
    if (!pushEgressAllowed(options.db, subscription)) {
      record("refused_egress")
      return
    }
    if (key === undefined) {
      record("unavailable")
      return
    }
    try {
      const wire = encryptPush(
        Buffer.from(payload),
        subscription.p256dh,
        subscription.auth
      )
      const response = await options.fetch(subscription.endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: vapidAuthorization(
            subscription.endpoint,
            key,
            options.subject,
            current
          ),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          "content-length": String(wire.length),
          ttl: "60",
        },
        body: new Uint8Array(wire),
      })
      if (response.status === 404 || response.status === 410) {
        removePushSubscription(options.db, subscription.id, "system")
        record("gone")
      } else {
        record(response.ok ? "sent" : "failed")
      }
    } catch {
      record("failed")
    }
  }

  /**
   * Alerts every verified subscription at once that a passkey recovery started (issue 682). Not
   * coalesced: the owner must see it inside the delay. The payload says only that, never why.
   */
  async function notifyRecovery(): Promise<void> {
    if (closed) return
    const subscriptions = pushSubscriptions(options.db)
    if (subscriptions.length === 0) return
    const key = await options.privateKey()
    const current = now()
    for (const subscription of subscriptions) {
      await deliver(subscription, recoveryPayload(), key, current, (action) =>
        auditRecoveryPush(options.db, action, subscription.id)
      )
    }
  }

  async function flushDue(): Promise<boolean> {
    if (closed || sending) return false
    const current = now()
    const claimed = atomically(options.db, () => {
      const due = dueAt()
      if (due === undefined || due > current) return false
      options.db
        .prepare(
          "UPDATE push_state SET due_at = NULL, last_attempt_at = ? WHERE singleton = 1"
        )
        .run(current)
      return true
    })
    if (!claimed) return false
    sending = true
    try {
      const count = pendingCount(options.db)
      if (count === 0) return true
      const subscriptions = pushSubscriptions(options.db)
      if (subscriptions.length === 0) return true
      const key = await options.privateKey()
      for (const subscription of subscriptions) {
        await deliver(
          subscription,
          pushPayload(count),
          key,
          current,
          (action) => auditPush(options.db, action, subscription.id, count)
        )
      }
      return true
    } finally {
      sending = false
      schedule()
    }
  }

  schedule()
  return {
    notifyPending,
    notifyRecovery,
    flushDue,
    close: () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
