import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"

import {
  assertRepositoryReachable,
  runBackup,
  runCheck,
  type Deps,
} from "./backup.ts"
import type { BackupConfig } from "./config.ts"
import type { ResticRun } from "./restic.ts"
import { openWal, tempDir, testConfig, writeBlob } from "./test-support.ts"

const NOW = new Date("2026-03-10T03:15:00.000Z")

/** A repository the code under test accepts as initialised: a directory holding a `config` file. */
function initRepo(config: BackupConfig): void {
  mkdirSync(config.repository, { recursive: true })
  writeFileSync(join(config.repository, "config"), "")
}

/** Synthetic live databases; the last write of each stays uncheckpointed in its WAL. */
function liveData(config: BackupConfig): DatabaseSync[] {
  return config.databases.map((db) => {
    const live = openWal(db.path)
    live.exec("CREATE TABLE t (x TEXT)")
    live.exec("INSERT INTO t VALUES ('in-wal-only')")
    return live
  })
}

type Call = { args: readonly string[]; env: Readonly<Record<string, string>> }

function harness(
  handler: (call: Call) => {
    code: number
    stdout?: string
    stderr?: string
  } = () => ({ code: 0 }),
  now = NOW
) {
  const calls: Call[] = []
  const logs: string[] = []
  const run: ResticRun = (args, env) => {
    const call = { args, env }
    calls.push(call)
    const result = handler(call)
    return Promise.resolve({
      code: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    })
  }
  const deps: Deps = {
    run,
    now: () => now,
    log: (line) => logs.push(line),
    env: {},
  }
  return { calls, logs, deps }
}

test("restic sees consistent copies of both databases, including WAL-only writes, then retention runs and the stamp is written", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const live = liveData(config)
  writeBlob(config.blobDir, "synthetic original")
  const seen: string[] = []
  const { calls, deps } = harness((call) => {
    if (call.args[0] === "backup")
      for (const db of config.databases) {
        const copy = new DatabaseSync(db.staged, { readOnly: true })
        seen.push(String(copy.prepare("SELECT x FROM t").get()?.["x"]))
        copy.close()
      }
    return { code: 0 }
  })

  await runBackup(config, deps)

  expect(seen).toEqual(["in-wal-only", "in-wal-only"])
  expect(calls.map((c) => c.args[0])).toEqual(["backup", "forget"])
  expect(calls[0]?.args).toContain(config.stagingDir)
  expect(calls[0]?.args).toContain(config.blobDir)
  expect(calls[1]?.args).toContain("--prune")
  expect(readFileSync(config.stampFile, "utf8")).toBe(
    "2026-03-10T03:15:00.000Z\n"
  )
  for (const l of live) l.close()
})

test("the plaintext staging copies are removed after the run", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const live = liveData(config)
  await runBackup(config, harness().deps)
  expect(existsSync(config.stagingDir)).toBe(false)
  for (const l of live) l.close()
})

test("restic gets the repository and a Keychain passphrase command, and no password is logged", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const live = liveData(config)
  const { calls, logs, deps } = harness()
  await runBackup(config, deps)
  expect(calls[0]?.env["RESTIC_REPOSITORY"]).toBe(config.repository)
  expect(calls[0]?.env["RESTIC_PASSWORD_COMMAND"]).toContain(
    "find-generic-password"
  )
  expect(logs.join("\n")).not.toMatch(/password/i)
  for (const l of live) l.close()
})

test("a machine with no blobs yet backs up the databases only", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const live = liveData(config)
  const { calls, logs, deps } = harness()
  await runBackup(config, deps)
  expect(calls[0]?.args).not.toContain(config.blobDir)
  expect(logs).toContain("no blob store yet; backing up the databases only")
  for (const l of live) l.close()
})

test("with the drive absent the run fails before any restic call, staging or stamp", async () => {
  const config = {
    ...testConfig(tempDir()),
    repository: "/Volumes/eido-backup-test-drive-that-is-not-plugged-in/restic",
  }
  const live = liveData(config)
  const { calls, deps } = harness()
  await expect(runBackup(config, deps)).rejects.toThrow(
    "backup drive not mounted: /Volumes/eido-backup-test-drive-that-is-not-plugged-in does not exist"
  )
  expect(calls).toEqual([])
  expect(existsSync(config.stagingDir)).toBe(false)
  expect(existsSync(config.stampFile)).toBe(false)
  expect(existsSync(config.repository)).toBe(false)
  for (const l of live) l.close()
})

test("a repository path that holds no restic repository is an error and is not created", () => {
  const config = testConfig(tempDir())
  mkdirSync(dirname(config.repository), { recursive: true })
  expect(() => assertRepositoryReachable(config)).toThrow(
    "no restic repository at"
  )
  expect(existsSync(config.repository)).toBe(false)
})

test("a failing restic backup fails the run, keeps the old stamp and still removes staging", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  mkdirSync(dirname(config.stampFile), { recursive: true })
  writeFileSync(config.stampFile, "2026-03-09T03:15:00.000Z\n")
  const live = liveData(config)
  const { calls, deps } = harness(() => ({
    code: 1,
    stderr: "repository is locked",
  }))
  await expect(runBackup(config, deps)).rejects.toThrow(
    "restic backup exited 1: repository is locked"
  )
  expect(calls.map((c) => c.args[0])).toEqual(["backup"])
  expect(readFileSync(config.stampFile, "utf8")).toBe(
    "2026-03-09T03:15:00.000Z\n"
  )
  expect(existsSync(config.stagingDir)).toBe(false)
  for (const l of live) l.close()
})

test("a missing database fails the run before restic is called", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const { calls, deps } = harness()
  await expect(runBackup(config, deps)).rejects.toThrow("database not found")
  expect(calls).toEqual([])
})

const snapshots = (...times: string[]) =>
  JSON.stringify(times.map((time, i) => ({ id: `snap${i}`, time })))

test("check passes for a snapshot under 36 hours old", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const { deps } = harness(() => ({
    code: 0,
    stdout: snapshots("2026-03-08T20:00:00Z", "2026-03-09T20:00:00Z"),
  }))
  expect(await runCheck(config, deps)).toEqual({ id: "snap1", ageHours: 7.25 })
})

test("check fails when the newest snapshot is 37 hours old", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const { deps } = harness(() => ({
    code: 0,
    stdout: snapshots("2026-03-08T14:15:00Z"),
  }))
  await expect(runCheck(config, deps)).rejects.toThrow(
    "newest snapshot snap0 is 37 hours old (limit 36)"
  )
})

test("check fails on an empty repository", async () => {
  const config = testConfig(tempDir())
  initRepo(config)
  const { deps } = harness(() => ({ code: 0, stdout: "[]" }))
  await expect(runCheck(config, deps)).rejects.toThrow(
    "the repository has no snapshots"
  )
})

test("check fails with the drive absent, without calling restic", async () => {
  const config = testConfig(tempDir())
  const { calls, deps } = harness()
  await expect(runCheck(config, deps)).rejects.toThrow("no restic repository")
  expect(calls).toEqual([])
})
