import { describe, expect, test } from "vitest"

import { planeLayout } from "../host/plane.ts"
import {
  PLANE_BACKUP_DIR,
  PLANE_DATA_DIR,
  PLANE_GATE_DIR,
  buildBackupConfig,
} from "./config.ts"

const base = { home: "/Users/o", repoRoot: "/repo" }
const repo = { EIDO_BACKUP_REPO: "/Volumes/Backups/eido-restic" }

describe.skipIf(process.platform === "win32")("backup config", () => {
  test("defaults follow the stack's data directories", () => {
    const config = buildBackupConfig({ ...base, env: repo })
    const stack = "/Users/o/Library/Application Support/eido-dev"
    expect(config).toEqual({
      plane: "single",
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

  describe("EIDO_BACKUP_PLANE=split (#782)", () => {
    const split = { ...repo, EIDO_BACKUP_PLANE: "split" }

    test("backs up the plane's gate and data directories, not the owner's stack dir", () => {
      const config = buildBackupConfig({ ...base, env: split })
      const plane = "/Library/Application Support/Eido"
      expect(config).toEqual({
        plane: "split",
        databases: [
          {
            name: "eido-data.db",
            path: `${plane}/data/eido-data.db`,
            staged: `${plane}/backup/staging/eido-data.db`,
          },
          {
            name: "eido-control.db",
            path: `${plane}/gate/eido-control.db`,
            staged: `${plane}/backup/staging/eido-control.db`,
          },
        ],
        blobDir: `${plane}/data/blobs`,
        stagingDir: `${plane}/backup/staging`,
        repository: "/Volumes/Backups/eido-restic",
        logDir: "/Library/Logs/Eido/backup",
        stampFile: "/Library/Logs/Eido/backup-last-success",
        passwordFile: `${plane}/backup/restic-password`,
      })
    })

    test("the data paths are the plane layout's, so a moved plane moves the backup", () => {
      const layout = planeLayout({
        owner: "o",
        ownerHome: "/Users/o",
        firstId: 451,
        env: {},
      })
      expect(PLANE_GATE_DIR).toBe(layout.gateDir)
      expect(PLANE_DATA_DIR).toBe(layout.dataDir)
      expect(PLANE_BACKUP_DIR.startsWith(`${layout.root}/`)).toBe(true)
    })

    test("the owner's stack paths and log dir do not leak into the root daemon's config", () => {
      const config = buildBackupConfig({
        ...base,
        env: {
          ...split,
          EIDO_DATA_DIR: "/d/core",
          EIDO_GATE_DATA_DIR: "/d/gate",
          EIDO_BACKUP_LOG_DIR: "/l",
        },
      })
      expect(config.databases.map((d) => d.path)).toEqual([
        `${PLANE_DATA_DIR}/eido-data.db`,
        `${PLANE_GATE_DIR}/eido-control.db`,
      ])
      expect(config.logDir).toBe("/Library/Logs/Eido/backup")
    })

    test("the repository is still required", () => {
      expect(() =>
        buildBackupConfig({ ...base, env: { EIDO_BACKUP_PLANE: "split" } })
      ).toThrow("EIDO_BACKUP_REPO must name")
    })
  })

  test("EIDO_BACKUP_PLANE accepts single and unset, and refuses anything else", () => {
    expect(
      buildBackupConfig({
        ...base,
        env: { ...repo, EIDO_BACKUP_PLANE: "single" },
      }).plane
    ).toBe("single")
    expect(() =>
      buildBackupConfig({
        ...base,
        env: { ...repo, EIDO_BACKUP_PLANE: "splt" },
      })
    ).toThrow('EIDO_BACKUP_PLANE must be "single" or "split", not "splt"')
  })
})
