import { createECDH, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { propose } from "./intents"
import { createPushNotifier, pushPayload } from "./push-notify"
import {
  preparePushRegistration,
  pushSubscriptions,
  registerPushSubscription,
} from "./push-subscriptions"
import { auditRows, controlAuthorization, sample, setup } from "./test-fixtures"

function keys() {
  const receiver = createECDH("prime256v1")
  receiver.generateKeys()
  return {
    p256dh: receiver
      .getPublicKey(undefined, "uncompressed")
      .toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  }
}

function privateKey(): string {
  const signer = createECDH("prime256v1")
  signer.generateKeys()
  return signer.getPrivateKey().toString("base64url")
}

function requestUrl(value: string | URL | Request): string {
  return typeof value === "string"
    ? value
    : value instanceof URL
      ? value.href
      : value.url
}

describe("count-only Web Push", () => {
  it("refuses a negative or non-integer count before it can reach the wire", () => {
    expect(() => pushPayload(-1)).toThrow("invalid pending count")
    expect(() => pushPayload(1.5)).toThrow("invalid pending count")
  })

  it("serializes only version and pending count across several sensitive intent kinds", () => {
    const s = setup()
    try {
      const kinds = ["email.send", "email.reply", "email.forward"] as const
      const sensitive = [
        "secret-subject-a",
        "private-recipient@example.invalid",
        "secret-body-b",
      ]
      for (const [index, kind] of kinds.entries()) {
        const intent = sample(kind, {
          to: [sensitive[1]],
          ...(kind === "email.send" ? { subject: sensitive[0] } : {}),
          ...(kind === "email.forward" ? {} : { body: sensitive[2] }),
        })
        const result = propose(s.db, s.policy, { intent, origin: "reactive" })
        expect(result.ok).toBe(true)
        const wire = pushPayload(
          Number(
            s.db
              .prepare(
                "SELECT count(*) AS n FROM intents WHERE state = 'pending'"
              )
              .get()?.["n"]
          )
        )
        expect(wire).toBe(JSON.stringify({ v: 1, pending: index + 1 }))
        for (const secret of sensitive) expect(wire).not.toContain(secret)
        expect(wire).not.toContain(kind)
        expect(wire).not.toContain(JSON.stringify(intent.args))
      }
    } finally {
      s.cleanup()
    }
  })

  it("coalesces pending transitions and revokes a 410 subscription before retry", async () => {
    const s = setup()
    let time = 1_000
    const subscription = {
      endpoint: "https://push.example.invalid/send/one",
      ...keys(),
    }
    const prepared = preparePushRegistration(s.db, subscription)
    const auth = controlAuthorization(s.db, prepared)
    const id = registerPushSubscription(s.db, subscription, auth)
    const sent: string[] = []
    const notifier = createPushNotifier({
      db: s.db,
      now: () => time,
      windowMs: 60_000,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: (url) => {
        sent.push(requestUrl(url))
        return Promise.resolve(new Response(null, { status: 410 }))
      },
    })
    try {
      for (const kind of ["email.send", "email.reply"] as const) {
        const result = propose(s.db, s.policy, {
          intent: sample(kind),
          origin: "reactive",
        })
        expect(result.ok).toBe(true)
        notifier.notifyPending()
      }
      expect(await notifier.flushDue()).toBe(false)
      time = 61_000
      expect(await notifier.flushDue()).toBe(true)
      expect(sent).toEqual([subscription.endpoint])
      expect(pushSubscriptions(s.db)).toEqual([])
      notifier.notifyPending()
      time = 121_000
      expect(await notifier.flushDue()).toBe(true)
      expect(sent).toEqual([subscription.endpoint])
      expect(
        auditRows(s.db).some(
          (row) => row.action === "push.gone" && row.target === id
        )
      ).toBe(true)
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("refuses and audits an endpoint changed after its signed approval", async () => {
    const s = setup()
    let time = 1_000
    const subscription = {
      endpoint: "https://push.example.invalid/send/one",
      ...keys(),
    }
    const prepared = preparePushRegistration(s.db, subscription)
    const auth = controlAuthorization(s.db, prepared)
    const id = registerPushSubscription(s.db, subscription, auth)
    s.db
      .prepare("UPDATE push_subscriptions SET endpoint = ? WHERE id = ?")
      .run("https://attacker.example.invalid/send", id)
    const sent: string[] = []
    const notifier = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: (url) => {
        sent.push(requestUrl(url))
        return Promise.resolve(new Response(null, { status: 201 }))
      },
    })
    try {
      const result = propose(s.db, s.policy, {
        intent: sample("email.send"),
        origin: "reactive",
      })
      expect(result.ok).toBe(true)
      notifier.notifyPending()
      time = 61_000
      expect(await notifier.flushDue()).toBe(true)
      expect(sent).toEqual([])
      expect(
        auditRows(s.db).some(
          (row) => row.action === "push.refused_egress" && row.target === id
        )
      ).toBe(true)
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("keeps a pending window durable across notifier restart and sends once when the key is available", async () => {
    const s = setup()
    let time = 1_000
    const subscription = {
      endpoint: "https://push.example.invalid/send/two",
      ...keys(),
    }
    registerPushSubscription(
      s.db,
      subscription,
      controlAuthorization(s.db, preparePushRegistration(s.db, subscription))
    )
    const proposed = propose(s.db, s.policy, {
      intent: sample("email.send"),
      origin: "reactive",
    })
    expect(proposed.ok).toBe(true)
    const first = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(undefined),
      fetch: () => Promise.reject(new Error("should not fetch without a key")),
    })
    first.notifyPending()
    first.close()
    const sent: string[] = []
    const second = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: (url) => {
        sent.push(requestUrl(url))
        return Promise.resolve(new Response(null, { status: 201 }))
      },
    })
    try {
      time = 61_000
      expect(await second.flushDue()).toBe(true)
      expect(await second.flushDue()).toBe(false)
      expect(sent).toEqual([subscription.endpoint])
      expect(auditRows(s.db).some((row) => row.action === "push.sent")).toBe(
        true
      )
      second.notifyPending()
      time = 121_000
      expect(await second.flushDue()).toBe(true)
      expect(sent).toEqual([subscription.endpoint, subscription.endpoint])
    } finally {
      second.close()
      s.cleanup()
    }
  })

  it("audits a missing vault key and a failed push service without leaking the endpoint", async () => {
    const s = setup()
    let time = 1_000
    const subscription = {
      endpoint: "https://push.example.invalid/send/three",
      ...keys(),
    }
    const id = registerPushSubscription(
      s.db,
      subscription,
      controlAuthorization(s.db, preparePushRegistration(s.db, subscription))
    )
    const proposed = propose(s.db, s.policy, {
      intent: sample("email.send"),
      origin: "reactive",
    })
    expect(proposed.ok).toBe(true)
    let key: string | undefined
    let calls = 0
    const notifier = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(key),
      fetch: () => {
        calls++
        return Promise.reject(new Error("synthetic network failure"))
      },
    })
    try {
      notifier.notifyPending()
      time = 61_000
      expect(await notifier.flushDue()).toBe(true)
      expect(calls).toBe(0)
      key = privateKey()
      notifier.notifyPending()
      time = 121_000
      expect(await notifier.flushDue()).toBe(true)
      expect(calls).toBe(1)
      expect(
        auditRows(s.db)
          .filter((row) => row.target === id)
          .map((row) => row.action)
      ).toEqual(["push.unavailable", "push.failed"])
      expect(JSON.stringify(auditRows(s.db))).not.toContain(
        subscription.endpoint
      )
    } finally {
      notifier.close()
      s.cleanup()
    }
  })
})
