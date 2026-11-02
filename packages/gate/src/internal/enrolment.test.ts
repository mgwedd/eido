import type { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import {
  beginRegistration,
  registerCredential,
  revokeCredential,
} from "./credentials"
import {
  checkEnrolmentCode,
  consumeEnrolmentCode,
  issueEnrolmentCode,
  normaliseEnrolmentCode,
} from "./enrolment"
import { sha256 } from "./webauthn"
import {
  WEBAUTHN,
  auditRows,
  loggedText,
  registration,
  setup,
  testAuthenticator,
} from "./test-fixtures"
import type { Setup } from "./test-fixtures"

const START = new Date("2026-10-19T08:00:00.000Z")
const MINUTE = 60 * 1000

let current: Setup | undefined
let at: Date
const clock = () => at

afterEach(() => {
  current?.cleanup()
  current = undefined
})

function db(): DatabaseSync {
  current = setup()
  at = START
  return current.db
}

function issue(control: DatabaseSync): string {
  const issued = issueEnrolmentCode(control, "admin", clock)
  if (!issued.ok) throw new Error("enrolment code refused")
  return issued.code
}

function codeActions(control: DatabaseSync): string[] {
  return auditRows(control)
    .filter((row) => row.target === "enrolment_code")
    .map((row) => row.action)
}

describe("issueEnrolmentCode", () => {
  it("issues a grouped 80-bit Crockford code that expires in ten minutes", () => {
    const control = db()
    const issued = issueEnrolmentCode(control, "admin", clock)
    expect(issued).toEqual({
      ok: true,
      code: expect.stringMatching(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
      ) as unknown,
      expiresAt: new Date("2026-10-19T08:10:00.000Z"),
    })
    expect(issue(control)).not.toBe(issued.ok ? issued.code : "")
  })

  it("stores and audits only the hash of the code", () => {
    const control = db()
    const code = issue(control)
    const bare = code.replace(/-/g, "")
    const rows = control.prepare("SELECT code_hash FROM enrolment_codes").all()
    expect(rows).toEqual([{ code_hash: sha256(bare).toString("hex") }])
    expect(codeActions(control)).toEqual(["enrolment_code.issued"])
    expect(loggedText(control)).not.toContain(bare)
    expect(loggedText(control)).not.toContain(code)
    expect(verifyChain(control).ok).toBe(true)
  })

  it("refuses the phone-facing surface and audits it", () => {
    const control = db()
    expect(issueEnrolmentCode(control, "phone", clock)).toEqual({
      ok: false,
      code: "admin_only",
    })
    const count = control
      .prepare("SELECT count(*) AS n FROM enrolment_codes")
      .get()
    expect(count?.["n"]).toBe(0)
    expect(codeActions(control)).toEqual(["enrolment_code.issue_refused"])
  })
})

describe("consumeEnrolmentCode", () => {
  it("accepts a code once, as typed in lower case without dashes", () => {
    const control = db()
    const code = issue(control)
    const typed = code.replace(/-/g, " ").toLowerCase()
    expect(consumeEnrolmentCode(control, "phone", typed, clock)).toEqual({
      ok: true,
    })
    expect(consumeEnrolmentCode(control, "phone", code, clock)).toEqual({
      ok: false,
      code: "reused",
    })
    expect(codeActions(control)).toEqual([
      "enrolment_code.issued",
      "enrolment_code.consumed",
      "enrolment_code.refused",
    ])
    expect(loggedText(control)).not.toContain(code.replace(/-/g, ""))
  })

  it("refuses a code at its expiry and audits it", () => {
    const control = db()
    const code = issue(control)
    at = new Date(START.getTime() + 10 * MINUTE)
    expect(consumeEnrolmentCode(control, "phone", code, clock)).toEqual({
      ok: false,
      code: "expired",
    })
    expect(codeActions(control)).toEqual([
      "enrolment_code.issued",
      "enrolment_code.refused",
    ])
  })

  it("accepts a code just before its expiry", () => {
    const control = db()
    const code = issue(control)
    at = new Date(START.getTime() + 10 * MINUTE - 1)
    expect(consumeEnrolmentCode(control, "phone", code, clock).ok).toBe(true)
  })

  it("refuses a code that a newer one superseded, and accepts the newer one", () => {
    const control = db()
    const first = issue(control)
    const second = issue(control)
    expect(consumeEnrolmentCode(control, "phone", first, clock)).toEqual({
      ok: false,
      code: "superseded",
    })
    expect(consumeEnrolmentCode(control, "phone", second, clock).ok).toBe(true)
  })

  it.each([
    ["a well-formed code never issued", "0000-0000-0000-0000"],
    ["too short", "ABCD-EFGH"],
    ["a character outside the alphabet", "ABCD-EFGH-JKMN-PQRU"],
    ["over-long input", "A".repeat(65)],
  ])("refuses %s as unknown and audits it", (_, input) => {
    const control = db()
    issue(control)
    expect(consumeEnrolmentCode(control, "phone", input, clock)).toEqual({
      ok: false,
      code: "unknown",
    })
    expect(codeActions(control)).toEqual([
      "enrolment_code.issued",
      "enrolment_code.refused",
    ])
    expect(loggedText(control)).not.toContain(input)
  })

  it("rolls back with the caller's transaction", () => {
    const control = db()
    const code = issue(control)
    control.exec("BEGIN IMMEDIATE")
    expect(consumeEnrolmentCode(control, "phone", code, clock).ok).toBe(true)
    control.exec("ROLLBACK")
    expect(consumeEnrolmentCode(control, "phone", code, clock).ok).toBe(true)
  })
})

describe("normaliseEnrolmentCode", () => {
  it("reads the Crockford look-alikes O, I and L as 0, 1 and 1", () => {
    expect(normaliseEnrolmentCode("oOiI-lL00-1111-ABCD")).toBe(
      "00111100" + "1111ABCD"
    )
  })
})

describe("re-enrolment after a revoke", () => {
  it("enrols a new credential with a new code and leaves the revoked one revoked", () => {
    const control = db()
    const challenge = () => {
      const begun = beginRegistration(control, "admin")
      if (!begun.ok) throw new Error("enrolment challenge refused")
      return begun.challenge
    }
    const lost = testAuthenticator()
    expect(
      registerCredential(
        control,
        WEBAUTHN,
        "admin",
        registration(lost, challenge())
      ).ok
    ).toBe(true)
    expect(revokeCredential(control, "admin", lost.credentialId).ok).toBe(true)

    const code = issue(control)
    expect(consumeEnrolmentCode(control, "phone", code, clock).ok).toBe(true)
    const replacement = testAuthenticator()
    expect(
      registerCredential(
        control,
        WEBAUTHN,
        "admin",
        registration(replacement, challenge())
      )
    ).toEqual({ ok: true, credentialId: replacement.credentialId })

    const rows = control
      .prepare(
        "SELECT credential_id, revoked_at FROM credentials ORDER BY rowid"
      )
      .all()
    expect(rows).toEqual([
      {
        credential_id: lost.credentialId,
        revoked_at: expect.any(String) as unknown,
      },
      { credential_id: replacement.credentialId, revoked_at: null },
    ])
  })
})

describe("checkEnrolmentCode", () => {
  it("accepts a live code without consuming it, and reports its expiry", () => {
    const d = db()
    const issued = issueEnrolmentCode(d, "admin", clock)
    if (!issued.ok) throw new Error("not issued")
    expect(checkEnrolmentCode(d, "phone", issued.code, clock)).toEqual({
      ok: true,
      expiresAt: new Date("2026-10-19T08:10:00.000Z"),
    })
    expect(consumeEnrolmentCode(d, "phone", issued.code, clock)).toEqual({
      ok: true,
    })
  })

  it("refuses a superseded code and audits the refusal with its hash", () => {
    const d = db()
    const first = issueEnrolmentCode(d, "admin", clock)
    issueEnrolmentCode(d, "admin", clock)
    if (!first.ok) throw new Error("not issued")
    expect(checkEnrolmentCode(d, "phone", first.code, clock)).toEqual({
      ok: false,
      code: "superseded",
    })
    expect(auditRows(d).at(-1)?.action).toBe("enrolment_code.refused")
    expect(loggedText(d)).not.toContain(first.code.replace(/-/g, ""))
  })

  it("refuses text that cannot be a code as unknown", () => {
    const d = db()
    expect(checkEnrolmentCode(d, "phone", "not a code", clock)).toEqual({
      ok: false,
      code: "unknown",
    })
  })
})
