import {
  validateGateApiError,
  validateGatePushKey,
  validateGatePushPrepared,
  validateGatePushSubscription,
  validateGatePushSubscriptionList,
  validateGatePushSubscriptionRef,
  type GatePushPrepared,
  type GatePushRegistration,
  type GatePushSubscription,
} from "@eido/schemas"
import { fromBase64url, toBase64url } from "@/lib/approval/challenge"
import { toAssertion } from "@/lib/approval/sign"

const PUSH_URL = "/api/gate/push"
/** The gate's id for this device's registration; the gate lists ids only. */
export const PUSH_ID_KEY = "eido.push.subscriptionId"

/** The browser objects the push control uses, so tests can supply their own. */
export type PushSubscriptionLike = {
  toJSON(): PushSubscriptionJSON
  unsubscribe(): Promise<boolean>
}
export type PushManagerLike = {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(options: PushSubscriptionOptionsInit): Promise<PushSubscriptionLike>
}
export type PushDevice = {
  /** Service worker, PushManager and Notification all exist. */
  supported: boolean
  /** `navigator.standalone`: false in an iOS Safari tab, undefined elsewhere. */
  standalone: boolean | undefined
  permission(): NotificationPermission
  requestPermission(): Promise<NotificationPermission>
  pushManager(): Promise<PushManagerLike>
  getCredential(options: CredentialRequestOptions): Promise<Credential | null>
  rpId: string
}

export function browserPushDevice(): PushDevice {
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  const standalone: unknown =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as { standalone?: unknown }).standalone
  return {
    supported,
    standalone: typeof standalone === "boolean" ? standalone : undefined,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    pushManager: async () => (await navigator.serviceWorker.ready).pushManager,
    getCredential: (options) => navigator.credentials.get(options),
    rpId: typeof window === "undefined" ? "" : window.location.hostname,
  }
}

/** Whether this device can take pushes at all, before asking the gate anything. */
export type PushAvailability =
  "unsupported" | "install" | "denied" | "available"

export function pushAvailability(device: PushDevice): PushAvailability {
  if (!device.supported)
    return device.standalone === false ? "install" : "unsupported"
  return device.permission() === "denied" ? "denied" : "available"
}

export type PushStatus =
  | { status: "unsupported" | "install" | "denied" }
  | { status: "subscribed"; id: string }
  | { status: "unsubscribed" }
  | { status: "offline" }
  | { status: "error" }

export type PushResult<T> =
  { ok: true; value: T } | { ok: false; message: string }

const fail = <T>(message: string): PushResult<T> => ({ ok: false, message })

const MESSAGES = {
  network: "The gate could not be reached.",
  unavailable: "Push is not set up on the gate.",
  refused: "The gate refused the push registration.",
  unreadable: "The gate sent an unreadable answer.",
  cancelled: "Face ID did not complete.",
  notAllowed: "Notifications were not allowed.",
  browser: "This browser could not create a push subscription.",
  mismatch:
    "The gate prepared a different subscription. Nothing was registered.",
} as const

export function storedPushId(): string | null {
  try {
    return localStorage.getItem(PUSH_ID_KEY)
  } catch {
    return null
  }
}

function storePushId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(PUSH_ID_KEY)
    else localStorage.setItem(PUSH_ID_KEY, id)
  } catch {
    // Storage blocked: the switch reads as off on the next load.
  }
}

async function call(
  path: string,
  body?: unknown
): Promise<PushResult<unknown>> {
  let response: Response
  try {
    response = await fetch(
      `${PUSH_URL}${path}`,
      body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
    )
  } catch {
    return fail(MESSAGES.network)
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    return fail(response.ok ? MESSAGES.unreadable : MESSAGES.refused)
  }
  if (response.ok) return { ok: true, value: json }
  const error = validateGateApiError(json)
  return fail(
    error.ok && error.value.code === "unavailable"
      ? MESSAGES.unavailable
      : MESSAGES.refused
  )
}

/** The subscription as the gate takes it, or undefined when the browser's is not usable. */
export function toGateSubscription(
  json: PushSubscriptionJSON
): GatePushSubscription | undefined {
  const parsed = validateGatePushSubscription({
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  })
  return parsed.ok ? parsed.value : undefined
}

const encoder = new TextEncoder()

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(text))
  )
}

async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Recomputes what the gate should have prepared for this subscription and returns the
 * challenge to sign, or undefined when the gate's card binds anything else. The binding
 * is RFC 8785 JSON; for ASCII string values with keys written in sorted order,
 * `JSON.stringify` produces exactly those bytes.
 */
