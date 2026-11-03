import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateGateBackupStatus } from "@eido/schemas"
import {
  defaultBackupStampPath,
  MAX_SNAPSHOT_AGE_HOURS,
  readBackupStatus,
} from "./backup-status"

describe("backup-status", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `eido-backup-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("defaultBackupStampPath", () => {
    it("uses EIDO_BACKUP_STAMP_FILE when set", () => {
      const explicit = "/custom/path/to/stamp"
      expect(
        defaultBackupStampPath({
          EIDO_BACKUP_STAMP_FILE: explicit,
          EIDO_BACKUP_LOG_DIR: "/logs",
        })
      ).toBe(explicit)
    })

    it("uses EIDO_BACKUP_LOG_DIR when set and stamp file override is unset", () => {
      expect(
        defaultBackupStampPath({
          EIDO_BACKUP_LOG_DIR: "/custom/logs",
        })
      ).toBe("/custom/logs/backup-last-success")
    })

    it("falls back to default Library/Logs/eido/backup-last-success when env is empty", () => {
      const path = defaultBackupStampPath({})
      expect(path).toMatch(/\/Library\/Logs\/eido\/backup-last-success$/)
    })
  })

  describe("readBackupStatus", () => {
    const NOW = new Date("2030-01-05T12:00:00.000Z")
    const clock = () => NOW

    it("returns never_run when stampPath is undefined", () => {
      const status = readBackupStatus(undefined, clock)
      expect(status).toEqual({ status: "never_run", lastSuccess: null })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })

    it("returns never_run when stamp file does not exist", () => {
      const stampPath = join(tempDir, "nonexistent-stamp")
      const status = readBackupStatus(stampPath, clock)
      expect(status).toEqual({ status: "never_run", lastSuccess: null })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })

    it("returns never_run when stamp file is empty or blank", () => {
      const stampPath = join(tempDir, "empty-stamp")
      writeFileSync(stampPath, "  \n  ")
      const status = readBackupStatus(stampPath, clock)
      expect(status).toEqual({ status: "never_run", lastSuccess: null })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })

    it("returns never_run when stamp file holds invalid date", () => {
      const stampPath = join(tempDir, "corrupted-stamp")
      writeFileSync(stampPath, "not-a-valid-timestamp\n")
      const status = readBackupStatus(stampPath, clock)
      expect(status).toEqual({ status: "never_run", lastSuccess: null })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })

    it("returns fresh when snapshot is within 36 hours", () => {
      const stampPath = join(tempDir, "fresh-stamp")
      // 2 hours before NOW
      const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600 * 1000)
      writeFileSync(stampPath, `${twoHoursAgo.toISOString()}\n`)

      const status = readBackupStatus(stampPath, clock)
      expect(status).toEqual({
        status: "fresh",
        lastSuccess: twoHoursAgo.toISOString(),
      })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })

    it("returns fresh when snapshot is exactly at 36 hours boundary", () => {
      const stampPath = join(tempDir, "boundary-stamp")
      const exactly36HoursAgo = new Date(
        NOW.getTime() - MAX_SNAPSHOT_AGE_HOURS * 3600 * 1000
      )
      writeFileSync(stampPath, `${exactly36HoursAgo.toISOString()}\n`)

      const status = readBackupStatus(stampPath, clock)
      expect(status).toEqual({
        status: "fresh",
        lastSuccess: exactly36HoursAgo.toISOString(),
      })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })

    it("returns stale when snapshot is older than 36 hours", () => {
      const stampPath = join(tempDir, "stale-stamp")
      // 36.5 hours before NOW
      const staleTime = new Date(NOW.getTime() - 36.5 * 3600 * 1000)
      writeFileSync(stampPath, `${staleTime.toISOString()}\n`)

      const status = readBackupStatus(stampPath, clock)
      expect(status).toEqual({
        status: "stale",
        lastSuccess: staleTime.toISOString(),
      })
      expect(validateGateBackupStatus(status).ok).toBe(true)
    })
  })
})
