import { generateKeyPairSync } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import {
  beginRegistration,
  registerCredential,
  revokeCredential,
} from "./credentials"
import type { Registration } from "./credentials"
import {
  WEBAUTHN,
  auditRows,
  loggedText,
  registration,
  setup,
  testAuthenticator,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

// Asymmetric matchers are typed any; holding one as unknown keeps the literals typed.
const anyString: unknown = expect.any(String)

let current: Setup | undefined

afterEach(() => {
  current?.cleanup()
  current = undefined
})

function db(): DatabaseSync {
  current = setup()
  return current.db
}

function challenge(control: DatabaseSync): string {
  const begun = beginRegistration(control, "admin")
  if (!begun.ok) throw new Error("enrolment challenge refused")
  return begun.challenge
}

function stored(control: DatabaseSync) {
  return control
    .prepare(
      "SELECT credential_id, public_key, sign_count, revoked_at FROM credentials"
    )
    .all()
}

function credentialActions(control: DatabaseSync): string[] {
  return auditRows(control)
    .filter((row) => row.target === "credential")
    .map((row) => row.action)
}

describe("beginRegistration", () => {
  it("issues a fresh 32-byte challenge on the admin surface", () => {
    const control = db()
    const first = challenge(control)
    expect(Buffer.from(first, "base64url")).toHaveLength(32)
    expect(challenge(control)).not.toBe(first)
  })

  it("refuses the phone-facing surface and audits it", () => {
    const control = db()
    expect(beginRegistration(control, "phone")).toEqual({
      ok: false,
      code: "admin_only",
    })
    const count = control
      .prepare("SELECT count(*) AS n FROM registration_challenges")
      .get()
    expect(count?.["n"]).toBe(0)
    expect(credentialActions(control)).toEqual(["credential.register_refused"])
  })
})

describe("registerCredential", () => {
  it("stores the public key with the authenticator's counter and audits it", () => {
    const control = db()
    const auth = testAuthenticator()
    const result = registerCredential(
      control,
      WEBAUTHN,
      "admin",
      registration(auth, challenge(control), { signCount: 4 })
    )
    expect(result).toEqual({ ok: true, credentialId: auth.credentialId })
    expect(stored(control)).toEqual([
      {
        credential_id: auth.credentialId,
        public_key: auth.publicKey,
        sign_count: 4,
        revoked_at: null,
      },
    ])
    expect(credentialActions(control)).toEqual(["credential.registered"])
    expect(verifyChain(control).ok).toBe(true)
    expect(loggedText(control)).not.toContain(auth.credentialId)
  })

  it("refuses the phone-facing surface", () => {
    const control = db()
    const auth = testAuthenticator()
    const response = registration(auth, challenge(control))
    expect(registerCredential(control, WEBAUTHN, "phone", response)).toEqual({
      ok: false,
      code: "admin_only",
    })
    expect(stored(control)).toEqual([])
    // The challenge is still usable from the admin surface.
    expect(registerCredential(control, WEBAUTHN, "admin", response).ok).toBe(
      true
    )
  })

  it("refuses a second use of the same challenge", () => {
    const control = db()
    const issued = challenge(control)
    const first = registration(testAuthenticator(), issued)
    expect(registerCredential(control, WEBAUTHN, "admin", first).ok).toBe(true)
    const second = registration(testAuthenticator(), issued)
    expect(registerCredential(control, WEBAUTHN, "admin", second)).toEqual({
      ok: false,
      code: "unknown_challenge",
    })
    expect(stored(control)).toHaveLength(1)
  })

  it("refuses a credential id that is already enrolled, even once revoked", () => {
    const control = db()
    const auth = testAuthenticator()
    expect(
      registerCredential(
        control,
        WEBAUTHN,
        "admin",
        registration(auth, challenge(control))
      ).ok
    ).toBe(true)
    expect(revokeCredential(control, "admin", auth.credentialId).ok).toBe(true)
    expect(
      registerCredential(
        control,
        WEBAUTHN,
        "admin",
        registration(auth, challenge(control))
      )
    ).toEqual({ ok: false, code: "credential_exists" })
    expect(stored(control)).toEqual([
      expect.objectContaining({ revoked_at: anyString }),
    ])
  })

  const otherKey = generateKeyPairSync("ec", { namedCurve: "P-384" })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url")

  it.each<[string, (response: Registration) => Registration, string]>([
    [
      "an unknown challenge",
      (r) => {
        const data = JSON.parse(
          Buffer.from(r.clientDataJSON, "base64url").toString("utf8")
        ) as Record<string, unknown>
        data["challenge"] = "A".repeat(43)
        return {
          ...r,
          clientDataJSON: Buffer.from(JSON.stringify(data)).toString(
            "base64url"
          ),
        }
      },
      "unknown_challenge",
    ],
    [
      "a credential id that is not base64url",
      (r) => ({ ...r, credentialId: "a+b" }),
      "malformed",
    ],
    [
      "a public key that is not base64url",
      (r) => ({ ...r, publicKey: "a/b" }),
      "malformed",
    ],
    [
      "client data that is not JSON",
      (r) => ({ ...r, clientDataJSON: Buffer.from("{").toString("base64url") }),
      "malformed",
    ],
    [
      "authenticator data that is too short",
      (r) => ({ ...r, authenticatorData: "AAAA" }),
      "malformed",
    ],
    [
      "an RS256 algorithm",
      (r) => ({ ...r, publicKeyAlgorithm: -257 }),
      "unsupported_algorithm",
    ],
    [
      "a P-384 key",
      (r) => ({ ...r, publicKey: otherKey }),
      "unsupported_algorithm",
    ],
    [
      "a public key that is not a key",
      (r) => ({
        ...r,
        publicKey: Buffer.from("not a key").toString("base64url"),
      }),
      "unsupported_algorithm",
    ],
  ])("refuses %s", (_name, alter, code) => {
    const control = db()
    const response = alter(
      registration(testAuthenticator(), challenge(control))
    )
    expect(registerCredential(control, WEBAUTHN, "admin", response)).toEqual({
      ok: false,
      code,
    })
    expect(stored(control)).toEqual([])
    expect(credentialActions(control)).toEqual(["credential.register_refused"])
  })

  it.each<[string, Parameters<typeof registration>[2], string]>([
    ["an assertion-type client data", { type: "webauthn.get" }, "wrong_type"],
    [
      "a wrong origin",
      { origin: "https://evil.example.invalid" },
      "wrong_origin",
    ],
    ["a cross-origin call", { crossOrigin: true }, "wrong_origin"],
    ["a wrong RP id hash", { rpId: "evil.example.invalid" }, "wrong_rp_id"],
    ["a missing user-present flag", { flags: 0x44 }, "user_not_present"],
    ["a missing user-verified flag", { flags: 0x41 }, "user_not_verified"],
    [
      "authenticator data without an attested credential",
      { flags: 0x05 },
      "not_attested",
    ],
    [
      "an attested id that is not the credential id",
      { attestedId: Buffer.from([1, 2, 3]) },
      "credential_mismatch",
    ],
  ])("refuses %s", (_name, options, code) => {
    const control = db()
    const response = registration(
      testAuthenticator(),
      challenge(control),
      options
    )
    expect(registerCredential(control, WEBAUTHN, "admin", response)).toEqual({
      ok: false,
      code,
    })
    expect(stored(control)).toEqual([])
  })
})

describe("revokeCredential", () => {
  function enrolled(control: DatabaseSync): string {
    const auth = testAuthenticator()
    const result = registerCredential(
      control,
      WEBAUTHN,
      "admin",
      registration(auth, challenge(control))
    )
    if (!result.ok) throw new Error("enrolment refused")
    return auth.credentialId
  }

  it("marks the credential revoked and audits it", () => {
    const control = db()
    const id = enrolled(control)
    expect(revokeCredential(control, "admin", id)).toEqual({ ok: true })
    expect(stored(control)).toEqual([
      expect.objectContaining({ revoked_at: anyString }),
    ])
    expect(credentialActions(control)).toEqual([
      "credential.registered",
      "credential.revoked",
    ])
    expect(verifyChain(control).ok).toBe(true)
  })

  it.each([
    ["the phone-facing surface", "phone", "known", "admin_only"],
    ["an unknown credential", "admin", "unknown", "unknown_credential"],
  ] as const)("refuses %s", (_name, surface, which, code) => {
    const control = db()
    const id = enrolled(control)
    const target = which === "known" ? id : "bm8tc3VjaC1rZXk"
    expect(revokeCredential(control, surface, target)).toEqual({
      ok: false,
      code,
    })
    expect(stored(control)).toEqual([
      expect.objectContaining({ revoked_at: null }),
    ])
    expect(credentialActions(control).at(-1)).toBe("credential.revoke_refused")
  })

  it("refuses to revoke twice", () => {
    const control = db()
    const id = enrolled(control)
    expect(revokeCredential(control, "admin", id).ok).toBe(true)
    expect(revokeCredential(control, "admin", id)).toEqual({
      ok: false,
      code: "already_revoked",
    })
  })
})
