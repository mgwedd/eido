import { createECDH, randomBytes, randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { append } from "./audit"
import { payloadHash } from "./canonical"
import {
  prepareControlApproval,
  withControlApproval,
} from "./control-approvals"
import { propose } from "./intents"
import { createPushNotifier, pushPayload, recoveryPayload } from "./push-notify"
import { generateVapidPrivateKey } from "./push-crypto"
import {
  PushHostRefused,
  checkedSubscription,
  preparePushRegistration,
  pushEgressAllowed,
  pushSubscriptions,
  registerPushSubscription,
  removePushSubscription,
  retireUnsupportedPushSubscriptions,
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

/**
 * Stores a signed subscription the way registration did before push hosts were checked (#789):
 * the same approval binding, row and audit entry, without `checkedSubscription`. It stands for a
 * subscription already in a gate's database when it upgrades.
 */
function storeUncheckedSubscription(
  db: DatabaseSync,
  subscription: { endpoint: string; p256dh: string; auth: string }
): string {
  const target = `push:${payloadHash(subscription.endpoint)}`
  const binding = {
    origin: new URL(subscription.endpoint).origin,
    endpointHash: payloadHash(subscription.endpoint),
    keysHash: payloadHash({
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    }),
  }
  const hash = payloadHash(binding)
  const prepared = prepareControlApproval(db, "policy.set", target, binding)
  return withControlApproval(
    db,
    "policy.set",
    target,
    hash,
    controlAuthorization(db, prepared),
    (ref, approvalId) => {
      const id = randomUUID()
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
        target,
        detailHash: payloadHash({
          subscriptionHash: hash,
          approvalRefHash: ref,
        }),
      })
      return { result: id, auditSeq: seq }
    }
  )
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
    "http://web.push.apple.com/send",
    "https://web.push.apple.com:444/send",
    "https://user@web.push.apple.com/send",
    "https://web.push.apple.com/send#fragment",
    "https://localhost/send",
    "https://127.0.0.1/send",
    "https://web.push.apple.com/old/../send",
  ])("rejects an unsafe or noncanonical endpoint: %s", (endpoint) => {
    expect(() => checkedSubscription({ endpoint, ...keys() })).toThrow(
      "invalid push subscription"
    )
  })

  it("refuses a subscription whose authentication secret is malformed", () => {
    expect(() =>
      checkedSubscription({
        endpoint: "https://web.push.apple.com/send",
        ...keys(),
        auth: "short",
      })
    ).toThrow("invalid push subscription")
  })

  it.each([
    "https://push.example.invalid/send",
    "https://web.push.apple.com.example.invalid/send",
    "https://example.invalid/web.push.apple.com/send",
  ])(
    "refuses a well-formed endpoint on a push host the gate does not send to: %s",
    (endpoint) => {
      expect(() => checkedSubscription({ endpoint, ...keys() })).toThrow(
        PushHostRefused
      )
    }
  )

  it("refuses to prepare or register a subscription on another push host, storing nothing", () => {
    const s = setup()
    try {
      const allowed = {
        endpoint: "https://web.push.apple.com/send/approved",
        ...keys(),
      }
      // A valid passkey approval, so only the host can be what refuses the registration.
      const authorization = controlAuthorization(
        s.db,
        preparePushRegistration(s.db, allowed)
      )
      const elsewhere = {
        ...allowed,
        endpoint: "https://push.example.invalid/send/approved",
      }
      const audited = auditRows(s.db).length
      expect(() => preparePushRegistration(s.db, elsewhere)).toThrow(
        PushHostRefused
      )
      expect(() =>
        registerPushSubscription(s.db, elsewhere, authorization)
      ).toThrow(PushHostRefused)
      expect(pushSubscriptions(s.db)).toEqual([])
      expect(auditRows(s.db).length).toBe(audited)
      // The refusal spent nothing: the same approval still registers the allowed endpoint.
      expect(
        typeof registerPushSubscription(s.db, allowed, authorization)
      ).toBe("string")
    } finally {
      s.cleanup()
    }
  })

  it("never posts to a stored subscription on another push host, for a count or a recovery alert", async () => {
    const s = setup()
    let time = 1_000
    const id = storeUncheckedSubscription(s.db, {
      endpoint: "https://push.example.invalid/send/stored",
      ...keys(),
    })
    // A control stored the same way on the allowed host: it must be posted, so the refusal above
    // comes from the host check and not from the helper's stored authority.
    storeUncheckedSubscription(s.db, {
      endpoint: "https://web.push.apple.com/send/stored",
      ...keys(),
    })
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
      await notifier.notifyRecovery()
      expect(sent).toEqual([
        "https://web.push.apple.com/send/stored",
        "https://web.push.apple.com/send/stored",
      ])
      // Retired, not refused again: the one audit row is the system removal, and no flush or
      // recovery alert adds a refused-egress row for it.
      expect(
        auditRows(s.db)
          .filter((row) => row.target === id)
          .map((row) => [row.actor, row.action])
      ).toEqual([["system", "push.removed"]])
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("retires a stored subscription on another push host once, keeping the row and the allowed one", () => {
    const s = setup()
    const elsewhere = storeUncheckedSubscription(s.db, {
      endpoint: "https://fcm.example.invalid/send/chrome",
      ...keys(),
    })
    const apple = storeUncheckedSubscription(s.db, {
      endpoint: "https://web.push.apple.com/send/kept",
      ...keys(),
    })
    try {
      expect(pushSubscriptions(s.db).map(({ id }) => id)).toEqual([apple])
      // Listing again, and each of the sender's own reads, adds nothing.
      pushSubscriptions(s.db)
      retireUnsupportedPushSubscriptions(s.db)
      const removed = auditRows(s.db).filter(
        (row) => row.action === "push.removed"
      )
      expect(removed.map((row) => [row.actor, row.target])).toEqual([
        ["system", elsewhere],
      ])
      // Revoked, not deleted: the row is still there for the owner's records.
      expect(
        s.db
          .prepare("SELECT revoked_at FROM push_subscriptions WHERE id = ?")
          .get(elsewhere)?.["revoked_at"]
      ).toEqual(expect.any(String))
      expect(
        s.db
          .prepare("SELECT revoked_at FROM push_subscriptions WHERE id = ?")
          .get(apple)?.["revoked_at"]
      ).toBeNull()
    } finally {
      s.cleanup()
    }
  })

  it("writes no refused-egress audit row on any flush for a subscription on another push host", async () => {
    const s = setup()
    let time = 1_000
    storeUncheckedSubscription(s.db, {
      endpoint: "https://fcm.example.invalid/send/chrome",
      ...keys(),
    })
    const notifier = createPushNotifier({
      db: s.db,
      now: () => time,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: () => Promise.reject(new Error("nothing may be sent")),
    })
    try {
      expect(
        propose(s.db, s.policy, {
          intent: sample("email.send"),
          origin: "reactive",
        }).ok
      ).toBe(true)
      for (let flush = 0; flush < 3; flush += 1) {
        notifier.notifyPending()
        time += 61_000
        expect(await notifier.flushDue()).toBe(true)
        await notifier.notifyRecovery()
      }
      expect(
        auditRows(s.db).filter((row) => row.action.includes("refused_egress"))
      ).toEqual([])
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("requires signed endpoint authority at egress and revokes it on removal", () => {
    const s = setup()
    try {
      const subscription = {
        endpoint: "https://web.push.apple.com/send/auth",
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
      endpoint: "https://web.push.apple.com/send/retry",
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
        endpoint: "https://web.push.apple.com/send/one",
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
      endpoint: "https://web.push.apple.com/send/one",
      ...keys(),
    }
    const prepared = preparePushRegistration(s.db, subscription)
    const auth = controlAuthorization(s.db, prepared)
    const id = registerPushSubscription(s.db, subscription, auth)
    s.db
      .prepare("UPDATE push_subscriptions SET endpoint = ? WHERE id = ?")
      .run("https://web.push.apple.com/send/attacker", id)
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
      endpoint: "https://web.push.apple.com/send/two",
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
      endpoint: "https://web.push.apple.com/send/three",
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

describe("recovery alert push (issue 682)", () => {
  function subscribed(s: ReturnType<typeof setup>, names: string[]) {
    return names.map((name) => {
      const subscription = {
        endpoint: `https://web.push.apple.com/send/${name}`,
        ...keys(),
      }
      const id = registerPushSubscription(
        s.db,
        subscription,
        controlAuthorization(s.db, preparePushRegistration(s.db, subscription))
      )
      return { id, endpoint: subscription.endpoint }
    })
  }

  it("carries only that a recovery started", () => {
    expect(recoveryPayload()).toBe('{"v":1,"recovery":"started"}')
  })

  it("sends at once to every verified subscription, with no coalescing window", async () => {
    const s = setup()
    const targets = subscribed(s, ["one", "two"])
    const sent: string[] = []
    const notifier = createPushNotifier({
      db: s.db,
      now: () => 5_000,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: (url) => {
        sent.push(requestUrl(url))
        return Promise.resolve(new Response(null, { status: 201 }))
      },
    })
    try {
      await notifier.notifyRecovery()
      expect(sent.sort()).toEqual(targets.map((t) => t.endpoint).sort())
      const audited = auditRows(s.db)
        .filter((row) => row.action === "push.recovery_sent")
        .map((row) => row.target)
        .sort()
      expect(audited).toEqual(targets.map((t) => t.id).sort())
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("revokes a gone subscription, keeps one that failed, and still reaches the others", async () => {
    const s = setup()
    const [gone, failing, fine] = subscribed(s, ["gone", "failing", "fine"])
    if (gone === undefined || failing === undefined || fine === undefined)
      throw new Error("no subscriptions")
    const statuses = new Map([
      [gone.endpoint, 410],
      [failing.endpoint, 503],
      [fine.endpoint, 201],
    ])
    const notifier = createPushNotifier({
      db: s.db,
      now: () => 5_000,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(privateKey()),
      fetch: (url) =>
        Promise.resolve(
          new Response(null, { status: statuses.get(requestUrl(url)) ?? 500 })
        ),
    })
    try {
      await notifier.notifyRecovery()
      expect(
        pushSubscriptions(s.db)
          .map((item) => item.id)
          .sort()
      ).toEqual([failing.id, fine.id].sort())
      const outcomes = auditRows(s.db)
        .filter((row) => row.action.startsWith("push.recovery_"))
        .map((row) => [row.action, row.target])
        .sort()
      expect(outcomes).toEqual(
        [
          ["push.recovery_gone", gone.id],
          ["push.recovery_failed", failing.id],
          ["push.recovery_sent", fine.id],
        ].sort()
      )
    } finally {
      notifier.close()
      s.cleanup()
    }
  })

  it("does not read the vault or send when nobody is subscribed or the notifier is closed", async () => {
    const s = setup()
    let keyReads = 0
    const notifier = createPushNotifier({
      db: s.db,
      subject: "mailto:ops@example.invalid",
      privateKey: () => {
        keyReads++
        return Promise.resolve(privateKey())
      },
      fetch: () => Promise.reject(new Error("nothing may be sent")),
    })
    try {
      await notifier.notifyRecovery()
      subscribed(s, ["late"])
      notifier.close()
      await notifier.notifyRecovery()
      expect(keyReads).toBe(0)
    } finally {
      s.cleanup()
    }
  })

  it("audits an unavailable key and an egress that is no longer approved", async () => {
    const s = setup()
    const [first, second] = subscribed(s, ["first", "second"])
    if (first === undefined || second === undefined)
      throw new Error("no subscriptions")
    s.db
      .prepare("UPDATE push_subscriptions SET endpoint = ? WHERE id = ?")
      .run("https://web.push.apple.com/send/attacker", second.id)
    const noKey = createPushNotifier({
      db: s.db,
      subject: "mailto:ops@example.invalid",
      privateKey: () => Promise.resolve(undefined),
      fetch: () => Promise.reject(new Error("nothing may be sent")),
    })
    try {
      await noKey.notifyRecovery()
      const rows = auditRows(s.db)
        .filter((row) => row.action.startsWith("push.recovery_"))
        .map((row) => [row.action, row.target])
        .sort()
      expect(rows).toEqual(
        [
          ["push.recovery_unavailable", first.id],
          ["push.recovery_refused_egress", second.id],
        ].sort()
      )
    } finally {
      noKey.close()
      s.cleanup()
    }
  })
})
