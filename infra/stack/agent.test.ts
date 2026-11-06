import { describe, expect, it } from "vitest"

import {
  agentBootoutArgs,
  agentBootstrapArgs,
  agentEnv,
  agentLayout,
  agentPrintArgs,
  agentState,
  buildAgentPlist,
} from "./agent.ts"

describe("agentLayout", () => {
  it("puts the plist in LaunchAgents and the logs under Logs/eido-dev", () => {
    expect(agentLayout("/Users/u")).toEqual({
      plistPath: "/Users/u/Library/LaunchAgents/com.eido.stack.plist",
      logDir: "/Users/u/Library/Logs/eido-dev",
      outLog: "/Users/u/Library/Logs/eido-dev/stack.out.log",
      errLog: "/Users/u/Library/Logs/eido-dev/stack.err.log",
    })
  })
})

describe("agentEnv", () => {
  it("passes on PATH and EIDO_STACK_DIR only, and drops empty values", () => {
    expect(
      agentEnv({
        PATH: "/usr/bin",
        EIDO_STACK_DIR: "",
        AUTH0_CLIENT_SECRET: "never-in-a-plist",
      })
    ).toEqual({ PATH: "/usr/bin" })
  })
})

describe("buildAgentPlist", () => {
  const plist = buildAgentPlist({
    home: "/Users/u",
    node: "/opt/node",
    repoRoot: "/Users/u/dev/e&o",
    env: { PATH: "/usr/bin" },
  })

  it("runs the supervisor with --start-stack through the TypeScript hooks", () => {
    expect(plist).toContain(
      "<key>ProgramArguments</key>\n  <array>\n    <string>/opt/node</string>\n    <string>--disable-warning=ExperimentalWarning</string>\n    <string>--import</string>\n    <string>/Users/u/dev/e&amp;o/infra/ts-hooks.ts</string>\n    <string>/Users/u/dev/e&amp;o/infra/stack/supervisor-main.ts</string>\n    <string>--start-stack</string>\n  </array>\n  <key>WorkingDirectory</key>\n  <string>/Users/u/dev/e&amp;o/infra</string>"
    )
  })

  it("starts at load and restarts with a throttle, logging under Logs/eido-dev", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>"
    )
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n  <string>/Users/u/Library/Logs/eido-dev/stack.out.log</string>"
    )
  })
})

describe("launchctl arguments", () => {
  it("targets the user's gui domain", () => {
    expect(agentBootstrapArgs(501, "/p.plist")).toEqual([
      "bootstrap",
      "gui/501",
      "/p.plist",
    ])
    expect(agentBootoutArgs(501)).toEqual(["bootout", "gui/501/com.eido.stack"])
    expect(agentPrintArgs(501)).toEqual(["print", "gui/501/com.eido.stack"])
  })
})

describe("agentState", () => {
  it("is not installed when print fails and there is no plist", () => {
    expect(agentState({ code: 113, stdout: "" }, false)).toEqual({
      kind: "not installed",
    })
  })
})
