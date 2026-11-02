// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  browserPushDevice,
  checkedChallenge,
  loadPushStatus,
  pushAvailability,
  PUSH_ID_KEY,
  storedPushId,
  subscribePush,
  toGateSubscription,
  unsubscribePush,
} from "@/lib/push"
import {
  auth,
  endpoint,
  p256dh,
  prepared,
  serverKey,
  subscriptionJson,
} from "./fixtures/push"
import { fakeBrowser, stubWebAuthnGlobals } from "./push-device"

const subscription = { endpoint, p256dh, auth }
const bytes = (base64url: string) => [...Buffer.from(base64url, "base64url")]

type Call = { method: string; url: string; body: unknown }
type Handler = () => Response | Promise<Response>

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status })

/** Routes fetch by "METHOD url"; anything unrouted fails as a network error. */
function gate(routes: Record<string, Handler>) {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      const method = init?.method ?? "GET"
      calls.push({
        method,
        url,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      })
      const handler = routes[`${method} ${url}`]
      return handler
        ? Promise.resolve(handler())
        : Promise.reject(new TypeError("net"))
    })
  )
  return calls
}

const happyRoutes = {
  "GET /api/gate/push/key": json({ publicKey: serverKey }),
  "POST /api/gate/push/prepare": json(prepared),
  "POST /api/gate/push/subscriptions": json({ id: "sub-1" }, 201),
}

