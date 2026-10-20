import { describe, expect, it } from "vitest"
import { verifyChain } from "./audit"
import { payloadHash } from "./canonical"
import {
  getPinnedManifest,
  pinManifest,
  prepareManifestPin,
} from "./connectors"
import { openControlDb } from "./control-db"
import {
  kindTier,
  loadPolicy,
  preparePolicyChange,
  setPolicyOverrides,
} from "./policy"
import {
  MAIL_OPS,
  WEBAUTHN,
  auditRows,
  controlAuthorization,
  manifest,
  setup,
} from "./test-fixtures"

describe("signed control changes", () => {
  it("refuses an unsigned pin without enabling, storing, or auditing the manifest", () => {
    const db = openControlDb(":memory:")
    const mail = manifest("mail", MAIL_OPS)
    expect(() => pinManifest(db, mail, "owner")).toThrow(
      "control approval refused"
    )
    expect(getPinnedManifest(db, "mail")).toBeUndefined()
    expect(auditRows(db)).toEqual([])
    db.close()
  })

  it("binds the signature to the exact manifest and consumes it once", () => {
    const db = openControlDb(":memory:")
    const mail = manifest("mail", MAIL_OPS)
    const prepared = prepareManifestPin(db, mail)
    const authorization = controlAuthorization(db, prepared)
    const changed = { ...mail, description: "Different reviewed content" }
    expect(() => pinManifest(db, changed, "owner", authorization)).toThrow(
      "control approval refused"
    )
    expect(getPinnedManifest(db, "mail")).toBeUndefined()
    expect(auditRows(db)).toEqual([])
    pinManifest(db, mail, "owner", authorization)
    const before = auditRows(db)
    expect(() => pinManifest(db, mail, "owner", authorization)).toThrow(
      "control approval refused"
    )
    expect(auditRows(db)).toEqual(before)
    const ref = db
      .prepare(
        "SELECT pin_approval_ref_hash FROM connectors WHERE name = 'mail'"
      )
      .get()?.["pin_approval_ref_hash"]
    expect(typeof ref).toBe("string")
    expect(before[0]?.detail_hash).toBe(
      payloadHash({ manifestHash: prepared.payloadHash, approvalRefHash: ref })
    )
    expect(JSON.stringify(before)).not.toContain(mail.description)
    expect(verifyChain(db).ok).toBe(true)
    db.close()
  })

  it("refuses a policy assertion for a manifest pin and preserves the pin state", () => {
    const db = openControlDb(":memory:")
    const mail = manifest("mail", MAIL_OPS)
    const prepared = preparePolicyChange(db, { version: 1, tiers: {} })
    const authorization = controlAuthorization(db, prepared)
    expect(() => pinManifest(db, mail, "owner", authorization)).toThrow(
      "control approval refused"
    )
    expect(getPinnedManifest(db, "mail")).toBeUndefined()
    expect(auditRows(db)).toEqual([])
    db.close()
  })

  it("keeps unsigned policy proposals out of the effective policy across reloads", () => {
    const s = setup()
    const override = { version: 1, tiers: { "email.archive": "approval" } }
    s.writeOverlay(override)
    expect(loadPolicy(s.db, s.options, s.policy).errors).toContain(
      "permissions.json: a changed proposal requires a signed approval"
    )
    expect(
      kindTier(s.db, loadPolicy(s.db, s.options).policy, "email.archive")
    ).toEqual({ tier: "auto" })
    expect(() => setPolicyOverrides(s.db, override, "owner")).toThrow(
      "control approval refused"
    )
    expect(s.db.prepare("SELECT * FROM approved_policy").all()).toEqual([])
    s.cleanup()
  })

  it("applies only the signed policy hash and refuses replay or changed content", () => {
    const s = setup()
    const override = { version: 1, tiers: { "email.archive": "approval" } }
    const prepared = preparePolicyChange(s.db, override)
    const authorization = controlAuthorization(s.db, prepared)
    expect(() =>
      setPolicyOverrides(
        s.db,
        { version: 1, tiers: { "email.draft": "approval" } },
        "owner",
        authorization
      )
    ).toThrow("control approval refused")
    expect(s.db.prepare("SELECT * FROM approved_policy").all()).toEqual([])
    setPolicyOverrides(s.db, override, "owner", authorization)
    expect(
      kindTier(s.db, loadPolicy(s.db, s.options).policy, "email.archive")
    ).toEqual({ tier: "approval" })
    const before = auditRows(s.db)
    expect(() =>
      setPolicyOverrides(s.db, override, "owner", authorization)
    ).toThrow("control approval refused")
    expect(auditRows(s.db)).toEqual(before)
    expect(verifyChain(s.db).ok).toBe(true)
    s.cleanup()
  })

  it("refuses assertions signed for another relying party or origin", () => {
    const db = openControlDb(":memory:")
    const mail = manifest("mail", MAIL_OPS)
    const prepared = prepareManifestPin(db, mail)
    const authorization = controlAuthorization(db, prepared)
    expect(() =>
      pinManifest(db, mail, "owner", {
        ...authorization,
        config: { ...WEBAUTHN, rpId: "elsewhere.invalid" },
      })
    ).toThrow("control approval refused")
    expect(auditRows(db)).toEqual([])
    db.close()
  })
})