export async function checkedChallenge(
  subscription: GatePushSubscription,
  prepared: GatePushPrepared
): Promise<Uint8Array | undefined> {
  const endpointHash = await sha256Hex(JSON.stringify(subscription.endpoint))
  const keysHash = await sha256Hex(
    JSON.stringify({ auth: subscription.auth, p256dh: subscription.p256dh })
  )
  const payload = JSON.stringify({
    endpointHash,
    keysHash,
    origin: new URL(subscription.endpoint).origin,
  })
  const target = `push:${endpointHash}`
  const payloadHash = await sha256Hex(payload)
  const challenge = toBase64url(
    await sha256(
      JSON.stringify([
        "eido.control.v1",
        "policy.set",
        target,
        prepared.id,
        payloadHash,
        prepared.nonce,
      ])
    )
  )
  if (
    prepared.payload !== payload ||
    prepared.target !== target ||
    prepared.payloadHash !== payloadHash ||
    prepared.challenge !== challenge
  )
    return undefined
  return fromBase64url(challenge)
}

/** Reads whether this device is subscribed: a browser subscription the gate still lists. */
export async function loadPushStatus(device: PushDevice): Promise<PushStatus> {
  const availability = pushAvailability(device)
  if (availability !== "available") return { status: availability }
  let listed: string[]
  try {
    const response = await fetch(`${PUSH_URL}/subscriptions`, {
      cache: "no-store",
    })
    if (!response.ok) return { status: "error" }
    const parsed = validateGatePushSubscriptionList(await response.json())
    if (!parsed.ok) return { status: "error" }
    listed = parsed.value.subscriptions.map(({ id }) => id)
  } catch (error) {
    return { status: error instanceof TypeError ? "offline" : "error" }
  }
  const id = storedPushId()
  let subscription: PushSubscriptionLike | null
  try {
    subscription = await (await device.pushManager()).getSubscription()
  } catch {
    return { status: "error" }
  }
  return subscription !== null && id !== null && listed.includes(id)
    ? { status: "subscribed", id }
    : { status: "unsubscribed" }
}

async function register(
  device: PushDevice,
  subscription: GatePushSubscription
): Promise<PushResult<string>> {
  const prepare = await call("/prepare", subscription)
  if (!prepare.ok) return prepare
  const prepared = validateGatePushPrepared(prepare.value)
  if (!prepared.ok) return fail(MESSAGES.unreadable)
  const challenge = await checkedChallenge(subscription, prepared.value)
  if (challenge === undefined) return fail(MESSAGES.mismatch)

  let credential: Credential | null
  try {
    credential = await device.getCredential({
      publicKey: {
        challenge: challenge.buffer as ArrayBuffer,
        rpId: device.rpId,
        userVerification: "required",
        timeout: 60_000,
      },
    })
  } catch {
    return fail(MESSAGES.cancelled)
  }
  const assertion =
    credential instanceof PublicKeyCredential
      ? toAssertion(credential)
      : undefined
  if (assertion === undefined) return fail(MESSAGES.cancelled)

  const body: GatePushRegistration = {
    subscription,
    approval: { id: prepared.value.id, nonce: prepared.value.nonce, assertion },
  }
  const registered = await call("/subscriptions", body)
  if (!registered.ok) return registered
  const ref = validateGatePushSubscriptionRef(registered.value)
  return ref.ok ? { ok: true, value: ref.value.id } : fail(MESSAGES.unreadable)
}

/**
 * Turns push on: asks for notification permission, subscribes the browser to the gate's
 * key, and registers the subscription with a passkey approval. Any failure after the
 * browser subscribed undoes the browser subscription, so nothing is left half on.
 */
export async function subscribePush(
  device: PushDevice
): Promise<PushResult<PushStatus>> {
  const permission = await device.requestPermission()
  if (permission === "denied") return { ok: true, value: { status: "denied" } }
  if (permission !== "granted") return fail(MESSAGES.notAllowed)

  const key = await call("/key")
  if (!key.ok) return key
  const parsedKey = validateGatePushKey(key.value)
  if (!parsedKey.ok) return fail(MESSAGES.unreadable)

  let browser: PushSubscriptionLike
  try {
    browser = await (
      await device.pushManager()
    ).subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64url(parsedKey.value.publicKey)
        .buffer as ArrayBuffer,
    })
  } catch {
    return fail(MESSAGES.browser)
  }
  const subscription = toGateSubscription(browser.toJSON())
  const result =
    subscription === undefined
      ? fail<string>(MESSAGES.browser)
      : await register(device, subscription)
  if (!result.ok) {
    await browser.unsubscribe().catch(() => false)
    return result
  }
  storePushId(result.value)
  return { ok: true, value: { status: "subscribed", id: result.value } }
}

/** Turns push off: the gate forgets the subscription first, then the browser drops it. */
export async function unsubscribePush(
  device: PushDevice,
  id: string
): Promise<PushResult<PushStatus>> {
  const removed = await call(`/${encodeURIComponent(id)}/remove`, {})
  if (!removed.ok) return removed
  storePushId(null)
  try {
    await (
      await device.pushManager()
    )
      .getSubscription()
      .then((s) => s?.unsubscribe())
  } catch {
    // The gate no longer sends to it; a browser subscription left behind receives nothing.
  }
  return { ok: true, value: { status: "unsubscribed" } }
}
