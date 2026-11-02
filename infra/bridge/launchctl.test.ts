import { describe, expect, it } from "vitest"

import {
  bootoutArgs,
  bootstrapArgs,
  parsePrint,
  printArgs,
} from "./launchctl.ts"

describe("launchctl arguments", () => {
  it("bootstraps into the user's GUI domain", () => {
    expect(bootstrapArgs(501, "/p.plist")).toEqual([
      "bootstrap",
      "gui/501",
      "/p.plist",
    ])
  })
  it("boots out and prints the labelled job", () => {
    expect(bootoutArgs(501)).toEqual([
      "bootout",
      "gui/501/com.eido.proton-bridge",
    ])
    expect(printArgs(501)).toEqual(["print", "gui/501/com.eido.proton-bridge"])
  })
})

describe("parsePrint", () => {
  const running = `gui/501/com.eido.proton-bridge = {
\tactive count = 1
\tstate = running
\truns = 3
\tpid = 4242
\tlast exit code = 9
}`
  it("reads state, pid, runs and last exit", () => {
    expect(parsePrint(running)).toEqual({
      state: "running",
      pid: 4242,
      runs: 3,
      lastExitStatus: "9",
    })
  })
  it("leaves absent fields undefined", () => {
    expect(parsePrint("\tstate = waiting\n")).toEqual({
      state: "waiting",
      pid: undefined,
      runs: undefined,
      lastExitStatus: undefined,
    })
  })
})
