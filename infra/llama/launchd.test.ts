import { describe, expect, it } from "vitest"

import {
  bootoutArgs,
  bootstrapArgs,
  buildPlist,
  escapeXml,
  layout,
  parsePrint,
  printArgs,
} from "./launchd.ts"

describe("layout", () => {
  it("puts the plist in LaunchAgents and the logs under Logs/eido", () => {
    expect(layout("/Users/u")).toEqual({
      plistPath: "/Users/u/Library/LaunchAgents/com.eido.llama-server.plist",
      logDir: "/Users/u/Library/Logs/eido",
      outLog: "/Users/u/Library/Logs/eido/llama-server.out.log",
      errLog: "/Users/u/Library/Logs/eido/llama-server.err.log",
    })
  })
})

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f")
  })
})

describe("buildPlist", () => {
  const plist = buildPlist({
    home: "/Users/u",
    node: "/opt/node",
    launcher: "/repo/infra/llama/bin.ts",
    env: {
      EIDO_MODEL_DIR: "/Users/u/Library/Application Support/eido-dev/models",
      B_A: "x&y",
    },
  })

  it("runs the launcher's launch command, so every start re-verifies the pin", () => {
    expect(plist).toContain(
      "<key>ProgramArguments</key>\n  <array>\n    <string>/opt/node</string>\n    <string>--disable-warning=ExperimentalWarning</string>\n    <string>/repo/infra/llama/bin.ts</string>\n    <string>launch</string>\n  </array>"
    )
  })

  it("restarts on exit with a throttle, and starts at load", () => {
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain(
      "<key>ThrottleInterval</key>\n  <integer>10</integer>"
    )
    expect(plist).not.toContain("AbandonProcessGroup")
  })

  it("writes the env sorted and escaped, and the log paths", () => {
    expect(plist).toContain(
      "<key>B_A</key>\n    <string>x&amp;y</string>\n    <key>EIDO_MODEL_DIR</key>\n    <string>/Users/u/Library/Application Support/eido-dev/models</string>"
    )
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n  <string>/Users/u/Library/Logs/eido/llama-server.err.log</string>"
    )
  })
})

describe("launchctl arguments", () => {
  it("targets the user's gui domain", () => {
    expect(bootstrapArgs(501, "/p.plist")).toEqual([
      "bootstrap",
      "gui/501",
      "/p.plist",
    ])
    expect(bootoutArgs(501)).toEqual([
      "bootout",
      "gui/501/com.eido.llama-server",
    ])
    expect(printArgs(501)).toEqual(["print", "gui/501/com.eido.llama-server"])
  })
})

describe("parsePrint", () => {
  it("reads state, pid, runs and last exit code", () => {
    const output = `gui/501/com.eido.llama-server = {
\tactive count = 1
\tpath = /Users/u/Library/LaunchAgents/com.eido.llama-server.plist
\ttype = LaunchAgent
\tstate = running
\tprogram = /opt/node
\truns = 3
\tpid = 4242
\tlast exit code = 1
}`
    expect(parsePrint(output)).toEqual({
      state: "running",
      pid: 4242,
      runs: 3,
      lastExit: "1",
    })
  })

  it("leaves missing fields undefined", () => {
    expect(parsePrint("state = not running\n")).toEqual({
      state: "not running",
      pid: undefined,
      runs: undefined,
      lastExit: undefined,
    })
  })
})
