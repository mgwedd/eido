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
/**
 * This device's registration: the gate's id for it and the endpoint it was made for. The
 * gate lists ids only, so the endpoint tells whether the browser still holds the
 * subscription the gate has. Any script on this origin can read the endpoint from the
 * push manager already, so keeping it here exposes nothing new.
 */
export const PUSH_REGISTRATION_KEY = "eido.push.registration"

export type PushRegistration = { id: string; endpoint: string }

/** The browser objects the push control uses, so tests can supply their own. */
export type PushSubscriptionLike = {
  readonly options: { readonly applicationServerKey: ArrayBuffer | null }
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
  | { status: "unauthenticated" }

/** A failed push call: a message to show, or a session that expired (401). */
export type PushFailure =
  { ok: false; message: string } | { ok: false; expired: true }

export type PushResult<T> = { ok: true; value: T } | PushFailure

const fail = (message: string): PushFailure => ({ ok: false, message })

const MESSAGES = {
  network: "The gate could not be reached.",
  unavailable: "Push is not set up on the gate.",
  refused: "The gate refused the push registration.",
  unreadable: "The gate sent an unreadable answer.",
  cancelled: "Face ID did not complete.",
  notAllowed: "Notifications were not allowed.",
  browser: "This browser could not create a push subscription.",
  storage: "This browser could not save the push registration.",
  mismatch:
    "The gate prepared a different subscription. Nothing was registered.",
} as const

export function storedPushRegistration(): PushRegistration | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(PUSH_REGISTRATION_KEY) ?? "null")
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const id: unknown = Reflect.get(parsed, "id")
  const endpoint: unknown = Reflect.get(parsed, "endpoint")
  return typeof id === "string" && typeof endpoint === "string"
    ? { id, endpoint }
    : null
}

/** Saves or clears this device's registration; false when storage is blocked. */
function storePushRegistration(registration: PushRegistration | null): boolean {
  try {
    if (registration === null) localStorage.removeItem(PUSH_REGISTRATION_KEY)
    else
      localStorage.setItem(PUSH_REGISTRATION_KEY, JSON.stringify(registration))
    return true
  } catch {
    return false
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
  if (response.status === 401) return { ok: false, expired: true }
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

/**
 * Reads whether this device is subscribed: the browser holds the subscription this device
 * registered (same endpoint) and the gate still lists its id.
 */
export async function loadPushStatus(device: PushDevice): Promise<PushStatus> {
  const availability = pushAvailability(device)
  if (availability !== "available") return { status: availability }
  let listed: string[]
  try {
    const response = await fetch(`${PUSH_URL}/subscriptions`, {
      cache: "no-store",
    })
    if (response.status === 401) return { status: "unauthenticated" }
    if (!response.ok) return { status: "error" }
    const parsed = validateGatePushSubscriptionList(await response.json())
    if (!parsed.ok) return { status: "error" }
    listed = parsed.value.subscriptions.map(({ id }) => id)
  } catch (error) {
    return { status: error instanceof TypeError ? "offline" : "error" }
  }
  const stored = storedPushRegistration()
  let subscription: PushSubscriptionLike | null
  try {
    subscription = await (await device.pushManager()).getSubscription()
  } catch {
    return { status: "error" }
  }
  return subscription !== null &&
    stored !== null &&
    listed.includes(stored.id) &&
    subscription.toJSON().endpoint === stored.endpoint
    ? { status: "subscribed", id: stored.id }
    : { status: "unsubscribed" }
}

const sameKey = (held: ArrayBuffer | null, key: Uint8Array) =>
  held !== null &&
  held.byteLength === key.length &&
  new Uint8Array(held).every((byte, i) => byte === key[i])

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
 * key, and registers the subscription with a passkey approval. A subscription the browser
 * already holds for another key is dropped first: subscribing over it throws
 * InvalidStateError. Any failure after the browser subscribed undoes the browser
 * subscription, and a registration this device cannot save is removed at the gate, so
 * nothing is left half on.
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

  const serverKey = fromBase64url(parsedKey.value.publicKey)
  let browser: PushSubscriptionLike
  try {
    const manager = await device.pushManager()
    const held = await manager.getSubscription()
    if (held !== null && !sameKey(held.options.applicationServerKey, serverKey))
      await held.unsubscribe()
    browser = await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey.buffer as ArrayBuffer,
    })
  } catch {
    return fail(MESSAGES.browser)
  }
  const undo = async (failure: PushFailure): Promise<PushFailure> => {
    await browser.unsubscribe().catch(() => false)
    return failure
  }
  const subscription = toGateSubscription(browser.toJSON())
  if (subscription === undefined) return undo(fail(MESSAGES.browser))
  const result = await register(device, subscription)
  if (!result.ok) return undo(result)
  const id = result.value
  if (!storePushRegistration({ id, endpoint: subscription.endpoint })) {
    await call(`/${encodeURIComponent(id)}/remove`, {})
    return undo(fail(MESSAGES.storage))
  }
  return { ok: true, value: { status: "subscribed", id } }
}

/** Turns push off: the gate forgets the subscription first, then the browser drops it. */
export async function unsubscribePush(
  device: PushDevice,
  id: string
): Promise<PushResult<PushStatus>> {
  const removed = await call(`/${encodeURIComponent(id)}/remove`, {})
  if (!removed.ok) return removed
  storePushRegistration(null)
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
