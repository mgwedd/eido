import { describe, expect, test } from "vitest"

import { renderStep } from "../host/plane.ts"
import { BackupError } from "./errors.ts"
import {
  PLANE_BACKUP_INTERVAL_SECONDS,
  PLANE_BACKUP_LABEL,
  PLANE_BACKUP_PLIST,
  planeBackup,
  renderPlaneBackup,
} from "./plane.ts"

const GATE = "/Library/Application Support/Eido/gate"
const DATA = "/Library/Application Support/Eido/data"
const input = {
  repository: "/Volumes/Backups/eido-restic",
  node: "/opt/homebrew/bin/node",
}

describe("planeBackup (#782)", () => {
  test("the plan backs up both plane data directories, the control DB and the data DB", () => {
    const { config } = planeBackup(input)
    expect(config.databases.map((d) => d.path)).toEqual([
      `${DATA}/eido-data.db`,
      `${GATE}/eido-control.db`,
    ])
    expect(config.blobDir).toBe(`${DATA}/blobs`)
  })

  test("the script refuses to run on a host where the plane's data dirs do not exist", () => {
    const argvs = planeBackup(input).steps.map((s) => s.argv.join(" "))
    expect(argvs.slice(0, 3)).toEqual([
      `/bin/test -d ${DATA}`,
      `/bin/test -d ${GATE}`,
      "/bin/test -f /Library/Application Support/Eido/app/infra/backup/bin.ts",
    ])
  })

  test("the daemon is root's, runs the plane's copy of the checkout, and says it is a split host", () => {
    const { plist } = planeBackup(input)
    expect(plist).toContain(`<string>${PLANE_BACKUP_LABEL}</string>`)
    expect(plist).toMatch(/<key>UserName<\/key>\s*<string>root<\/string>/)
    expect(plist).toContain(
      "<string>/Library/Application Support/Eido/app/infra/backup/bin.ts</string>"
    )
    expect(plist).toMatch(
      /<key>EIDO_BACKUP_PLANE<\/key>\s*<string>split<\/string>/
    )
    expect(plist).toContain(
      `<key>StartInterval</key>\n  <integer>${String(PLANE_BACKUP_INTERVAL_SECONDS)}</integer>`
    )
    expect(plist).toContain(`<string>${input.repository}</string>`)
  })

  test("the passphrase file and the backup directory are root only, so neither service user can read the other's data", () => {
    const argvs = planeBackup(input).steps.map((s) => s.argv.join(" "))
    const pw = "/Library/Application Support/Eido/backup/restic-password"
    expect(argvs).toContain(`/usr/sbin/chown root:wheel ${pw}`)
    expect(argvs).toContain(`/bin/chmod 0600 ${pw}`)
    expect(argvs).toContain(
      "/bin/chmod 0700 /Library/Application Support/Eido/backup"
    )
    expect(argvs).toContain(
      "/usr/sbin/chown root:wheel /Library/Application Support/Eido/backup"
    )
  })

  test("the plist is installed root:wheel 0644 and linted", () => {
    const argvs = planeBackup(input).steps.map((s) => s.argv.join(" "))
    expect(argvs.slice(-4)).toEqual([
      `/usr/bin/tee ${PLANE_BACKUP_PLIST}`,
      `/usr/sbin/chown root:wheel ${PLANE_BACKUP_PLIST}`,
      `/bin/chmod 0644 ${PLANE_BACKUP_PLIST}`,
      `/usr/bin/plutil -lint ${PLANE_BACKUP_PLIST}`,
    ])
  })

  test("a relative node path is refused", () => {
    expect(() => planeBackup({ ...input, node: "node" })).toThrow(BackupError)
  })

  test("the rendered script stops on error and carries the plist on stdin, not a secret", () => {
    const text = renderPlaneBackup(planeBackup(input))
    expect(text.startsWith("#!/bin/sh\n")).toBe(true)
    expect(text).toContain("\nset -eu\n")
    const tee = planeBackup(input).steps.find(
      (s) => s.argv[0] === "/usr/bin/tee"
    )
    expect(tee).toBeDefined()
    expect(text).toContain(renderStep(tee!))
    // The passphrase is copied by the owner from the Keychain; the script never holds it.
    expect(text).not.toMatch(/RESTIC_PASSWORD=/)
  })

  test("the owner steps name the passphrase copy, the daemon load and the old LaunchAgent to retire", () => {
    const text = renderPlaneBackup(planeBackup(input))
    expect(text).toContain("# 1. The passphrase.")
    expect(text).toContain(
      "security find-generic-password -s eido-backup -a restic -w | sudo tee '/Library/Application Support/Eido/backup/restic-password' >/dev/null"
    )
    expect(text).toContain(
      `sudo launchctl bootstrap system ${PLANE_BACKUP_PLIST}`
    )
    expect(text).toContain("launchctl bootout gui/$(id -u)/com.eido.backup")
  })
})
