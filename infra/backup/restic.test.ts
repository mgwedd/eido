import { BackupError } from "./errors.ts"
import { expect, test } from "vitest"

import {
  backupArgs,
  forgetArgs,
  mustRun,
  parseSnapshots,
  resticEnv,
} from "./restic.ts"
import { testConfig } from "./test-support.ts"

const config = testConfig("/data")

test("without a passphrase source, restic is told to read the Keychain", () => {
  const env = resticEnv(config, {})
  expect(env["RESTIC_REPOSITORY"]).toBe(config.repository)
  expect(env["RESTIC_PASSWORD_COMMAND"]).toBe(
    "/usr/bin/security find-generic-password -s eido-backup -a restic -w"
  )
})

test.each([
  "RESTIC_PASSWORD",
  "RESTIC_PASSWORD_FILE",
  "RESTIC_PASSWORD_COMMAND",
])("%s in the caller's environment is left alone", (name) => {
  const env = resticEnv(config, { [name]: "from-the-caller" })
  expect(env).toEqual({ RESTIC_REPOSITORY: config.repository })
})

test("the backup includes the staging copies and the blob store, and skips temporary blob files", () => {
  expect(backupArgs(config, true)).toEqual([
    "backup",
    "--host",
    "eido",
    "--tag",
    "eido-nightly",
    "--exclude",
    "*.tmp",
    config.stagingDir,
    config.blobDir,
  ])
  expect(backupArgs(config, false).at(-1)).toBe(config.stagingDir)
})

test("retention keeps 7 daily, 4 weekly and 6 monthly snapshots of Eido's own and prunes", () => {
  expect(forgetArgs()).toEqual([
    "forget",
    "--host",
    "eido",
    "--tag",
    "eido-nightly",
    "--keep-daily",
    "7",
    "--keep-weekly",
    "4",
    "--keep-monthly",
    "6",
    "--prune",
  ])
})

test("snapshots come back oldest first", () => {
  const json = JSON.stringify([
    { id: "new", time: "2026-02-02T03:15:00.123456Z", paths: ["/x"] },
    { id: "old", time: "2026-02-01T03:15:00Z" },
  ])
  expect(parseSnapshots(json).map((s) => s.id)).toEqual(["old", "new"])
})

test.each([
  ["not json", "restic snapshots did not print JSON"],
  ["{}", "restic snapshots did not print a list"],
  ["[1]", "restic snapshots listed a non-object"],
  ['[{"id":"a"}]', "a snapshot has no id or time"],
  ['[{"id":"a","time":"yesterday"}]', "a snapshot has an unreadable time"],
])("%s is rejected", (json, message) => {
  expect(() => parseSnapshots(json)).toThrow(message)
})

test("a non-zero exit becomes an error naming the command and the end of stderr", async () => {
  const run = () =>
    Promise.resolve({ code: 1, stdout: "", stderr: "line1\nwrong password\n" })
  const failure = mustRun(run, ["snapshots"], {})
  await expect(failure).rejects.toThrow(BackupError)
  await expect(failure).rejects.toThrow(
    "restic snapshots exited 1: line1 | wrong password"
  )
})
