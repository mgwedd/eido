import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import { openControlDb } from "./control-db"
import {
  beginLogin,
  hasCredential,
  login,
  sessionCookie,
  sessionExpiry,
  sessionToken,
} from "./sessions"
import {
  assertion,
  auditRows,
  testAuthenticator,
  WEBAUTHN,
} from "./test-fixtures"
import type { TestAuthenticator } from "./test-fixtures"

const START = new Date("2026-10-19T08:00:00.000Z")
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

let db: DatabaseSync
let at: Date
const now = () => at

function enrol(auth: TestAuthenticator, signCount = 0): void {
  db.prepare(
    "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?)"
  ).run(auth.credentialId, auth.publicKey, signCount, START.toISOString())
}

function revoke(auth: TestAuthenticator): void {
  db.prepare(
    "UPDATE credentials SET revoked_at = ? WHERE credential_id = ?"
  ).run(START.toISOString(), auth.credentialId)
}

beforeEach(() => {
  db = openControlDb(":memory:")
  at = START
})

afterEach(() => {
  db.close()
})

describe("beginLogin", () => {
  it("issues a different 43-character challenge each time, expiring five minutes later", () => {
    const first = beginLogin(db, now)
    const second = beginLogin(db, now)
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.challenge).not.toBe(first.challenge)
    expect(first.expiresAt.toISOString()).toBe("2026-10-19T08:05:00.000Z")
  })
})

describe("login", () => {
  it("creates a session that lasts until 12 hours after login and stores only the token's hash", () => {
    const auth = testAuthenticator()
    enrol(auth)
    const { challenge } = beginLogin(db, now)
    const result = login(db, WEBAUTHN, assertion(auth, challenge), now)
    if (!result.ok) throw new Error(`login refused: ${result.reason}`)
    expect(result.expiresAt.toISOString()).toBe("2026-10-19T20:00:00.000Z")
    const stored = db.prepare("SELECT token_hash FROM sessions").all()
    expect(stored).toEqual([
      {
        token_hash: createHash("sha256").update(result.token).digest("hex"),
      },
    ])
    expect(
      JSON.stringify(db.prepare("SELECT * FROM sessions").all())
    ).not.toContain(result.token)
    expect(auditRows(db).map((row) => row.action)).toEqual(["session.created"])
    expect(verifyChain(db).ok).toBe(true)
  })

  it("advances the stored sign count", () => {
    const auth = testAuthenticator()
    enrol(auth, 4)
    const { challenge } = beginLogin(db, now)
    const result = login(
      db,
      WEBAUTHN,
      assertion(auth, challenge, { signCount: 9 }),
      now
    )
    expect(result.ok).toBe(true)
    expect(
      db.prepare("SELECT sign_count FROM credentials").get()?.["sign_count"]
    ).toBe(9)
  })

  type Case = {
    name: string
    reason: string
    arrange: (
      auth: TestAuthenticator,
      challenge: string
    ) => ReturnType<typeof assertion>
  }

  const cases: Case[] = [
    {
      name: "a challenge the gate never issued",
      reason: "unknown_challenge",
      arrange: (auth) => assertion(auth, "A".repeat(43)),
    },
    {
      name: "a challenge already used",
      reason: "unknown_challenge",
      arrange: (auth, challenge) => {
        const first = login(db, WEBAUTHN, assertion(auth, challenge), now)
        expect(first.ok).toBe(true)
        return assertion(auth, challenge, { signCount: 0 })
      },
    },
    {
      name: "an expired challenge",
      reason: "expired_challenge",
      arrange: (auth, challenge) => {
        at = new Date(START.getTime() + 5 * MINUTE)
        return assertion(auth, challenge)
      },
    },
    {
      name: "a credential the gate does not hold",
      reason: "unknown_credential",
      arrange: (_auth, challenge) => assertion(testAuthenticator(), challenge),
    },
    {
      name: "a revoked credential",
      reason: "revoked_credential",
      arrange: (auth, challenge) => {
        revoke(auth)
        return assertion(auth, challenge)
      },
    },
    {
      name: "a signature by another key",
      reason: "bad_signature",
      arrange: (auth, challenge) => {
        const other = testAuthenticator()
        return assertion(
          { ...other, credentialId: auth.credentialId },
          challenge
        )
      },
    },
    {
      name: "a registration ceremony instead of a get",
      reason: "wrong_type",
      arrange: (auth, challenge) =>
        assertion(auth, challenge, { type: "webauthn.create" }),
    },
    {
      name: "a sign count that went backwards",
      reason: "sign_count",
      arrange: (auth, challenge) => {
        db.prepare("UPDATE credentials SET sign_count = 7").run()
        return assertion(auth, challenge, { signCount: 3 })
      },
    },
    {
      name: "fields that are not base64url",
      reason: "malformed",
      arrange: (auth, challenge) => ({
        ...assertion(auth, challenge),
        signature: "not base64url!",
      }),
    },
  ]

  it.each(cases)("refuses $name and audits why", ({ reason, arrange }) => {
    const auth = testAuthenticator()
    enrol(auth)
    const { challenge } = beginLogin(db, now)
    const signed = arrange(auth, challenge)
    const sessionsBefore = db
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get()?.["n"]
    expect(login(db, WEBAUTHN, signed, now)).toEqual({ ok: false, reason })
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.["n"]).toBe(
      sessionsBefore
    )
    expect(auditRows(db).at(-1)?.action).toBe(`session.login_refused.${reason}`)
  })

  it("never writes the credential id, challenge or signature into the audit log", () => {
    const auth = testAuthenticator()
    enrol(auth)
    const { challenge } = beginLogin(db, now)
    const signed = assertion(auth, challenge)
    login(db, WEBAUTHN, signed, now)
    login(db, WEBAUTHN, signed, now)
    const logged = JSON.stringify(db.prepare("SELECT * FROM audit_log").all())
    expect(logged).not.toContain(auth.credentialId)
    expect(logged).not.toContain(challenge)
    expect(logged).not.toContain(signed.signature)
  })
})

