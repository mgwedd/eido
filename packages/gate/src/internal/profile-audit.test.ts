import { describe, expect, it } from "vitest"
import { openControlDb } from "./control-db"
import { initializeProfileAudit } from "./profile-audit"
import { InMemoryVault, type Vault, type VaultKey } from "./vault/vault"

const entry = {
  action: "entity.update",
  subjectHash: "11".repeat(32),
  beforeHash: "22".repeat(32),
  afterHash: "33".repeat(32),
} as const

describe("profile audit HMAC", () => {
  it("persists the key across audit instances and correlates a subject", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    const first = await initializeProfileAudit(db, vault, "epoch_1")
    const second = await initializeProfileAudit(db, vault, "epoch_1")
    const one = await first.tag(entry)
    const two = await second.tag(entry)

    expect(two).toEqual(one)
    expect(one.subjectHash).toMatch(
      /^hmac:v1:epoch_1:[0-9a-f]{64}:[0-9a-f]{64}$/
    )
    db.close()
  })

  it("preserves null before and after digests", async () => {
    const db = openControlDb(":memory:")
    const audit = await initializeProfileAudit(db, new InMemoryVault(), "nulls")

    await expect(
      audit.tag({ ...entry, beforeHash: null, afterHash: null })
    ).resolves.toMatchObject({
      beforeHash: null,
      afterHash: null,
    })
    db.close()
  })

  it("matches the fixed HMAC-SHA256 tuple vector", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    await vault.set(
      {
        connector: "eido-profile-audit:test_epoch",
        kind: "api_key",
        client: "none",
      },
      "11".repeat(32)
    )
    const audit = await initializeProfileAudit(db, vault, "test_epoch")

    const tagged = await audit.tag({
      action: "entity.update",
      subjectHash: "22".repeat(32),
      beforeHash: null,
      afterHash: null,
    })
    expect(tagged.subjectHash).toBe(
      "hmac:v1:test_epoch:02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc:771ccf383fd018e53839fcf563e107dcec957df78495d9c5877620dd1a98dd32"
    )
    db.close()
  })

  it("recovers a valid vault key when its marker was not committed", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    const key = {
      connector: "eido-profile-audit:recovery",
      kind: "api_key",
      client: "none",
    } as const
    await vault.set(key, "ab".repeat(32))

    const audit = await initializeProfileAudit(db, vault, "recovery")
    expect((await audit.tag(entry)).subjectHash).toContain("hmac:v1:recovery:")
    expect(
      db
        .prepare("SELECT key_hash FROM profile_audit_keys WHERE epoch = ?")
        .get("recovery")
    ).toEqual({
      key_hash:
        "9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885",
    })
    db.close()
  })

  it("uses a savepoint when the caller already owns a transaction", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    db.exec("BEGIN IMMEDIATE")

    await initializeProfileAudit(db, vault, "nested")

    expect(db.isTransaction).toBe(true)
    expect(
      db
        .prepare("SELECT epoch FROM profile_audit_keys WHERE epoch = ?")
        .get("nested")
    ).toEqual({
      epoch: "nested",
    })
    db.exec("ROLLBACK")
    db.close()
  })

  it("uses independent keys and separates subject, before, and after roles", async () => {
    const firstDb = openControlDb(":memory:")
    const secondDb = openControlDb(":memory:")
    const first = await initializeProfileAudit(
      firstDb,
      new InMemoryVault(),
      "epoch"
    )
    const second = await initializeProfileAudit(
      secondDb,
      new InMemoryVault(),
      "epoch"
    )
    const sameDigest = "44".repeat(32)
    const tags = await first.tag({
      ...entry,
      subjectHash: sameDigest,
      beforeHash: sameDigest,
      afterHash: sameDigest,
    })
    const other = await second.tag(entry)

    expect(tags.subjectHash).not.toBe(other.subjectHash)
    expect(tags.subjectHash).not.toBe(tags.beforeHash)
    expect(tags.beforeHash).not.toBe(tags.afterHash)
    firstDb.close()
    secondDb.close()
  })

  it("preserves null values and rejects a missing initialized key on initialize and tag", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    const audit = await initializeProfileAudit(db, vault, "epoch")
    await vault.delete({
      connector: "eido-profile-audit:epoch",
      kind: "api_key",
      client: "none",
    })

    await expect(
      audit.tag({ ...entry, beforeHash: null, afterHash: null })
    ).rejects.toThrow("Profile audit key is unavailable or invalid")
    await expect(initializeProfileAudit(db, vault, "epoch")).rejects.toThrow(
      "Profile audit key is unavailable or invalid"
    )
    db.close()
  })

  it("rejects corrupt and replaced vault keys", async () => {
    const db = openControlDb(":memory:")
    const key: VaultKey = {
      connector: "eido-profile-audit:epoch",
      kind: "api_key",
      client: "none",
    }
    const vault = new InMemoryVault()
    const audit = await initializeProfileAudit(db, vault, "epoch")
    await vault.set(key, "not-a-hex-key")
    await expect(audit.tag(entry)).rejects.toThrow(
      "Profile audit key is unavailable or invalid"
    )
    await vault.set(key, "a".repeat(64))
    await expect(audit.tag(entry)).rejects.toThrow(
      "Profile audit key is unavailable or invalid"
    )
    await vault.set(key, "b".repeat(64))
    db.prepare(
      "UPDATE profile_audit_keys SET key_hash = ? WHERE epoch = ?"
    ).run("invalid", "epoch")
    await expect(audit.tag(entry)).rejects.toThrow(
      "Profile audit key is unavailable or invalid"
    )
    db.close()
  })

  it("rejects a marker removed after initialization", async () => {
    const db = openControlDb(":memory:")
    const audit = await initializeProfileAudit(
      db,
      new InMemoryVault(),
      "marker-loss"
    )
    db.prepare("DELETE FROM profile_audit_keys WHERE epoch = ?").run(
      "marker-loss"
    )

    await expect(audit.tag(entry)).rejects.toThrow(
      "Profile audit key is unavailable or invalid"
    )
    db.close()
  })

  it("does not replace keys when vault reads or writes fail", async () => {
    const db = openControlDb(":memory:")
    const brokenGet: Vault = {
      get: () => Promise.reject(new Error("secret data")),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    }
    await expect(
      initializeProfileAudit(db, brokenGet, "read-fail")
    ).rejects.toThrow("Profile audit key is unavailable or invalid")
    const brokenSet: Vault = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error("secret data")),
      delete: () => Promise.resolve(),
    }
    await expect(
      initializeProfileAudit(db, brokenSet, "write-fail")
    ).rejects.toThrow("Profile audit key is unavailable or invalid")
    expect(db.prepare("SELECT epoch FROM profile_audit_keys").all()).toEqual([])
    db.close()
  })

  it("rejects a vault value that changes during key creation readback", async () => {
    let reads = 0
    const vault: Vault = {
      get: () => {
        reads += 1
        return Promise.resolve(reads === 1 ? undefined : "cd".repeat(32))
      },
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    }
    const db = openControlDb(":memory:")

    await expect(initializeProfileAudit(db, vault, "readback")).rejects.toThrow(
      "Profile audit key is unavailable or invalid"
    )
    expect(db.prepare("SELECT epoch FROM profile_audit_keys").all()).toEqual([])
    db.close()
  })

  it("rotates by epoch while retaining prior metadata and vault keys", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    const oldAudit = await initializeProfileAudit(db, vault, "old")
    const oldTag = await oldAudit.tag(entry)
    const oldSecret = await vault.get({
      connector: "eido-profile-audit:old",
      kind: "api_key",
      client: "none",
    })
    const newAudit = await initializeProfileAudit(db, vault, "new")
    const newTag = await newAudit.tag(entry)

    expect(newTag.subjectHash).not.toBe(oldTag.subjectHash)
    expect(
      await vault.get({
        connector: "eido-profile-audit:old",
        kind: "api_key",
        client: "none",
      })
    ).toBe(oldSecret)
    expect(
      db.prepare("SELECT epoch FROM profile_audit_keys ORDER BY epoch").all()
    ).toEqual([{ epoch: "new" }, { epoch: "old" }])
    db.close()
  })

  it("validates epochs before vault access", async () => {
    const db = openControlDb(":memory:")
    const vault = new InMemoryVault()
    await expect(
      initializeProfileAudit(db, vault, "bad:epoch")
    ).rejects.toThrow("Profile audit key is unavailable or invalid")
    expect(db.prepare("SELECT epoch FROM profile_audit_keys").all()).toEqual([])
    db.close()
  })
})
