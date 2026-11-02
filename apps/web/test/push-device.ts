// A fake browser for the push control: service worker push manager, notification
// permission and passkey prompt, recording what the code under test asked of it.
import { vi } from "vitest"
import type { PushDevice, PushSubscriptionLike } from "@/lib/push"
import { subscriptionJson } from "./fixtures/push"

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
    subscription?: PushSubscriptionJSON
    subscribeFails?: boolean
    credential?: () => Promise<Credential | null>
  } = {}
): FakeBrowser {
  let permission = options.permission ?? "granted"
  let unsubscribed = 0
  const subscribeOptions: PushSubscriptionOptionsInit[] = []
  const credentialOptions: CredentialRequestOptions[] = []
  const make = (): PushSubscriptionLike => {
    const sub: PushSubscriptionLike = {
      toJSON: () => options.subscription ?? subscriptionJson,
      unsubscribe: () => {
        unsubscribed += 1
        if (current === sub) current = null
        return Promise.resolve(true)
      },
    }
    return sub
  }
  let current: PushSubscriptionLike | null = options.subscribed ? make() : null
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
          current ??= make()
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