describe("sessionExpiry", () => {
  function signIn(auth: TestAuthenticator): string {
    const { challenge } = beginLogin(db, now)
    const result = login(db, WEBAUTHN, assertion(auth, challenge), now)
    if (!result.ok) throw new Error(`login refused: ${result.reason}`)
    return result.token
  }

  it("holds until just before 12 hours and ends at 12 hours", () => {
    const auth = testAuthenticator()
    enrol(auth)
    const token = signIn(auth)
    at = new Date(START.getTime() + 12 * HOUR - 1)
    expect(sessionExpiry(db, token, now)?.toISOString()).toBe(
      "2026-10-19T20:00:00.000Z"
    )
    at = new Date(START.getTime() + 12 * HOUR)
    expect(sessionExpiry(db, token, now)).toBeUndefined()
  })

  it("ends when the credential is revoked", () => {
    const auth = testAuthenticator()
    enrol(auth)
    const token = signIn(auth)
    revoke(auth)
    expect(sessionExpiry(db, token, now)).toBeUndefined()
  })

  it("knows no session for an unknown or missing token", () => {
    expect(sessionExpiry(db, "A".repeat(43), now)).toBeUndefined()
    expect(sessionExpiry(db, undefined, now)).toBeUndefined()
  })
})

describe("sessionToken", () => {
  it.each([
    ["eido_gate_session=abc", "abc"],
    ["theme=dark; eido_gate_session=abc; other=1", "abc"],
    [" eido_gate_session = abc ", "abc"],
    ["flag; eido_gate_session=abc", "abc"],
  ])("reads the session cookie from %j", (header, token) => {
    expect(sessionToken(header)).toBe(token)
  })

  it.each([
    ["no header", undefined],
    ["another cookie only", "eido_gate_session_old=abc"],
    ["an empty value", "eido_gate_session="],
  ])("finds no token with %s", (_name, header) => {
    expect(sessionToken(header)).toBeUndefined()
  })
})

describe("sessionCookie", () => {
  it("is HttpOnly, Secure, SameSite=Strict, scoped to /api/gate and lasts 12 hours", () => {
    expect(sessionCookie("tok")).toBe(
      "eido_gate_session=tok; Max-Age=43200; Path=/api/gate; HttpOnly; Secure; SameSite=Strict"
    )
  })
})

describe("hasCredential", () => {
  it("is true only while an unrevoked passkey is enrolled", () => {
    expect(hasCredential(db)).toBe(false)
    const auth = testAuthenticator()
    enrol(auth)
    expect(hasCredential(db)).toBe(true)
    revoke(auth)
    expect(hasCredential(db)).toBe(false)
  })
})