beforeEach(() => {
  localStorage.clear()
  stubWebAuthnGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("pushAvailability", () => {
  it("says to add to the Home Screen in an iOS Safari tab", () => {
    expect(
      pushAvailability(
        fakeBrowser({ supported: false, standalone: false }).device
      )
    ).toBe("install")
  })
  it("says unsupported where push is missing outside iOS", () => {
    expect(pushAvailability(fakeBrowser({ supported: false }).device)).toBe(
      "unsupported"
    )
  })
  it("says denied when notifications are blocked", () => {
    expect(pushAvailability(fakeBrowser({ permission: "denied" }).device)).toBe(
      "denied"
    )
  })
  it("is available when permission is not yet asked", () => {
    expect(
      pushAvailability(fakeBrowser({ permission: "default" }).device)
    ).toBe("available")
  })
})

describe("browserPushDevice", () => {
  it("reads support, permission, push manager and passkey from the browser", async () => {
    const pushManager = { marker: "pm" }
    const get = vi.fn(() => Promise.resolve(null))
    const requestPermission = vi.fn(() => Promise.resolve("granted"))
    vi.stubGlobal("navigator", {
      serviceWorker: { ready: Promise.resolve({ pushManager }) },
      credentials: { get },
      standalone: false,
    })
    vi.stubGlobal("PushManager", class {})
    vi.stubGlobal("Notification", { permission: "denied", requestPermission })
    const device = browserPushDevice()
    expect(device.supported).toBe(true)
    expect(device.standalone).toBe(false)
    expect(device.permission()).toBe("denied")
    expect(await device.requestPermission()).toBe("granted")
    expect(await device.pushManager()).toBe(pushManager)
    await device.getCredential({ publicKey: { challenge: new ArrayBuffer(1) } })
    expect(get).toHaveBeenCalledTimes(1)
    expect(device.rpId).toBe(window.location.hostname)
  })

  it("is unsupported without a service worker, and standalone is unknown off iOS", () => {
    vi.stubGlobal("navigator", { credentials: {} })
    const device = browserPushDevice()
    expect(device.supported).toBe(false)
    expect(device.standalone).toBeUndefined()
  })
})

describe("toGateSubscription", () => {
  it("flattens the browser's subscription JSON", () => {
    expect(toGateSubscription(subscriptionJson)).toEqual(subscription)
  })
  it("refuses a subscription without keys", () => {
    expect(toGateSubscription({ endpoint })).toBeUndefined()
  })
})

describe("checkedChallenge", () => {
  it("returns the challenge the gate builds for this subscription", async () => {
    const challenge = await checkedChallenge(subscription, prepared)
    expect(challenge && [...challenge]).toEqual(bytes(prepared.challenge))
  })

  it.each([
    ["target", { target: `push:${"0".repeat(64)}` }],
    ["payload", { payload: prepared.payload.replace("push.", "evil.") }],
    ["payloadHash", { payloadHash: "f".repeat(64) }],
    ["challenge", { challenge: "A".repeat(43) }],
    ["nonce", { nonce: "m".repeat(43) }],
  ])("refuses a prepared card with a different %s", async (_, change) => {
    expect(
      await checkedChallenge(subscription, { ...prepared, ...change })
    ).toBeUndefined()
  })

  it("refuses a card prepared for other keys", async () => {
    expect(
      await checkedChallenge(
        { ...subscription, auth: "A".repeat(22) },
        prepared
      )
    ).toBeUndefined()
  })
})

describe("loadPushStatus", () => {
  const list = (ids: string[]) => ({
    "GET /api/gate/push/subscriptions": json({
      subscriptions: ids.map((id) => ({ id })),
    }),
  })

  it("is subscribed when the browser holds a subscription and the gate lists this device's id", async () => {
    localStorage.setItem(PUSH_ID_KEY, "sub-1")
    gate(list(["sub-0", "sub-1"]))
    expect(
      await loadPushStatus(fakeBrowser({ subscribed: true }).device)
    ).toEqual({ status: "subscribed", id: "sub-1" })
  })

  it("is not subscribed when the gate no longer lists the id", async () => {
    localStorage.setItem(PUSH_ID_KEY, "sub-1")
    gate(list(["sub-0"]))
    expect(
      await loadPushStatus(fakeBrowser({ subscribed: true }).device)
    ).toEqual({ status: "unsubscribed" })
  })

  it("is not subscribed when the browser holds no subscription", async () => {
    localStorage.setItem(PUSH_ID_KEY, "sub-1")
    gate(list(["sub-1"]))
    expect(await loadPushStatus(fakeBrowser().device)).toEqual({
      status: "unsubscribed",
    })
  })

  it("is not subscribed when no id is stored", async () => {
    gate(list(["sub-1"]))
    expect(
      await loadPushStatus(fakeBrowser({ subscribed: true }).device)
    ).toEqual({ status: "unsubscribed" })
  })

  it("does not ask the gate when the device cannot take pushes", async () => {
    const calls = gate({})
    expect(
      await loadPushStatus(fakeBrowser({ permission: "denied" }).device)
    ).toEqual({ status: "denied" })
    expect(calls).toEqual([])
  })

  it("is offline when the gate cannot be reached", async () => {
    gate({})
    expect(await loadPushStatus(fakeBrowser().device)).toEqual({
      status: "offline",
    })
  })

  it("is an error when the gate refuses or sends an unreadable list", async () => {
    gate({ "GET /api/gate/push/subscriptions": json({}, 500) })
    expect(await loadPushStatus(fakeBrowser().device)).toEqual({
      status: "error",
    })
    gate({ "GET /api/gate/push/subscriptions": json({ subscriptions: "x" }) })
    expect(await loadPushStatus(fakeBrowser().device)).toEqual({
      status: "error",
    })
  })

  it("is an error when the browser's push manager fails", async () => {
    gate(list([]))
    const { device } = fakeBrowser()
    device.pushManager = () => Promise.reject(new Error("sw"))
    expect(await loadPushStatus(device)).toEqual({ status: "error" })
  })
})

describe("subscribePush", () => {
  it("subscribes to the gate's key, signs the checked challenge and registers", async () => {
    const calls = gate(happyRoutes)
    const browser = fakeBrowser({ permission: "default", answer: "granted" })
    const result = await subscribePush(browser.device)

    expect(result).toEqual({
      ok: true,
      value: { status: "subscribed", id: "sub-1" },
    })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/gate/push/key",
      "POST /api/gate/push/prepare",
      "POST /api/gate/push/subscriptions",
    ])
    const init = browser.subscribeOptions[0]
    expect(init?.userVisibleOnly).toBe(true)
    expect([
      ...new Uint8Array(init?.applicationServerKey as ArrayBuffer),
    ]).toEqual(bytes(serverKey))
    expect(calls[1]?.body).toEqual(subscription)
    const publicKey = browser.credentialOptions[0]?.publicKey
    expect([...new Uint8Array(publicKey?.challenge as ArrayBuffer)]).toEqual(
      bytes(prepared.challenge)
    )
    expect(publicKey?.rpId).toBe("eido.example.invalid")
    expect(publicKey?.userVerification).toBe("required")
    expect(calls[2]?.body).toEqual({
      subscription,
      approval: {
        id: "control-0001",
        nonce: prepared.nonce,
        assertion: {
          credentialId: "CQ",
          authenticatorData: "AQI",
          clientDataJSON: "Aw",
          signature: "BAU",
        },
      },
    })
    expect(localStorage.getItem(PUSH_ID_KEY)).toBe("sub-1")
    expect(browser.unsubscribed()).toBe(0)
  })

  it("reports denied without asking the gate when the prompt is refused", async () => {
    const calls = gate(happyRoutes)
    const browser = fakeBrowser({ permission: "default", answer: "denied" })
    expect(await subscribePush(browser.device)).toEqual({
      ok: true,
      value: { status: "denied" },
    })
    expect(calls).toEqual([])
  })

  it("says notifications were not allowed when the prompt is dismissed", async () => {
    gate(happyRoutes)
    const browser = fakeBrowser({ permission: "default", answer: "default" })
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "Notifications were not allowed.",
    })
    expect(browser.subscribeOptions).toEqual([])
  })

  it("says push is not set up when the gate answers unavailable", async () => {
    gate({
      ...happyRoutes,
      "GET /api/gate/push/key": json(
        { code: "unavailable", message: "push is not configured" },
        503
      ),
    })
    const browser = fakeBrowser()
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "Push is not set up on the gate.",
    })
    expect(browser.subscribeOptions).toEqual([])
  })

  it("refuses an unreadable key", async () => {
    gate({ ...happyRoutes, "GET /api/gate/push/key": json({ publicKey: "x" }) })
    expect(await subscribePush(fakeBrowser().device)).toEqual({
      ok: false,
      message: "The gate sent an unreadable answer.",
    })
  })

  it("reports a browser that cannot subscribe", async () => {
    gate(happyRoutes)
    expect(
      await subscribePush(fakeBrowser({ subscribeFails: true }).device)
    ).toEqual({
      ok: false,
      message: "This browser could not create a push subscription.",
    })
  })

  it("drops a browser subscription the gate cannot take", async () => {
    const calls = gate(happyRoutes)
    const browser = fakeBrowser({ subscription: { endpoint, keys: {} } })
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "This browser could not create a push subscription.",
    })
    expect(browser.current()).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it("refuses a card that binds another subscription and undoes the browser subscription", async () => {
    const calls = gate({
      ...happyRoutes,
      "POST /api/gate/push/prepare": json({
        ...prepared,
        target: `push:${"0".repeat(64)}`,
      }),
    })
    const browser = fakeBrowser()
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message:
        "The gate prepared a different subscription. Nothing was registered.",
    })
    expect(browser.credentialOptions).toEqual([])
    expect(calls.map((c) => c.url)).not.toContain(
      "/api/gate/push/subscriptions"
    )
    expect(browser.current()).toBeNull()
  })

  it("refuses an unreadable prepared card", async () => {
    gate({ ...happyRoutes, "POST /api/gate/push/prepare": json({ id: "x" }) })
    const browser = fakeBrowser()
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "The gate sent an unreadable answer.",
    })
    expect(browser.current()).toBeNull()
  })

  it("undoes the browser subscription when Face ID is cancelled", async () => {
    const calls = gate(happyRoutes)
    const browser = fakeBrowser({
      credential: () =>
        Promise.reject(new DOMException("no", "NotAllowedError")),
    })
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "Face ID did not complete.",
    })
    expect(browser.current()).toBeNull()
    expect(calls).toHaveLength(2)
    expect(storedPushId()).toBeNull()
  })

  it("treats a prompt that returns no credential as cancelled", async () => {
    gate(happyRoutes)
    const browser = fakeBrowser({ credential: () => Promise.resolve(null) })
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "Face ID did not complete.",
    })
  })

  it("undoes the browser subscription when the gate refuses the approval", async () => {
    gate({
      ...happyRoutes,
      "POST /api/gate/push/subscriptions": json(
        { code: "verification_failed", message: "push registration refused" },
        403
      ),
    })
    const browser = fakeBrowser()
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "The gate refused the push registration.",
    })
    expect(browser.current()).toBeNull()
    expect(storedPushId()).toBeNull()
  })

  it("refuses an unreadable registration answer", async () => {
    gate({
      ...happyRoutes,
      "POST /api/gate/push/subscriptions": json({ ok: 1 }, 201),
    })
    const browser = fakeBrowser()
    expect(await subscribePush(browser.device)).toEqual({
      ok: false,
      message: "The gate sent an unreadable answer.",
    })
    expect(browser.current()).toBeNull()
  })

  it("reports a gate it cannot reach", async () => {
    gate({ "GET /api/gate/push/key": json({ publicKey: serverKey }) })
    expect(await subscribePush(fakeBrowser().device)).toEqual({
      ok: false,
      message: "The gate could not be reached.",
    })
  })

  it("reads a non-JSON body as unreadable on success and refused on failure", async () => {
    gate({ "GET /api/gate/push/key": () => new Response("<html>") })
    expect(await subscribePush(fakeBrowser().device)).toEqual({
      ok: false,
      message: "The gate sent an unreadable answer.",
    })
    gate({
      "GET /api/gate/push/key": () => new Response("<html>", { status: 502 }),
    })
    expect(await subscribePush(fakeBrowser().device)).toEqual({
      ok: false,
      message: "The gate refused the push registration.",
    })
  })
})

