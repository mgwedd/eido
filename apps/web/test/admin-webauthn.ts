import { vi } from "vitest"

/** A passkey that answers `get` with a fixed assertion: credential 9, data 1 2, client data 3, signature 4 5. */
export class FakeAssertionResponse {
  authenticatorData = new Uint8Array([1, 2]).buffer
  clientDataJSON = new Uint8Array([3]).buffer
  signature = new Uint8Array([4, 5]).buffer
}
export class FakeCredential {
  rawId = new Uint8Array([9]).buffer
  response: unknown = new FakeAssertionResponse()
}

/** The assertion the fake passkey's answer becomes, in base64url. */
export const FAKE_ASSERTION = {
  credentialId: "CQ",
  authenticatorData: "AQI",
  clientDataJSON: "Aw",
  signature: "BAU",
}

export function stubPasskey(get: () => Promise<unknown>) {
  vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertionResponse)
  vi.stubGlobal("PublicKeyCredential", FakeCredential)
  const spy = vi.fn(get)
  vi.stubGlobal("navigator", { credentials: { get: spy } })
  return spy
}
