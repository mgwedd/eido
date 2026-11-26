import { describe, expect, it } from "vitest"

import {
  applySteps,
  bridgeSocketAces,
  planeLayout,
  planeServices,
  removeSteps,
  type PlaneInput,
  type Step,
} from "./plane.ts"
import {
  bridgeAces,
  bridgePlist,
  bridgeProgramArguments,
  checkBridge,
  withoutAces,
  type BridgeInput,
} from "./session-bridge.ts"

const HOME = "/Users/owner"
const layout = planeLayout({
  owner: "owner",
  ownerHome: HOME,
  firstId: 451,
  env: {},
})
const paths = layout.bridge

const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const bridge: BridgeInput = {
  ownerUid: 501,
  helper: "/Users/owner/dev/eido/apps/helper/.build/release/eido-helper",
  fileHelper: "/Users/owner/.eido/file-helper/current/eido-file-helper",
  fileHelperSha256: SHA,
  fileRoots: "/Users/owner/Library/Application Support/eido-dev/file-roots.txt",
}

const input = (over: Partial<PlaneInput> = {}): PlaneInput => ({
  layout,
  checkout: "/Users/owner/dev/eido",
  node: "/opt/homebrew/bin/node",
  tailnetHost: "mac.example.ts.net",
  settings: {},
  allowlist: { hosts: ["api.example.com"], local: [] },
  bridge,
  ...over,
})

const line = (step: Step) => step.argv.join(" ")
const RUN_DIR = "/Users/owner/Library/Application Support/eido-dev/run"
const SOCKET_DIR = `${RUN_DIR}/session-bridge`
const ROOT = "/Library/Application Support/Eido"

describe("the bridge's paths", () => {
  it("keeps the helpers in a root-owned dir outside the app copy and the socket under the owner's run dir", () => {
    expect(paths).toEqual({
      dir: `${ROOT}/bridge`,
      helper: `${ROOT}/bridge/eido-helper`,
      fileHelper: `${ROOT}/bridge/eido-file-helper`,
      thingsScripts: `${ROOT}/app/packages/gate/src/internal/things/scripts`,
      socketDir: SOCKET_DIR,
      socket: `${SOCKET_DIR}/bridge.sock`,
      plistDir: "/Users/owner/Library/LaunchAgents",
      plist: "/Users/owner/Library/LaunchAgents/com.eido.plane.bridge.plist",
      logDir: "/Users/owner/Library/Logs/eido-dev",
      outLog: "/Users/owner/Library/Logs/eido-dev/bridge.out.log",
      errLog: "/Users/owner/Library/Logs/eido-dev/bridge.err.log",
    })
  })
})

describe("the bridge agent's plist", () => {
  const plist = bridgePlist(paths, bridge, "_eidogate")

  it("runs in the owner's graphical session, as the owner, and starts at login", () => {
    expect(plist).toContain(
      "  <key>LimitLoadToSessionType</key>\n  <string>Aqua</string>\n"
    )
    expect(plist).toContain("  <key>RunAtLoad</key>\n  <true/>\n")
    expect(plist).toContain("  <key>KeepAlive</key>\n  <true/>\n")
    expect(plist).not.toContain("<key>UserName</key>")
    expect(plist).not.toContain("<key>GroupName</key>")
  })

  it("runs the root-owned helper with the bridge flags, the gate user as the only peer and the owner's roots list", () => {
    expect(bridgeProgramArguments(paths, bridge, "_eidogate")).toEqual([
      `${ROOT}/bridge/eido-helper`,
      "--bridge",
      "--socket",
      `${SOCKET_DIR}/bridge.sock`,
      "--peer-user",
      "_eidogate",
      "--things-scripts",
      `${ROOT}/app/packages/gate/src/internal/things/scripts`,
      "--file-helper",
      `${ROOT}/bridge/eido-file-helper`,
      "--file-helper-sha256",
      SHA,
      "--file-roots",
      "/Users/owner/Library/Application Support/eido-dev/file-roots.txt",
    ])
    expect(plist).toContain(
      "  <array>\n    <string>/Library/Application Support/Eido/bridge/eido-helper</string>\n    <string>--bridge</string>\n"
    )
    expect(plist).toContain(
      "    <string>--peer-user</string>\n    <string>_eidogate</string>\n"
    )
  })

  it("passes no secret: the environment holds PATH only", () => {
    const env = plist.slice(
      plist.indexOf("<key>EnvironmentVariables</key>"),
      plist.indexOf("<key>RunAtLoad</key>")
    )
    expect(env).toBe(
      "<key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>\n  </dict>\n  "
    )
  })

  it("writes its logs to the owner's private log dir", () => {
    expect(plist).toContain(
      "  <key>StandardOutPath</key>\n  <string>/Users/owner/Library/Logs/eido-dev/bridge.out.log</string>\n"
    )
    expect(plist).toContain(
      "  <key>StandardErrorPath</key>\n  <string>/Users/owner/Library/Logs/eido-dev/bridge.err.log</string>\n"
    )
  })

  it("does not pass --file-helper-copy-dir, leaving the helper's per-user default", () => {
    expect(plist).not.toContain("file-helper-copy-dir")
  })
})

