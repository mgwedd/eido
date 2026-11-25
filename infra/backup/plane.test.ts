import { spawnSync } from "node:child_process"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

import { BackupError } from "./errors.ts"
import {
  PLANE_BACKUP_LABEL,
  PLANE_BACKUP_PLIST,
  planeBackup,
  renderPlaneBackup,
} from "./plane.ts"
import { tempDir } from "./test-support.ts"

const GATE = "/Library/Application Support/Eido/gate"
const DATA = "/Library/Application Support/Eido/data"
const input = {
  repository: "/Volumes/Backups/eido-restic",
  node: "/Library/Application Support/Eido/bin/node",
  restic: "/Library/Application Support/Eido/bin/restic",
}

/** The plist's environment keys, read out of the XML. */
function envKeys(plist: string): string[] {
  const dict =
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)
  expect(dict).not.toBeNull()
  return [...(dict?.[1] ?? "").matchAll(/<key>([^<]+)<\/key>/g)].map(
    (m) => m[1] ?? ""
  )
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
    expect(plist).toMatch(
      /<array>\s*<string>\/Library\/Application Support\/Eido\/bin\/node<\/string>\s*<string>--disable-warning=ExperimentalWarning<\/string>\s*<string>\/Library\/Application Support\/Eido\/app\/infra\/backup\/bin\.ts<\/string>\s*<string>run<\/string>\s*<\/array>/
    )
    expect(plist).toMatch(
      /<key>EIDO_BACKUP_PLANE<\/key>\s*<string>split<\/string>/
    )
    expect(plist).toContain(`<string>${input.repository}</string>`)
  })

  test("the daemon runs once a day at 03:15, not at load and not on an interval that every boot restarts", () => {
    const { plist } = planeBackup(input)
    expect(plist).toContain(
      "<key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>3</integer>\n    <key>Minute</key>\n    <integer>15</integer>\n  </dict>"
    )
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/)
    expect(plist).not.toContain("StartInterval")
  })

  test("the daemon's PATH is the system's alone and restic is named by its absolute path", () => {
    const { plist } = planeBackup(input)
    expect(plist).toMatch(
      /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/
    )
    expect(plist).toMatch(
      /<key>EIDO_RESTIC_BIN<\/key>\s*<string>\/Library\/Application Support\/Eido\/bin\/restic<\/string>/
    )
  })

  test("the passphrase never reaches the plist's environment, a command line or the script's code", () => {
    const plan = planeBackup(input)
    // The plist carries only these variables: a passphrase under any name would add a key.
    expect(envKeys(plan.plist).sort()).toEqual([
      "EIDO_BACKUP_PLANE",
      "EIDO_BACKUP_REPO",
      "EIDO_RESTIC_BIN",
      "HOME",
      "PATH",
    ])
    // In the script, only comment lines (the owner's copy from the Keychain) mention it, and the
    // code names the passphrase file's path and nothing else about a passphrase.
    const code = renderPlaneBackup(plan)
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .replaceAll(
        "/Library/Application Support/Eido/backup/restic-password",
        "<file>"
      )
    expect(code).not.toMatch(/passw|passphrase|keychain|\bsecurity\b/i)
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

  test("the rendered script stops on error and writes the plist from a quoted heredoc", () => {
    const text = renderPlaneBackup(planeBackup(input))
    expect(text.startsWith("#!/bin/sh\n")).toBe(true)
    expect(text).toContain("\nset -eu\n")
    expect(text).toContain(
      `/usr/bin/tee ${PLANE_BACKUP_PLIST} >/dev/null <<'EIDO_EOF'\n<?xml version="1.0" encoding="UTF-8"?>\n`
    )
    expect(text).toContain("</plist>\nEIDO_EOF\n")
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
    expect(text).toContain(
      `sudo launchctl kickstart system/${PLANE_BACKUP_LABEL}`
    )
    expect(text).toContain("launchctl bootout gui/$(id -u)/com.eido.backup")
  })
})

describe("what the root daemon may run (#782, S1)", () => {
  test.each([
    ["node", { node: "/Users/me/.nvm/bin/node" }],
    ["restic", { restic: "/Users/me/bin/restic" }],
  ])("a %s inside /Users is refused", (_what, override) => {
    expect(() => planeBackup({ ...input, ...override })).toThrow(
      /inside a home the owner can write/
    )
  })

  test.each([
    ["node", { node: "node" }],
    ["restic", { restic: "restic" }],
    ["repository", { repository: "drive/restic" }],
  ])("a relative %s is refused", (_what, override) => {
    expect(() => planeBackup({ ...input, ...override })).toThrow(BackupError)
  })

  test("the script stops unless node and restic are executable and root-owned", () => {
    const steps = planeBackup(input).steps
    const checks = steps.filter((s) => s.argv[0] === "/bin/sh")
    expect(checks.map((s) => s.argv.slice(3))).toEqual([
      ["sh", input.node],
      ["sh", input.restic],
    ])
    expect(checks[0]?.argv[2]).toBe(
      'for p in "$1" "${1%/*}"; do [ "$(/usr/bin/stat -f %u "$p")" = 0 ] && [ -z "$(/usr/bin/find "$p" -maxdepth 0 \\( -perm -g+w -o -perm -o+w \\))" ] || { echo "$p must be owned by root and not writable by group or others (infra/backup-restore.md)" >&2; exit 1; }; done'
    )
    const argvs = steps.map((s) => s.argv.join(" "))
    expect(argvs).toContain(`/bin/test -x ${input.node}`)
    expect(argvs).toContain(`/bin/test -x ${input.restic}`)
  })

  // The check runs under /bin/sh with BSD stat and find, as on the host.
  describe.skipIf(process.platform !== "darwin")(
    "the root-owned check, run",
    () => {
      const check = (path: string) => {
        const step = planeBackup({ ...input, node: path }).steps.find(
          (s) => s.argv[0] === "/bin/sh"
        )
        expect(step).toBeDefined()
        const [cmd, ...args] = step?.argv ?? []
        return spawnSync(cmd ?? "", args, { encoding: "utf8" })
      }

      test("passes for a binary root owns in a directory root owns", () => {
        expect(check("/bin/sh").status).toBe(0)
      })

      test("fails, naming the file, for a binary the owner owns", () => {
        const path = join(tempDir(), "node")
        writeFileSync(path, "")
        chmodSync(path, 0o755)
        const result = check(path)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain(`${path} must be owned by root`)
      })
    }
  )
})

describe("values that reach the script (#782, S3)", () => {
  test.each([
    ["a newline", "/Volumes/B/eido\nrm -rf /"],
    ["a carriage return", "/Volumes/B/eido\rx"],
    ["a NUL", "/Volumes/B/eido\u0000x"],
    ["an escape", "/Volumes/B/eido\u001bx"],
    ["a DEL", "/Volumes/B/eido\u007fx"],
  ])("a repository with %s is refused", (_what, repository) => {
    expect(() => planeBackup({ ...input, repository })).toThrow(
      /control character/
    )
  })

  test.each(["node", "restic"] as const)(
    "a %s path with a newline is refused",
    (key) => {
      expect(() =>
        planeBackup({ ...input, [key]: "/opt/x\ntouch /pwned" })
      ).toThrow(/control character/)
    }
  )

  test("an ordinary path with spaces and quotes is quoted in the script, so it is one word", () => {
    const repository = "/Volumes/My Backups/it's"
    const text = renderPlaneBackup(planeBackup({ ...input, repository }))
    expect(text).toContain("restic init on '/Volumes/My Backups/it'\\''s' once")
  })
})
