import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { auditRows, sample } from "./test-fixtures"
import { payloadHash } from "./canonical"
import {
  ControlStateError,
  MemoryControlStore,
  attachControlCheckpoint,
} from "./control-checkpoint"
import type { ControlCheckpoint, RetrySchedule } from "./control-checkpoint"
import {
  SHIPPED_DEFAULT_PATH,
  intentTier,
  kindTier,
  preparePolicyChange,
} from "./policy"
import {
  applyPolicyOverrides,
  policyPending,
  reloadPolicy,
  resumeGate,
  runningGate,
  startGate,
  stopGate,
} from "./runtime"
import { WEBAUTHN, controlAuthorization, setup } from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let current: Setup | undefined
let checkpoint: ControlCheckpoint | undefined

function started(): Setup {
  current = setup()
  expect(startGate(current.db, current.options, WEBAUTHN)).toEqual([])
  return current
}

afterEach(() => {
  stopGate()
  checkpoint?.close()
  checkpoint = undefined
  current?.cleanup()
  current = undefined
})

describe("the running gate", () => {
  it("is not available before it starts", () => {
    expect(() => runningGate()).toThrow("the gate is not started")
  })

  it("starts with an origin that carries the app's own port", () => {
    current = setup()
    expect(
      startGate(current.db, current.options, {
        rpId: "node.example.ts.net",
        origin: "https://node.example.ts.net:8443",
      })
    ).toEqual([])
    expect(runningGate().webAuthn.origin).toBe(
      "https://node.example.ts.net:8443"
    )
  })

  it("refuses to start with an origin that is not https://<rpId>[:<port>]", () => {
    const s = setup()
    current = s
    expect(() =>
      startGate(s.db, s.options, {
        rpId: WEBAUTHN.rpId,
        origin: "http://eido.example.invalid",
      })
    ).toThrow(
      "the WebAuthn origin must be https://<rpId> or https://<rpId>:<port>"
    )
    expect(() => runningGate()).toThrow("the gate is not started")
  })

  it("starts once", () => {
    const s = started()
    expect(() => startGate(s.db, s.options, WEBAUTHN)).toThrow(
      "the gate is already started"
    )
  })

  it("applies a signed override and keeps it when a later proposal is rejected", () => {
    const s = started()
    const override = { version: 1, tiers: { "email.archive": "approval" } }
    s.writeOverlay(override)
    const prepared = preparePolicyChange(s.db, override)
    const authorization = controlAuthorization(s.db, prepared)
    expect(
      applyPolicyOverrides(override, "owner", authorization.request)
    ).toEqual([])
    expect(kindTier(s.db, runningGate().policy, "email.archive")).toEqual({
      tier: "approval",
    })
    s.writeOverlay({ version: 1, tiers: { "email.archive": "forbidden" } })
    expect(reloadPolicy()).toHaveLength(1)
    expect(kindTier(s.db, runningGate().policy, "email.archive")).toEqual({
      tier: "approval",
    })
  })

  it("reloads owner config but does not grant file authority from allowedRoots", () => {
    const s = setup()
    current = s
    const path = join(s.dataDir, "owner-config.json")
    const writeConfig = (roots: string[]) => {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          ownerAddresses: ["owner@example.com"],
          allowedRoots: roots,
        }),
        { mode: 0o600 }
      )
      chmodSync(path, 0o600)
    }
    writeConfig(["notes"])
    const options = { ...s.options, ownerConfigPath: path }
    expect(startGate(s.db, options, WEBAUTHN)).toEqual([])
    expect(runningGate().policy.allowedRoots).toEqual(["notes"])
    writeConfig(["work"])
    expect(reloadPolicy()).toEqual([])
    expect(runningGate().policy.allowedRoots).toEqual(["work"])
    expect(reloadPolicy()).toEqual([])
    expect(
      auditRows(s.db).filter((row) => row.action === "owner_config.reloaded")
    ).toHaveLength(1)
    expect(
      intentTier(
        s.db,
        runningGate().policy,
        sample("file.create", { root: "work" })
      )
    ).toEqual({ tier: "forbidden", reason: "root_not_allowed" })
    expect(
      intentTier(
        s.db,
        runningGate().policy,
        sample("file.create", { root: "notes" })
      )
    ).toEqual({ tier: "forbidden", reason: "root_not_allowed" })
    const changes = auditRows(s.db).filter(
      (row) => row.action === "owner_config.reloaded"
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]?.detail_hash).toBe(
      payloadHash({
        before_hash: createHash("sha256")
          .update(
            JSON.stringify({
              version: 1,
              ownerAddresses: ["owner@example.com"],
              allowedRoots: ["notes"],
            })
          )
          .digest("hex"),
        after_hash: createHash("sha256")
          .update(
            JSON.stringify({
              version: 1,
              ownerAddresses: ["owner@example.com"],
              allowedRoots: ["work"],
            })
          )
          .digest("hex"),
      })
    )
  })

  it("applies the platform owner-config access check", () => {
    const s = setup()
    current = s
    const path = join(s.dataDir, "owner-config.json")
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ownerAddresses: ["owner@example.com"],
        allowedRoots: ["notes"],
      }),
      { mode: 0o644 }
    )
    const errors = startGate(
      s.db,
      { ...s.options, ownerConfigPath: path },
      WEBAUTHN
    )
    if (process.platform === "win32") {
      expect(errors).toEqual([])
      expect(runningGate().policy.allowedRoots).toEqual(["notes"])
      expect(
        auditRows(s.db).some((row) => row.action === "owner_config.loaded")
      ).toBe(true)
    } else {
      expect(errors).toContain(
        "owner-config.json: accessible by group or others; only the gate user may access it"
      )
      expect(runningGate().policy.allowedRoots).toEqual([])
      expect(
        auditRows(s.db).some((row) => row.action === "owner_config.rejected")
      ).toBe(true)
    }
  })

  it("starts closed when owner config is missing and accepts it on reload", () => {
    const s = setup()
    current = s
    const path = join(s.dataDir, "owner-config.json")
    const options = { ...s.options, ownerConfigPath: path }
    expect(startGate(s.db, options, WEBAUTHN)).toContain(
      "owner-config.json: unavailable"
    )
    expect(runningGate().policy.allowedRoots).toEqual([])
    expect(
      auditRows(s.db).some((row) => row.action === "owner_config.rejected")
    ).toBe(true)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ownerAddresses: ["owner@example.com"],
        allowedRoots: ["notes"],
      }),
      { mode: 0o600 }
    )
    chmodSync(path, 0o600)
    expect(reloadPolicy()).toEqual([])
    expect(runningGate().policy.allowedRoots).toEqual(["notes"])
  })

  it("retains the accepted roots when a reload file is malformed", () => {
    const s = setup()
    current = s
    const path = join(s.dataDir, "owner-config.json")
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ownerAddresses: ["owner@example.com"],
        allowedRoots: ["notes"],
      }),
      { mode: 0o600 }
    )
    chmodSync(path, 0o600)
    expect(
      startGate(s.db, { ...s.options, ownerConfigPath: path }, WEBAUTHN)
    ).toEqual([])
    writeFileSync(path, "{")
    expect(reloadPolicy()).toContain("owner-config.json: not valid JSON")
    expect(runningGate().policy.allowedRoots).toEqual(["notes"])
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ownerAddresses: [" "],
        allowedRoots: ["other"],
      })
    )
    expect(reloadPolicy()).toContain(
      "owner-config.json: expected version 1 and non-empty string arrays"
    )
    expect(runningGate().policy.allowedRoots).toEqual(["notes"])
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ownerAddresses: ["owner@example.com"],
        allowedRoots: ["other"],
        unexpected: true,
      })
    )
    expect(reloadPolicy()).toContain(
      "owner-config.json: expected version 1 and non-empty string arrays"
    )
    expect(runningGate().policy.allowedRoots).toEqual(["notes"])
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        ownerAddresses: ["owner@example.com"],
        allowedRoots: [" "],
      })
    )
    expect(reloadPolicy()).toContain(
      "owner-config.json: expected version 1 and non-empty string arrays"
    )
    expect(runningGate().policy.allowedRoots).toEqual(["notes"])
    expect(
      auditRows(s.db).some((row) => row.action === "owner_config.rejected")
    ).toBe(true)
  })
})

