import { createECDH, randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { propose } from "./intents"
import { createPushNotifier, pushPayload } from "./push-notify"
import { generateVapidPrivateKey } from "./push-crypto"
import {
  checkedSubscription,
  preparePushRegistration,
  pushEgressAllowed,
  pushSubscriptions,
  registerPushSubscription,
  removePushSubscription,
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
  return generateVapidPrivateKey()
}

function requestUrl(value: string | URL | Request): string {
  return typeof value === "string"
    ? value
    : value instanceof URL
      ? value.href
      : value.url
}

describe("count-only Web Push", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
  afterEach(() => vi.useRealTimers())

  it.each([
    "http://push.example.invalid/send",
    "https://push.example.invalid:444/send",
    "https://user@push.example.invalid/send",
    "https://push.example.invalid/send#fragment",
    "https://localhost/send",
    "https://127.0.0.1/send",
    "https://push.example.invalid/old/../send",
  ])("rejects an unsafe or noncanonical endpoint: %s", (endpoint) => {
    expect(() => checkedSubscription({ endpoint, ...keys() })).toThrow(
      "invalid push subscription"
    )
  })

  it("refuses a subscription whose authentication secret is malformed", () => {
    expect(() =>
      checkedSubscription({
        endpoint: "https://push.example.invalid/send",
        ...keys(),
        auth: "short",
      })
    ).toThrow("invalid push subscription")
  })

  it("requires signed endpoint authority at egress and revokes it on removal", () => {
    const s = setup()
    try {
      const subscription = {
        endpoint: "https://push.example.invalid/send/auth",
        ...keys(),
      }
      expect(() => registerPushSubscription(s.db, subscription)).toThrow(
        "control approval refused"
      )
      const prepared = preparePushRegistration(s.db, subscription)
      const authorization = controlAuthorization(s.db, prepared)
      const id = registerPushSubscription(s.db, subscription, authorization)
      const stored = pushSubscriptions(s.db).find((item) => item.id === id)
      if (stored === undefined)
        throw new Error("signed subscription is missing")
      expect(pushEgressAllowed(s.db, stored)).toBe(true)
      expect(() =>
        registerPushSubscription(s.db, subscription, authorization)
      ).toThrow("control approval refused")
      removePushSubscription(s.db, id)
      expect(pushEgressAllowed(s.db, stored)).toBe(false)
      const auditCount = auditRows(s.db).length
      removePushSubscription(s.db, id)
      expect(auditRows(s.db).length).toBe(auditCount)
    } finally {
      s.cleanup()
    }
  })

  it("does not read the vault or send when nobody is subscribed", async () => {
    const s = setup()
    let time = 1_000
    let keyReads = 0
    const notifier = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => {
        keyReads++
        return Promise.resolve(privateKey())
      },
      fetch: () => Promise.reject(new Error("there is no approved endpoint")),
    })
    try {
      const proposed = propose(s.db, s.policy, {
        intent: sample("email.send"),
        origin: "reactive",
      })
      expect(proposed.ok).toBe(true)
      notifier.notifyPending()
      time = 61_000
      expect(await notifier.flushDue()).toBe(true)
      expect(keyReads).toBe(0)
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("keeps a subscription after a temporary push-service failure", async () => {
    const s = setup()
    let time = 1_000
    const subscription = {
      endpoint: "https://push.example.invalid/send/retry",
      ...keys(),
    }
    const id = registerPushSubscription(
      s.db,
      subscription,
      controlAuthorization(s.db, preparePushRegistration(s.db, subscription))
    )
    const notifier = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    })
    try {
      const proposed = propose(s.db, s.policy, {
        intent: sample("email.send"),
        origin: "reactive",
      })
      expect(proposed.ok).toBe(true)
      notifier.notifyPending()
      time = 61_000
      expect(await notifier.flushDue()).toBe(true)
      expect(pushSubscriptions(s.db).map((item) => item.id)).toEqual([id])
      expect(
        auditRows(s.db).some(
          (row) => row.action === "push.failed" && row.target === id
        )
      ).toBe(true)
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("refuses a negative or non-integer count before it can reach the wire", () => {
    expect(() => pushPayload(-1)).toThrow("invalid pending count")
    expect(() => pushPayload(1.5)).toThrow("invalid pending count")
    expect(() => pushPayload(Number.NaN)).toThrow("invalid pending count")
  })

  it("rejects a zero coalescing window and skips delivery when the queue has cleared", async () => {
    const s = setup()
    let time = 1_000
    const options = {
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: () =>
        Promise.reject(new Error("an empty queue must not trigger fetch")),
    }
    try {
      expect(() => createPushNotifier({ ...options, windowMs: 0 })).toThrow(
        "invalid push window"
      )
      const notifier = createPushNotifier(options)
      try {
        notifier.notifyPending()
        time = 61_000
        expect(await notifier.flushDue()).toBe(true)
        expect(
          auditRows(s.db).some((row) => row.action.startsWith("push."))
        ).toBe(false)
      } finally {
        notifier.close()
      }
    } finally {
      s.cleanup()
    }
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

  it.each([404, 410])(
    "coalesces pending transitions and revokes a %i subscription before retry",
    async (status) => {
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
          return Promise.resolve(new Response(null, { status }))
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
    }
  )

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
    // This test advances its injected clock directly; keep real timers from
    // claiming the window if the macOS runner pauses while the test is active.
    const windowMs = 24 * 60 * 60 * 1_000
    const subscription = {
      endpoint: "https://push.example.invalid/send/two",
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
    const first = createPushNotifier({
      db: s.db,
      now: () => time,
      windowMs,
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
      windowMs,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: (url) => {
        sent.push(requestUrl(url))
        return Promise.resolve(new Response(null, { status: 201 }))
      },
    })
    try {
      time = 1_000 + windowMs
      expect(await second.flushDue()).toBe(true)
      expect(await second.flushDue()).toBe(false)
      expect(sent).toEqual([subscription.endpoint])
      expect(
        auditRows(s.db)
          .filter((row) => row.action === "push.sent")
          .map((row) => row.target)
      ).toEqual([id])
      second.notifyPending()
      time = 1_000 + 2 * windowMs
      expect(await second.flushDue()).toBe(true)
      expect(sent).toEqual([subscription.endpoint, subscription.endpoint])
      expect(
        auditRows(s.db)
          .filter((row) => row.action === "push.sent")
          .map((row) => row.target)
      ).toEqual([id, id])
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