describe("the socket directory's ACL", () => {
  const aces = bridgeAces(paths, "_eidogate", [
    HOME,
    "/Users/owner/Library",
    RUN_DIR,
  ])

  it("lets the gate user search down to the socket dir and inherit access on new files there only", () => {
    expect(aces.map(({ path, ace }) => `${ace} @ ${path}`)).toEqual([
      `_eidogate allow search @ ${HOME}`,
      "_eidogate allow search @ /Users/owner/Library",
      `_eidogate allow search @ ${RUN_DIR}`,
      `_eidogate allow search @ ${SOCKET_DIR}`,
      `_eidogate allow read,write,file_inherit,only_inherit @ ${SOCKET_DIR}`,
    ])
  })

  it("grants nobody but the gate user, and never write on a directory itself", () => {
    expect(aces.every(({ ace }) => ace.startsWith("_eidogate allow "))).toBe(
      true
    )
    const writing = aces.filter(({ ace }) => ace.includes("write"))
    expect(writing.every(({ ace }) => ace.includes("only_inherit"))).toBe(true)
    expect(writing.map(({ path }) => path)).toEqual([SOCKET_DIR])
  })

  it("leaves out the entries the supervisor's ACL already holds, and keeps the rest", () => {
    expect(
      bridgeSocketAces(layout).map(({ path, ace }) => `${ace} @ ${path}`)
    ).toEqual([
      `_eidogate allow search @ ${SOCKET_DIR}`,
      `_eidogate allow read,write,file_inherit,only_inherit @ ${SOCKET_DIR}`,
    ])
  })

  it("withoutAces drops an entry only when path and entry both match", () => {
    const held = [{ path: "/a", ace: "x allow search" }]
    expect(
      withoutAces(
        [
          { path: "/a", ace: "x allow search" },
          { path: "/b", ace: "x allow search" },
          { path: "/a", ace: "x allow read" },
        ],
        held
      )
    ).toEqual([
      { path: "/b", ace: "x allow search" },
      { path: "/a", ace: "x allow read" },
    ])
  })
})

describe("the gate daemon's environment", () => {
  it("names the bridge's socket and the owner's uid together", () => {
    const { env } = planeServices(input()).gate
    expect(env["EIDO_SESSION_BRIDGE_SOCKET"]).toBe(`${SOCKET_DIR}/bridge.sock`)
    expect(env["EIDO_SESSION_BRIDGE_UID"]).toBe("501")
  })

  it("is the same socket path the agent listens on", () => {
    const { env } = planeServices(input()).gate
    const args = bridgeProgramArguments(paths, bridge, "_eidogate")
    expect(env["EIDO_SESSION_BRIDGE_SOCKET"]).toBe(
      args[args.indexOf("--socket") + 1]
    )
  })

  it("carries neither variable when no bridge is planned", () => {
    const { env } = planeServices(input({ bridge: undefined })).gate
    expect(Object.keys(env).filter((key) => key.includes("BRIDGE"))).toEqual([])
  })
})