describe("unsubscribePush", () => {
  it("removes the registration at the gate, then drops the browser subscription", async () => {
    localStorage.setItem(PUSH_ID_KEY, "sub/1")
    const calls = gate({
      "POST /api/gate/push/sub%2F1/remove": json({ id: "sub/1" }),
    })
    const browser = fakeBrowser({ subscribed: true })
    expect(await unsubscribePush(browser.device, "sub/1")).toEqual({
      ok: true,
      value: { status: "unsubscribed" },
    })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/gate/push/sub%2F1/remove",
    ])
    expect(browser.current()).toBeNull()
    expect(storedPushId()).toBeNull()
  })

  it("keeps everything when the gate cannot be reached", async () => {
    localStorage.setItem(PUSH_ID_KEY, "sub-1")
    gate({})
    const browser = fakeBrowser({ subscribed: true })
    expect(await unsubscribePush(browser.device, "sub-1")).toEqual({
      ok: false,
      message: "The gate could not be reached.",
    })
    expect(browser.current()).not.toBeNull()
    expect(storedPushId()).toBe("sub-1")
  })

  it("still succeeds when the browser's push manager fails after the gate removed it", async () => {
    gate({ "POST /api/gate/push/sub-1/remove": json({ id: "sub-1" }) })
    const { device } = fakeBrowser({ subscribed: true })
    device.pushManager = () => Promise.reject(new Error("sw"))
    expect(await unsubscribePush(device, "sub-1")).toEqual({
      ok: true,
      value: { status: "unsubscribed" },
    })
  })
})

describe("storedPushId", () => {
  it("reads null when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(storedPushId()).toBeNull()
  })
})
