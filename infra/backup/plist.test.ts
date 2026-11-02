import { expect, test } from "vitest"

import { LABEL, renderPlist } from "./plist.ts"
import { testConfig } from "./test-support.ts"

const config = {
  ...testConfig("/data"),
  repository: "/Volumes/Backups & More/restic",
  logDir: "/Users/o/Library/Logs/eido",
}
const input = {
  config,
  env: {},
  home: "/Users/o",
  nodePath: "/opt/node/bin/node",
  binPath: "/repo/infra/backup/bin.ts",
}

test("runs `backup run` nightly at 03:15 and logs to the Eido log directory", () => {
  const plist = renderPlist(input)
  expect(plist).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`)
  expect(plist).toContain("<key>Hour</key>\n    <integer>3</integer>")
  expect(plist).toContain("<key>Minute</key>\n    <integer>15</integer>")
  expect(plist).toContain(
    "<string>/opt/node/bin/node</string>\n    <string>--disable-warning=ExperimentalWarning</string>\n    <string>/repo/infra/backup/bin.ts</string>\n    <string>run</string>"
  )
  expect(plist).toContain(
    "<key>StandardOutPath</key>\n  <string>/Users/o/Library/Logs/eido/backup.log</string>"
  )
  expect(plist).toContain(
    "<key>StandardErrorPath</key>\n  <string>/Users/o/Library/Logs/eido/backup.log</string>"
  )
})

test("paths are XML-escaped", () => {
  expect(renderPlist(input)).toContain(
    "<string>/Volumes/Backups &amp; More/restic</string>"
  )
})

test("data-path overrides are carried over, and no passphrase variable ever is", () => {
  const plist = renderPlist({
    ...input,
    env: {
      EIDO_DATA_DIR: "/custom/core",
      RESTIC_PASSWORD: "synthetic-secret",
      RESTIC_PASSWORD_FILE: "/secret/file",
      RESTIC_PASSWORD_COMMAND: "cat /secret",
      EIDO_GATE_DATA_DIR: "",
    },
  })
  expect(plist).toContain(
    "<key>EIDO_DATA_DIR</key>\n    <string>/custom/core</string>"
  )
  expect(plist).not.toContain("EIDO_GATE_DATA_DIR")
  expect(plist).not.toMatch(/RESTIC_PASSWORD|synthetic-secret|\/secret/)
})
