import { describe, expect, it } from "vitest"

import { buildPlist, escapeXml, layout, programArguments } from "./plist.ts"

const home = "/Users/example"

describe("buildPlist", () => {
  const plist = buildPlist({ bridgePath: "/opt/Bridge & Co/bridge", home })

  it("runs Bridge in CLI mode without an interactive prompt, path escaped", () => {
    expect(plist).toContain(
      "<string>/opt/Bridge &amp; Co/bridge</string>\n    <string>--cli</string>\n    <string>--noninteractive</string>"
    )
  })

  it("supervises with KeepAlive, a throttle and a non-Background process type", () => {
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>")
    expect(plist).toContain(
      "<key>ThrottleInterval</key>\n  <integer>10</integer>"
    )
    expect(plist).toContain(
      "<key>ProcessType</key>\n  <string>Standard</string>"
    )
    expect(plist).not.toContain("Background")
  })

  it("logs to absolute paths under ~/Library/Logs/eido", () => {
    expect(plist).toContain(
      `<string>${home}/Library/Logs/eido/proton-bridge.out.log</string>`
    )
    expect(plist).toContain(
      `<string>${home}/Library/Logs/eido/proton-bridge.err.log</string>`
    )
  })

  it("labels the job in the com.eido namespace", () => {
    expect(plist).toContain("<string>com.eido.proton-bridge</string>")
  })

  it("carries no port, password or environment", () => {
    expect(plist).not.toMatch(
      /pass|secret|token|EnvironmentVariables|\b1143\b|\b1025\b/i
    )
  })
})

describe("helpers", () => {
  it("escapes the five XML specials", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;"
    )
  })

  it("places the plist in the user's LaunchAgents", () => {
    expect(layout(home).plistPath).toBe(
      "/Users/example/Library/LaunchAgents/com.eido.proton-bridge.plist"
    )
  })

  it("lists Bridge first in the arguments", () => {
    expect(programArguments("/b")[0]).toBe("/b")
  })
})
