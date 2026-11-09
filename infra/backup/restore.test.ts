import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, test } from "vitest"

import type { Deps } from "./backup.ts"
import { runRestore, verifyRestored } from "./restore.ts"
import type { ResticRun } from "./restic.ts"
import {
  materializeRestore,
  tempDir,
  testConfig,
  writeBlob,
} from "./test-support.ts"

describe.skipIf(process.platform === "win32")("backup restore", () => {
  const failing = (checks: ReturnType<typeof verifyRestored>) =>
    checks.filter((c) => !c.ok).map((c) => c.name)

  test("a sound restore passes every check and reports counts, not contents", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    expect(verifyRestored(config, root)).toEqual([
      { name: "eido-data.db integrity_check", ok: true, detail: "ok" },
      { name: "eido-control.db integrity_check", ok: true, detail: "ok" },
      { name: "audit chain", ok: true, detail: "2 rows verified from seq 1" },
      {
        name: "blobs",
        ok: true,
        detail: "2 blobs, each SHA-256 equals its name",
      },
    ])
  })

  test("a blob whose bytes changed no longer matches its name", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    const blob = writeBlob(join(root, config.blobDir), "third")
    writeFileSync(blob, "third, altered")
    const checks = verifyRestored(config, root)
    expect(failing(checks)).toEqual(["blobs"])
    expect(checks.at(-1)?.detail).toBe(
      "1 of 3 entries do not match their content hash"
    )
  })

  test("a file that is not named by a SHA-256 is reported", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    writeFileSync(join(root, config.blobDir, "notes.txt"), "stray")
    expect(failing(verifyRestored(config, root))).toEqual(["blobs"])
  })

  test("a blob in the wrong shard directory is reported", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    const blob = writeBlob(tempDir(), "moved")
    const name = blob.split("/").at(-1) ?? ""
    mkdirSync(join(root, config.blobDir, "zz"))
    writeFileSync(join(root, config.blobDir, "zz", name), "moved")
    expect(failing(verifyRestored(config, root))).toEqual(["blobs"])
  })

  test("a restore with no blob store passes with a count of zero, visibly", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    rmSync(join(root, config.blobDir), { recursive: true })
    expect(verifyRestored(config, root).at(-1)).toEqual({
      name: "blobs",
      ok: true,
      detail: "0 blobs (the snapshot has no blob store)",
    })
  })

  test("an edited audit row breaks the chain check, and only that check", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    const db = new DatabaseSync(join(root, config.databases[1]?.staged ?? ""))
    db.exec("UPDATE audit_log SET action = 'intent.reject' WHERE seq = 1")
    db.close()
    const checks = verifyRestored(config, root)
    expect(failing(checks)).toEqual(["audit chain"])
    expect(checks.find((c) => c.name === "audit chain")?.detail).toBe(
      "broken at seq 2: prev_hash mismatch"
    )
  })

  test("a database file that is not SQLite fails instead of throwing", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    writeFileSync(
      join(root, config.databases[0]?.staged ?? ""),
      "garbage ".repeat(600)
    )
    expect(failing(verifyRestored(config, root))).toEqual([
      "eido-data.db opens",
    ])
  })

  test("a missing database is reported", () => {
    const root = tempDir()
    const config = testConfig(tempDir())
    materializeRestore(config, root)
    const other = {
      ...config,
      databases: [
        {
          name: "eido-data.db",
          path: "",
          staged: join(config.stagingDir, "gone.db"),
        },
      ],
    }
    expect(failing(verifyRestored(other, root))).toEqual([
      "eido-data.db present",
    ])
  })

  function restoreHarness(config: ReturnType<typeof testConfig>) {
    const restored: string[][] = []
    const clock = [0, 4_500]
    const run: ResticRun = (args) => {
      if (args[0] === "snapshots")
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout: JSON.stringify([
            { id: "aaaa1111", time: "2026-03-01T03:15:00Z" },
            { id: "bbbb2222", time: "2026-03-02T03:15:00Z" },
          ]),
        })
      restored.push([...args])
      materializeRestore(config, args[3] ?? "")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    const deps: Deps = {
      run,
      now: () => new Date(clock.shift() ?? 9_000),
      log: () => undefined,
      env: {},
    }
    return { restored, deps }
  }

  test("restore defaults to the newest snapshot, times the restore and verifies the result", async () => {
    const config = testConfig(tempDir())
    mkdirSync(config.repository, { recursive: true })
    writeFileSync(join(config.repository, "config"), "")
    const target = join(tempDir(), "scratch")
    const { restored, deps } = restoreHarness(config)
    const report = await runRestore(config, deps, target)
    expect(restored).toEqual([["restore", "bbbb2222", "--target", target]])
    expect(report.snapshot).toBe("bbbb2222")
    expect(report.seconds).toBe(4.5)
    expect(failing(report.checks)).toEqual([])
  })

  test("restore can pick an older snapshot by id prefix", async () => {
    const config = testConfig(tempDir())
    mkdirSync(config.repository, { recursive: true })
    writeFileSync(join(config.repository, "config"), "")
    const { restored, deps } = restoreHarness(config)
    await runRestore(config, deps, join(tempDir(), "scratch"), "aaaa")
    expect(restored[0]?.[1]).toBe("aaaa1111")
  })

  test("restore refuses an unknown snapshot and a target that already holds files", async () => {
    const config = testConfig(tempDir())
    mkdirSync(config.repository, { recursive: true })
    writeFileSync(join(config.repository, "config"), "")
    const { restored, deps } = restoreHarness(config)
    await expect(
      runRestore(config, deps, join(tempDir(), "s"), "zzzz")
    ).rejects.toThrow("no snapshot matches zzzz")
    const busy = tempDir()
    writeFileSync(join(busy, "keep"), "x")
    await expect(runRestore(config, deps, busy)).rejects.toThrow("is not empty")
    expect(restored).toEqual([])
    expect(readdirSync(busy)).toEqual(["keep"])
  })

  test("restore of an empty repository fails", async () => {
    const config = testConfig(tempDir())
    mkdirSync(config.repository, { recursive: true })
    writeFileSync(join(config.repository, "config"), "")
    const deps: Deps = {
      run: () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" }),
      now: () => new Date(0),
      log: () => undefined,
      env: {},
    }
    await expect(
      runRestore(config, deps, join(tempDir(), "s"))
    ).rejects.toThrow("the repository has no snapshots")
  })
})
