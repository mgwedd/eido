import { createHash, scryptSync } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { payloadHash } from "./canonical"
import {
  beginPhoneRegistration,
  enrolWithCode,
  recoverWithKey,
} from "./credentials"
import { issueEnrolmentCode } from "./enrolment"
import {
  RECOVERY_DELAY_MS,
  RECOVERY_WINDOW_MS,
  checkRecoveryReady,
  issueRecoveryKey,
  normaliseRecoveryKey,
  pendingRecoveryWindow,
  startRecovery,
} from "./recovery"
import {
  WEBAUTHN,
  auditRows,
  loggedText,
  registration,
  setup,
  testAuthenticator,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

const T0 = new Date("2026-11-01T08:00:00.000Z")
const KEY_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/

let current: Setup | undefined
afterEach(() => {
  current?.cleanup()
  current = undefined
})

function db() {
  current = setup()
  return current.db
}

const at = (ms: number) => () => new Date(T0.getTime() + ms)

function activeRow(control: ReturnType<typeof db>) {
  const row = control
    .prepare(
      "SELECT * FROM recovery_keys WHERE consumed_at IS NULL AND superseded_at IS NULL"
    )
    .get()
  if (row === undefined) throw new Error("no active recovery key")
  return row
}

/** A first enrolment through the phone path, which issues the recovery key. */
function firstEnrolment(control: ReturnType<typeof db>) {
  const code = issueEnrolmentCode(control, "admin", at(0))
  if (!code.ok) throw new Error("no code")
  const challenge = beginPhoneRegistration(control, at(0))
  const auth = testAuthenticator()
  const result = enrolWithCode(
    control,
    WEBAUTHN,
    code.code,
    registration(auth, challenge),
    at(0)
  )
  if (!result.ok) throw new Error(`enrolment refused: ${result.code}`)
  return { auth, recoveryKey: result.recoveryKey }
}

describe("normaliseRecoveryKey", () => {
  it("reads case, dashes, spaces and the Crockford look-alikes", () => {
    const raw = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    expect(normaliseRecoveryKey(raw)).toBe(raw)
    expect(normaliseRecoveryKey("oiol-23456789-abcdefghjkmnpqrstvwx")).toBe(
      "0101" + "23456789" + "ABCDEFGHJKMNPQRSTVWX"
    )
  })

  it("refuses a wrong length, a character outside the alphabet and an oversized input", () => {
    expect(normaliseRecoveryKey("ABCD")).toBeUndefined()
    expect(
      normaliseRecoveryKey("U".repeat(32)) // U is not in the alphabet
    ).toBeUndefined()
    expect(normaliseRecoveryKey("A".repeat(33))).toBeUndefined()
    expect(normaliseRecoveryKey("A".repeat(65))).toBeUndefined()
  })
})

describe("issueRecoveryKey", () => {
  it("returns eight dash-separated groups and stores a scrypt digest, never the key", () => {
    const control = db()
    const key = issueRecoveryKey(control, at(0))
    expect(key).toMatch(KEY_SHAPE)
    const row = activeRow(control)
    const raw = key.replaceAll("-", "")
    // The parameters come from the issue: N=32768, r=8, p=1, 32-byte output, 16-byte salt.
    const salt = Buffer.from(String(row["salt"]), "base64url")
    expect(salt).toHaveLength(16)
    const expected = scryptSync(raw, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    })
    expect(String(row["digest"])).toBe(expected.toString("base64url"))
    expect(
      JSON.stringify(control.prepare("SELECT * FROM recovery_keys").all())
    ).not.toContain(raw)
    expect(loggedText(control)).not.toContain(raw)
    expect(
      auditRows(control).filter((r) => r.action === "recovery_key.issued")
    ).toHaveLength(1)
  })

  it("supersedes the earlier key, so only the newest one is active", () => {
    const control = db()
    const first = issueRecoveryKey(control, at(0))
    const second = issueRecoveryKey(control, at(1000))
    expect(second).not.toBe(first)
    expect(
      control
        .prepare(
          "SELECT count(*) AS n FROM recovery_keys WHERE superseded_at IS NULL AND consumed_at IS NULL"
        )
        .get()?.["n"]
    ).toBe(1)
    expect(startRecovery(control, first, at(2000))).toEqual({
      ok: false,
      code: "invalid_key",
    })
    expect(startRecovery(control, second, at(2000)).ok).toBe(true)
  })
})

