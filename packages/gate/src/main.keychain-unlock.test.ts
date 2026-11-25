import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryControlStore } from "./internal/control-checkpoint"
import { socketAddress, WEBAUTHN } from "./internal/test-fixtures"
import { unlockFromStdin } from "./internal/vault/keychain-unlock"
import { InMemoryVault } from "./internal/vault/vault"
import { GATE_LOG_FILE, gateConfig, runGate } from "./main"
import type { GateConfig } from "./main"

const PASSPHRASE = "synthetic-gate-unlock-passphrase"
let dir: string
let keychainPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eido-unlock-"))
  keychainPath = join(dir, "gate.keychain-db")
  writeFileSync(keychainPath, "", { mode: 0o600 })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function env(unlock?: string): Record<string, string> {
  return {
    EIDO_GATE_DATA_DIR: join(dir, "gate"),
    EIDO_GATE_SOCKET: socketAddress(dir, "gate.sock"),
    EIDO_GATE_CONTROL_SOCKET: socketAddress(dir, "control.sock"),
    EIDO_WEBAUTHN_RP_ID: WEBAUTHN.rpId,
    EIDO_WEBAUTHN_ORIGIN: WEBAUTHN.origin,
    EIDO_GATE_KEYCHAIN_PATH: keychainPath,
    ...(unlock === undefined ? {} : { EIDO_GATE_KEYCHAIN_UNLOCK: unlock }),
  }
}

function factories() {
  const opened: string[] = []
  return {
    opened,
    vault: () => {
      opened.push("vault")
      return new InMemoryVault()
    },
    store: () => {
      opened.push("checkpoint")
      return new MemoryControlStore()
    },
  }
}

describe("gateConfig with EIDO_GATE_KEYCHAIN_UNLOCK (#821)", () => {
  it("asks for a stdin unlock of the vault keychain only when set to stdin", () => {
    expect(gateConfig(env("stdin")).keychainUnlock).toEqual({
      path: keychainPath,
    })
    expect(gateConfig(env()).keychainUnlock).toBeUndefined()
    expect(gateConfig(env("")).keychainUnlock).toBeUndefined()
  })

  it("refuses any other value, and a gate without a keychain vault", () => {
    expect(() => gateConfig(env("argv"))).toThrow(
      "EIDO_GATE_KEYCHAIN_UNLOCK must be stdin when set"
    )
    expect(() =>
      gateConfig({ ...env("stdin"), EIDO_GATE_KEYCHAIN_PATH: "" })
    ).toThrow("EIDO_GATE_KEYCHAIN_UNLOCK needs EIDO_GATE_KEYCHAIN_PATH")
  })
})

describe("runGate keychain unlock (#821)", () => {
  async function start(
    config: GateConfig,
    unlock: (path: string) => Promise<void>
  ) {
    const f = factories()
    const result = await runGate(
      config,
      undefined,
      f.vault,
      f.store,
      async (path) => {
        f.opened.push("unlock")
        await unlock(path)
      }
    ).then(
      (gate) => ({ gate, error: undefined }),
      (error: unknown) => ({ gate: undefined, error })
    )
    await result.gate?.close()
    return { ...result, opened: f.opened }
  }

  it("does not unlock, and so never reads stdin, without EIDO_GATE_KEYCHAIN_UNLOCK", async () => {
    const unlock = vi.fn(() => Promise.resolve())
    const { error, opened } = await start(gateConfig(env()), unlock)
    expect(error).toBeUndefined()
    expect(unlock).not.toHaveBeenCalled()
    expect(opened[0]).toBe("checkpoint")
    expect(opened).not.toContain("unlock")
  })

  it("unlocks the configured keychain before opening the control checkpoint", async () => {
    const unlock = vi.fn(() => Promise.resolve())
    const { error, opened } = await start(gateConfig(env("stdin")), unlock)
    expect(error).toBeUndefined()
    expect(unlock).toHaveBeenCalledWith(keychainPath)
    // The vault opens later, for the profile audit; the unlock must come first.
    expect(opened.slice(0, 2)).toEqual(["unlock", "checkpoint"])
    expect(opened.slice(2)).toContain("vault")
    expect(readFileSync(join(dir, "gate", GATE_LOG_FILE), "utf8")).toContain(
      '"event":"keychain_unlocked"'
    )
  })

  // Uses the real owner and mode check on the keychain file, which needs POSIX uids.
  it.skipIf(process.platform === "win32")(
    "with a rejected stdin passphrase, opens neither the checkpoint nor the vault and logs no secret",
    async () => {
      const stdin = Readable.from([Buffer.from(`${PASSPHRASE}\n`)])
      const bridge = vi.fn(() => Promise.resolve("locked" as const))
      const { error, opened } = await start(gateConfig(env("stdin")), (path) =>
        unlockFromStdin(path, stdin, bridge)
      )
      expect(String(error)).toBe(
        "Error: Gate keychain is still locked: the passphrase was rejected"
      )
      expect(bridge).toHaveBeenCalledOnce()
      expect(opened).toEqual(["unlock"])
      const log = readFileSync(join(dir, "gate", GATE_LOG_FILE), "utf8")
      expect(log).toContain('"event":"keychain_unlock_failed"')
      expect(log).not.toContain(PASSPHRASE)
    }
  )
})
