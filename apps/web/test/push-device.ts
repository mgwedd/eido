// A fake browser for the push control: service worker push manager, notification
// permission and passkey prompt, recording what the code under test asked of it.
import { vi } from "vitest"
import type { PushDevice, PushSubscriptionLike } from "@/lib/push"
import { PUSH_REGISTRATION_KEY } from "@/lib/push"
import { endpoint, serverKey, subscriptionJson } from "./fixtures/push"

class FakeAssertionResponse {
  authenticatorData = new Uint8Array([1, 2]).buffer
  clientDataJSON = new Uint8Array([3]).buffer
  signature = new Uint8Array([4, 5]).buffer
}
class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown = new FakeAssertionResponse()
}

/** Makes `instanceof PublicKeyCredential` work for the fake credential. */
export function stubWebAuthnGlobals() {
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
}

/** Saves a registration the way the push control does: the gate's id and the endpoint. */
export function storeRegistration(id: string, registered = endpoint) {
  localStorage.setItem(
    PUSH_REGISTRATION_KEY,
    JSON.stringify({ id, endpoint: registered })
  )
}

const sameBytes = (a: ArrayBuffer | null, b: ArrayBuffer) =>
  a !== null && Buffer.from(a).equals(Buffer.from(b))

export type FakeBrowser = {
  device: PushDevice
  /** The subscription the browser holds now, or null. */
  current: () => PushSubscriptionLike | null
  subscribeOptions: PushSubscriptionOptionsInit[]
  credentialOptions: CredentialRequestOptions[]
  unsubscribed: () => number
}

export function fakeBrowser(
  options: {
    supported?: boolean
    standalone?: boolean
    permission?: NotificationPermission
    /** What the permission prompt answers. */
    answer?: NotificationPermission
    subscribed?: boolean
    /** The key the held subscription was made with (base64url); the gate's key by default. */
    heldKey?: string
    subscription?: PushSubscriptionJSON
    subscribeFails?: boolean
    credential?: () => Promise<Credential | null>
  } = {}
): FakeBrowser {
  let permission = options.permission ?? "granted"
  let unsubscribed = 0
  const subscribeOptions: PushSubscriptionOptionsInit[] = []
  const credentialOptions: CredentialRequestOptions[] = []
  const make = (key: ArrayBuffer | null): PushSubscriptionLike => {
    const sub: PushSubscriptionLike = {
      options: { applicationServerKey: key },
      toJSON: () => options.subscription ?? subscriptionJson,
      unsubscribe: () => {
        unsubscribed += 1
        if (current === sub) current = null
        return Promise.resolve(true)
      },
    }
    return sub
  }
  let current: PushSubscriptionLike | null = options.subscribed
    ? make(
        new Uint8Array(Buffer.from(options.heldKey ?? serverKey, "base64url"))
          .buffer
      )
    : null
  const device: PushDevice = {
    supported: options.supported ?? true,
    standalone: options.standalone,
    permission: () => permission,
    requestPermission: () => {
      permission = options.answer ?? permission
      return Promise.resolve(permission)
    },
    pushManager: () =>
      Promise.resolve({
        getSubscription: () => Promise.resolve(current),
        subscribe: (init) => {
          subscribeOptions.push(init)
          if (options.subscribeFails)
            return Promise.reject(new DOMException("no", "AbortError"))
          const key = init.applicationServerKey
          if (!(key instanceof ArrayBuffer))
            return Promise.reject(new TypeError("key"))
          // A real browser refuses to subscribe over a subscription made with another key.
          if (
            current !== null &&
            !sameBytes(current.options.applicationServerKey, key)
          )
            return Promise.reject(new DOMException("key", "InvalidStateError"))
          current ??= make(key)
          return Promise.resolve(current)
        },
      }),
    getCredential: (init) => {
      credentialOptions.push(init)
      return options.credential
        ? options.credential()
        : Promise.resolve(new FakeCredential() as unknown as Credential)
    },
    rpId: "eido.example.invalid",
  }
  return {
    device,
    current: () => current,
    subscribeOptions,
    credentialOptions,
    unsubscribed: () => unsubscribed,
  }
}
