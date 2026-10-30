import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { auditRows, sample } from "./test-fixtures"
import { payloadHash } from "./canonical"
import { intentTier, kindTier, preparePolicyChange } from "./policy"
import {
  applyPolicyOverrides,
  reloadPolicy,
  runningGate,
  startGate,
  stopGate,
} from "./runtime"
import { WEBAUTHN, controlAuthorization, setup } from "./test-fixtures"
import type { Setup } from "./test-fixtures"

let current: Setup | undefined

function started(): Setup {
  current = setup()
  expect(startGate(current.db, current.options, WEBAUTHN)).toEqual([])
  return current
}

afterEach(() => {
  stopGate()
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

  it("reloads allowed roots from the gate-owned config and audits before and after hashes", () => {
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
    ).toEqual({ tier: "auto" })
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