describe("first enrolment", () => {
  it("issues a key on the first passkey and none on a later one", () => {
    const control = db()
    const { recoveryKey } = firstEnrolment(control)
    expect(recoveryKey).toMatch(KEY_SHAPE)
    const code = issueEnrolmentCode(control, "admin", at(0))
    if (!code.ok) throw new Error("no code")
    const second = enrolWithCode(
      control,
      WEBAUTHN,
      code.code,
      registration(testAuthenticator(), beginPhoneRegistration(control, at(0))),
      at(0)
    )
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.recoveryKey).toBeUndefined()
    expect(
      control.prepare("SELECT count(*) AS n FROM recovery_keys").get()?.["n"]
    ).toBe(1)
  })
})

describe("startRecovery", () => {
  it("opens a 24-hour delay and a 24-hour window after it, and shows it as pending", () => {
    const control = db()
    const key = issueRecoveryKey(control, at(0))
    const started = startRecovery(
      control,
      key.toLowerCase().replaceAll("-", " "),
      at(1000)
    )
    expect(started).toEqual({
      ok: true,
      window: {
        startedAt: "2026-11-01T08:00:01.000Z",
        maturesAt: "2026-11-02T08:00:01.000Z",
        expiresAt: "2026-11-03T08:00:01.000Z",
      },
    })
    expect(RECOVERY_DELAY_MS + RECOVERY_WINDOW_MS).toBe(48 * 60 * 60 * 1000)
    expect(pendingRecoveryWindow(control, at(2000))).toEqual(
      started.ok ? started.window : undefined
    )
    expect(
      pendingRecoveryWindow(
        control,
        at(RECOVERY_DELAY_MS + RECOVERY_WINDOW_MS + 1000)
      )
    ).toBeUndefined()
  })

  it("refuses a second start while one is pending, so the delay cannot be restarted", () => {
    const control = db()
    const key = issueRecoveryKey(control, at(0))
    expect(startRecovery(control, key, at(0)).ok).toBe(true)
    expect(startRecovery(control, key, at(3600_000))).toEqual({
      ok: false,
      code: "already_pending",
    })
    expect(
      control.prepare("SELECT count(*) AS n FROM recoveries").get()?.["n"]
    ).toBe(1)
  })

  it("refuses a malformed or wrong key, stores nothing, and audits the outcome without the guess", () => {
    const control = db()
    issueRecoveryKey(control, at(0))
    const guess = "7777-7777-7777-7777-7777-7777-7777-7777"
    expect(startRecovery(control, "short", at(0))).toEqual({
      ok: false,
      code: "malformed",
    })
    expect(startRecovery(control, guess, at(0))).toEqual({
      ok: false,
      code: "invalid_key",
    })
    expect(
      control.prepare("SELECT count(*) AS n FROM recoveries").get()?.["n"]
    ).toBe(0)
    const refused = auditRows(control).filter(
      (r) => r.action === "recovery.start_refused"
    )
    expect(refused.map((r) => r.detail_hash)).toEqual([
      payloadHash({ outcome: "malformed" }),
      payloadHash({ outcome: "invalid_key" }),
    ])
    const text = loggedText(control)
    const raw = guess.replaceAll("-", "")
    expect(text).not.toContain(raw)
    for (const form of [raw, guess]) {
      expect(text).not.toContain(
        createHash("sha256").update(form).digest("hex")
      )
    }
  })

  it("refuses when no key has been issued", () => {
    expect(
      startRecovery(db(), "7777-7777-7777-7777-7777-7777-7777-7777", at(0))
    ).toEqual({ ok: false, code: "invalid_key" })
  })
})

