import { describe, expect, test } from "vitest"

import { buildBackupConfig } from "./config.ts"

const base = { home: "/Users/o", repoRoot: "/repo" }
const repo = { EIDO_BACKUP_REPO: "/Volumes/Backups/eido-restic" }

describe.skipIf(process.platform === "win32")("backup config", () => {
  test("defaults follow the stack's data directories", () => {
    const config = buildBackupConfig({ ...base, env: repo })
    const stack = "/Users/o/Library/Application Support/eido-dev"
    expect(config).toEqual({
      databases: [
        {
          name: "eido-data.db",
          path: `${stack}/core/eido-data.db`,
          staged: `${stack}/backup-staging/eido-data.db`,
        },
        {
          name: "eido-control.db",
          path: `${stack}/gate/eido-control.db`,
          staged: `${stack}/backup-staging/eido-control.db`,
        },
      ],
      blobDir: `${stack}/core/blobs`,
      stagingDir: `${stack}/backup-staging`,
      repository: "/Volumes/Backups/eido-restic",
      logDir: "/Users/o/Library/Logs/eido",
      stampFile: "/Users/o/Library/Logs/eido/backup-last-success",
    })
  })

  test("moving the stack's data directories moves the backup's sources", () => {
    const config = buildBackupConfig({
      ...base,
      env: { ...repo, EIDO_DATA_DIR: "/d/core", EIDO_GATE_DATA_DIR: "/d/gate" },
    })
    expect(config.databases.map((d) => d.path)).toEqual([
      "/d/core/eido-data.db",
      "/d/gate/eido-control.db",
    ])
    expect(config.blobDir).toBe("/d/core/blobs")
  })

  test("EIDO_BACKUP_LOG_DIR moves the log and the stamp", () => {
    const config = buildBackupConfig({
      ...base,
      env: { ...repo, EIDO_BACKUP_LOG_DIR: "/l" },
    })
    expect(config.logDir).toBe("/l")
    expect(config.stampFile).toBe("/l/backup-last-success")
  })

  test("the repository is required and must be a local absolute path", () => {
    expect(() => buildBackupConfig({ ...base, env: {} })).toThrow(
      "EIDO_BACKUP_REPO must name"
    )
    expect(() =>
      buildBackupConfig({ ...base, env: { EIDO_BACKUP_REPO: "" } })
    ).toThrow("EIDO_BACKUP_REPO must name")
    expect(() =>
      buildBackupConfig({ ...base, env: { EIDO_BACKUP_REPO: "s3:bucket/x" } })
    ).toThrow(
      'EIDO_BACKUP_REPO must be an absolute local path, not "s3:bucket/x"'
    )
  })
})