describe("applySteps with the bridge", () => {
  const steps = applySteps(input())
  const all = steps.map(line)
  const at = (text: string) => {
    const found = all.indexOf(text)
    expect(found, text).toBeGreaterThanOrEqual(0)
    return found
  }

  it("creates the socket dir as the owner at 0700 after checking the run dir exists, before any entry names it", () => {
    const create = at(`/usr/bin/install -d -o owner -m 0700 ${SOCKET_DIR}`)
    expect(at(`/bin/test -d ${RUN_DIR}`)).toBeLessThan(create)
    expect(create).toBeLessThan(
      at(`/bin/chmod +a _eidogate allow search ${SOCKET_DIR}`)
    )
    expect(create).toBeLessThan(
      at(
        `/bin/chmod +a _eidogate allow read,write,file_inherit,only_inherit ${SOCKET_DIR}`
      )
    )
  })

  it("grants each ACL entry once, so a second run does not stack entries", () => {
    const grants = all.filter((text) => text.startsWith("/bin/chmod +a"))
    expect(new Set(grants).size).toBe(grants.length)
  })

  it("names only the gate user in every entry it adds", () => {
    const grants = all.filter((text) => text.startsWith("/bin/chmod +a"))
    expect(
      grants.filter(
        (text) =>
          /_eido(data|parse|ipc)/.test(text) && text.includes(SOCKET_DIR)
      )
    ).toEqual([])
  })

  it("copies the helpers into the root-owned dir as real files, replacing anything already there", () => {
    const dest = `${ROOT}/bridge/eido-file-helper`
    expect(at(`/bin/rm -f ${dest}`)).toBeLessThan(
      at(
        `/usr/bin/install -o root -g wheel -m 0755 ${bridge.fileHelper} ${dest}`
      )
    )
    expect(
      at(`/usr/bin/install -d -o root -g wheel -m 0755 ${ROOT}/bridge`)
    ).toBeLessThan(
      at(
        `/usr/bin/install -o root -g wheel -m 0755 ${bridge.helper} ${ROOT}/bridge/eido-helper`
      )
    )
    // A symlink source (the `current` link) is copied by content, and the agent is given the copy.
    expect(
      bridgeProgramArguments(paths, bridge, "_eidogate")[
        bridgeProgramArguments(paths, bridge, "_eidogate").indexOf(
          "--file-helper"
        ) + 1
      ]
    ).toBe(dest)
  })

  it("stops the script when the file helper copy does not match the pin, before anything loads", () => {
    const check = steps.find((step) => step.argv[0] === "/bin/sh")
    expect(check?.argv.slice(3)).toEqual([
      "sh",
      `${ROOT}/bridge/eido-file-helper`,
      SHA,
    ])
    expect(check?.argv[2]).toContain("exit 1")
    expect(steps.indexOf(check as Step)).toBeLessThan(
      all.findIndex((text) => text.startsWith("/bin/launchctl bootstrap"))
    )
  })

  it("writes the plist root-owned after dropping any link at its path, lints it, then replaces the loaded agent last", () => {
    const plist = paths.plist
    const write = at(`/usr/bin/tee ${plist}`)
    expect(all.slice(write - 1, write + 4)).toEqual([
      `/bin/rm -f ${plist}`,
      `/usr/bin/tee ${plist}`,
      `/usr/sbin/chown root:wheel ${plist}`,
      `/bin/chmod 0644 ${plist}`,
      `/usr/bin/plutil -lint ${plist}`,
    ])
    const tail = steps.slice(-2)
    expect(tail.map((step) => [line(step), step.mayFail === true])).toEqual([
      ["/bin/launchctl bootout gui/501/com.eido.plane.bridge", true],
      [`/bin/launchctl bootstrap gui/501 ${plist}`, false],
    ])
  })

  it("creates the agent and log dirs as the owner, the log dir private", () => {
    expect(all).toContain(
      "/usr/bin/install -d -o owner -m 0755 /Users/owner/Library/LaunchAgents"
    )
    expect(all).toContain(
      "/usr/bin/install -d -o owner -m 0700 /Users/owner/Library/Logs/eido-dev"
    )
  })

  it("makes no bridge step when the bridge is not planned", () => {
    const none = applySteps(input({ bridge: undefined })).map(line)
    expect(none.filter((text) => /bridge|session-bridge/.test(text))).toEqual(
      []
    )
  })
})