describe("checkRecoveryReady", () => {
  function started() {
    const control = db()
    const key = issueRecoveryKey(control, at(0))
    startRecovery(control, key, at(0))
    return { control, key }
  }

  it("refuses before maturity and after the window, and accepts between", () => {
    const { control, key } = started()
    expect(checkRecoveryReady(control, key, at(RECOVERY_DELAY_MS - 1))).toEqual(
      {
        ok: false,
        code: "not_matured",
      }
    )
    expect(checkRecoveryReady(control, key, at(RECOVERY_DELAY_MS)).ok).toBe(
      true
    )
    expect(
      checkRecoveryReady(
        control,
        key,
        at(RECOVERY_DELAY_MS + RECOVERY_WINDOW_MS - 1)
      ).ok
    ).toBe(true)
    expect(
      checkRecoveryReady(
        control,
        key,
        at(RECOVERY_DELAY_MS + RECOVERY_WINDOW_MS)
      )
    ).toEqual({ ok: false, code: "expired" })
  })

  it("refuses a key whose recovery was never started", () => {
    const control = db()
    const key = issueRecoveryKey(control, at(0))
    expect(checkRecoveryReady(control, key, at(RECOVERY_DELAY_MS))).toEqual({
      ok: false,
      code: "no_recovery",
    })
  })

  it("audits each refusal by outcome only", () => {
    const { control, key } = started()
    checkRecoveryReady(control, key, at(1000))
    checkRecoveryReady(control, "x", at(1000))
    expect(
      auditRows(control)
        .filter((r) => r.action === "recovery.complete_refused")
        .map((r) => r.detail_hash)
    ).toEqual([
      payloadHash({ outcome: "not_matured" }),
      payloadHash({ outcome: "malformed" }),
    ])
  })
})

describe("recoverWithKey", () => {
  function matured() {
    const control = db()
    const { auth, recoveryKey } = firstEnrolment(control)
    if (recoveryKey === undefined) throw new Error("no key")
    expect(startRecovery(control, recoveryKey, at(0)).ok).toBe(true)
    return { control, auth, recoveryKey }
  }

  it("leaves the key and the recovery usable when the registration fails its checks", () => {
    const { control, recoveryKey } = matured()
    const now = at(RECOVERY_DELAY_MS)
    const refused = recoverWithKey(
      control,
      WEBAUTHN,
      recoveryKey,
      registration(testAuthenticator(), "A".repeat(43)),
      now
    )
    expect(refused).toEqual({ ok: false, code: "unknown_challenge" })
    expect(
      control.prepare("SELECT count(*) AS n FROM credentials").get()?.["n"]
    ).toBe(1)
    const retry = recoverWithKey(
      control,
      WEBAUTHN,
      recoveryKey,
      registration(testAuthenticator(), beginPhoneRegistration(control, now)),
      now
    )
    expect(retry.ok).toBe(true)
  })

  it("enrols one passkey, consumes the key, issues a replacement and cannot be repeated", () => {
    const { control, auth, recoveryKey } = matured()
    const now = at(RECOVERY_DELAY_MS + 1000)
    const fresh = testAuthenticator()
    const done = recoverWithKey(
      control,
      WEBAUTHN,
      recoveryKey,
      registration(fresh, beginPhoneRegistration(control, now)),
      now
    )
    if (!done.ok) throw new Error(`refused: ${done.code}`)
    expect(done.recoveryKey).toMatch(KEY_SHAPE)
    expect(done.recoveryKey).not.toBe(recoveryKey)
    expect(
      control
        .prepare(
          "SELECT credential_id, revoked_at FROM credentials ORDER BY created_at, credential_id"
        )
        .all()
        .map((r) => [r["credential_id"], r["revoked_at"]])
        .sort()
    ).toEqual(
      [
        [auth.credentialId, null],
        [fresh.credentialId, null],
      ].sort()
    )
    expect(
      control.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"]
    ).toBeGreaterThan(0)
    const again = recoverWithKey(
      control,
      WEBAUTHN,
      recoveryKey,
      registration(testAuthenticator(), beginPhoneRegistration(control, now)),
      now
    )
    expect(again).toEqual({ ok: false, code: "invalid_key" })
    expect(
      auditRows(control).filter((r) => r.action === "recovery.completed")
    ).toHaveLength(1)
    const text = loggedText(control)
    expect(text).not.toContain(recoveryKey.replaceAll("-", ""))
    expect(text).not.toContain(done.recoveryKey.replaceAll("-", ""))
  })

  it("refuses a completion before maturity and enrols nothing", () => {
    const { control, recoveryKey } = matured()
    const now = at(RECOVERY_DELAY_MS - 1000)
    expect(
      recoverWithKey(
        control,
        WEBAUTHN,
        recoveryKey,
        registration(testAuthenticator(), beginPhoneRegistration(control, now)),
        now
      )
    ).toEqual({ ok: false, code: "not_matured" })
    expect(
      control.prepare("SELECT count(*) AS n FROM credentials").get()?.["n"]
    ).toBe(1)
  })
})