/** Reads the denial reason a call throws; fails the test when it does not throw one. */
function deniedReason(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    if (error instanceof ControlStateError) return error.reason
    throw error
  }
  throw new Error("expected a control-state denial")
}

describe("a gate started with the control checkpoint locked (#870)", () => {
  // A database with no control state verifies by initialising the store once it unlocks.
  function lockedStart(store: MemoryControlStore) {
    const s = setup([])
    current = s
    const retries: (() => void)[] = []
    const schedule: RetrySchedule = (run) => {
      retries.push(run)
      return () => undefined
    }
    checkpoint = attachControlCheckpoint(s.db, { store, schedule })
    const shippedPath = join(s.dataDir, "permissions.default.json")
    copyFileSync(SHIPPED_DEFAULT_PATH, shippedPath)
    const options = { ...s.options, shippedPath }
    return { s, options, retries }
  }

  it("starts without a policy and denies every policy read as keychain_locked", () => {
    const store = new MemoryControlStore()
    store.locked = true
    const { s, options } = lockedStart(store)
    expect(startGate(s.db, options, WEBAUTHN)).toEqual([])
    expect(policyPending()).toBe(true)
    expect(runningGate().webAuthn).toEqual(WEBAUTHN)
    expect(deniedReason(() => runningGate().policy)).toBe("keychain_locked")
    expect(deniedReason(() => reloadPolicy())).toBe("keychain_locked")
  })

  it("loads the policy once the checkpoint verifies, and only once", () => {
    const store = new MemoryControlStore()
    store.locked = true
    const { s, options, retries } = lockedStart(store)
    startGate(s.db, options, WEBAUTHN)
    store.locked = false
    retries[0]?.()
    expect(checkpoint?.denied()).toBeUndefined()
    // Verified, but not loaded yet: the read still refuses until resumeGate runs.
    expect(deniedReason(() => runningGate().policy)).toBe("keychain_locked")
    expect(resumeGate()).toEqual([])
    expect(policyPending()).toBe(false)
    expect(runningGate().policy.allowedRoots).toEqual(s.options.allowedRoots)
    expect(() => resumeGate()).toThrow("the gate already has its policy")
  })

  it("stays without a policy when the load after verification fails, and loads on a later try", () => {
    const store = new MemoryControlStore()
    store.locked = true
    const { s, options, retries } = lockedStart(store)
    startGate(s.db, options, WEBAUTHN)
    store.locked = false
    retries[0]?.()
    writeFileSync(options.shippedPath, "{")
    expect(() => resumeGate()).toThrow(SyntaxError)
    expect(policyPending()).toBe(true)
    expect(() => runningGate().policy).toThrow(SyntaxError)
    copyFileSync(SHIPPED_DEFAULT_PATH, options.shippedPath)
    expect(resumeGate()).toEqual([])
    expect(policyPending()).toBe(false)
  })

  it("still refuses to start for every other denial", () => {
    const store = new MemoryControlStore()
    store.failLoads = true
    const { s, options } = lockedStart(store)
    expect(deniedReason(() => startGate(s.db, options, WEBAUTHN))).toBe(
      "store_unreadable"
    )
    expect(() => runningGate()).toThrow("the gate is not started")
  })

  it("denies with the checkpoint's new reason when the unlocked store does not verify", () => {
    const store = new MemoryControlStore()
    store.locked = true
    const { s, options, retries } = lockedStart(store)
    startGate(s.db, options, WEBAUTHN)
    store.locked = false
    store.value = "not a record"
    retries[0]?.()
    expect(deniedReason(() => runningGate().policy)).toBe("store_malformed")
    expect(deniedReason(() => resumeGate())).toBe("store_malformed")
  })
})