describe("removeSteps", () => {
  const accounts = {
    users: new Map([["owner", 501]]),
    groups: new Map<string, number>(),
  }
  const removal = removeSteps(layout, accounts)
  const removed = removal.map(line)
  const at = (text: string) => {
    const found = removed.indexOf(text)
    expect(found, text).toBeGreaterThanOrEqual(0)
    return found
  }

  it("stops the agent, tolerating one that is not loaded, then deletes its plist and logs", () => {
    const stop = removal.find(
      (step) =>
        line(step) === "/bin/launchctl bootout gui/501/com.eido.plane.bridge"
    )
    expect(stop?.mayFail).toBe(true)
    expect(
      at("/bin/launchctl bootout gui/501/com.eido.plane.bridge")
    ).toBeLessThan(
      at(`/bin/rm -f ${paths.plist} ${paths.outLog} ${paths.errLog}`)
    )
  })

  it("takes every ACL entry the apply added, each tolerating its absence, before it deletes the socket dir", () => {
    const added = applySteps(input())
      .filter((step) => step.argv[1] === "+a")
      .map((step) => step.argv.slice(2))
    expect(added.length).toBeGreaterThan(0)
    for (const [ace, path] of added) {
      const drop = removal.find(
        (step) =>
          step.argv[1] === "-a" && step.argv[2] === ace && step.argv[3] === path
      )
      expect(drop?.mayFail, `${String(ace)} @ ${String(path)}`).toBe(true)
    }
    expect(
      at(`/bin/chmod -a _eidogate allow search ${SOCKET_DIR}`)
    ).toBeLessThan(
      removed.findIndex((text) => text.startsWith(`/bin/rm -rf ${SOCKET_DIR}`))
    )
  })

  it("leaves nothing the apply created: the socket dir, the helper dir, the plist and the logs go", () => {
    const applied = applySteps(input())
    const created = [
      ...applied
        .filter(
          (step) =>
            step.argv[0] === "/usr/bin/install" &&
            step.argv.includes("-d") &&
            (step.argv.at(-1) === SOCKET_DIR || step.argv.at(-1) === paths.dir)
        )
        .map((step) => step.argv.at(-1) ?? ""),
      ...applied
        .filter((step) => step.argv[0] === "/usr/bin/tee")
        .map((step) => step.argv[1] ?? "")
        .filter((path) => path.includes("com.eido.plane.bridge")),
    ]
    expect(created).toEqual([paths.dir, SOCKET_DIR, paths.plist])
    const rmrf = removal.find(
      (step) =>
        step.argv.slice(0, 2).join(" ") === "/bin/rm -rf" &&
        step.argv.includes(SOCKET_DIR)
    )
    expect(rmrf?.argv).toEqual(["/bin/rm", "-rf", SOCKET_DIR, paths.dir])
    expect(removed).toContain(
      `/bin/rm -f ${paths.plist} ${paths.outLog} ${paths.errLog}`
    )
  })

  it("never deletes the stack's shared log dir", () => {
    expect(removal.some((step) => step.argv.includes(paths.logDir))).toBe(false)
  })

  it("skips the agent's stop, not its file cleanup, when the owner has no uid in the account list", () => {
    const steps = removeSteps(layout, {
      users: new Map(),
      groups: new Map(),
    }).map(line)
    expect(
      steps.some(
        (text) =>
          text.includes("com.eido.plane.bridge") && text.includes("bootout")
      )
    ).toBe(false)
    expect(steps).toContain(
      `/bin/rm -f ${paths.plist} ${paths.outLog} ${paths.errLog}`
    )
  })
})

describe("checkBridge", () => {
  it("refuses a relative path, naming the flag", () => {
    expect(() =>
      checkBridge(paths, { ...bridge, helper: "eido-helper" })
    ).toThrow('--bridge-helper must be an absolute path, not "eido-helper"')
    expect(() =>
      checkBridge(paths, { ...bridge, fileRoots: "roots.txt" })
    ).toThrow("--bridge-file-roots must be an absolute path")
  })

  it("refuses a pin that is not 64 lowercase hex digits", () => {
    expect(() =>
      checkBridge(paths, { ...bridge, fileHelperSha256: SHA.toUpperCase() })
    ).toThrow("must be 64 lowercase hex digits")
    expect(() =>
      checkBridge(paths, { ...bridge, fileHelperSha256: SHA.slice(1) })
    ).toThrow("must be 64 lowercase hex digits")
  })

  it("refuses a socket path too long to bind, which a long owner name can cause", () => {
    const long = planeLayout({
      owner: "owner",
      ownerHome: `/Users/${"o".repeat(30)}`,
      firstId: 451,
      env: {},
    })
    expect(() => checkBridge(long.bridge, bridge)).toThrow(
      "a Unix socket path must be shorter than 104"
    )
    expect(() => checkBridge(paths, bridge)).not.toThrow()
  })

  it("refuses a missing owner uid", () => {
    expect(() => checkBridge(paths, { ...bridge, ownerUid: -1 })).toThrow(
      "numeric user id"
    )
  })
})
