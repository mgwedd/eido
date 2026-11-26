import { describe, expect, it } from "vitest"

import { supervisorSocketPath } from "../stack/supervisor.ts"

import {
  accountProblems,
  applySteps,
  coreProfile,
  daemonPlist,
  parseDsclIds,
  parseDsclValue,
  parserProfile,
  pfAnchor,
  planeLayout,
  planeServices,
  removeSteps,
  renderScript,
  renderStep,
  shellQuote,
  supervisorAces,
  type PlaneInput,
  type Step,
} from "./plane.ts"

const HOME = "/Users/owner"
const layout = planeLayout({
  owner: "owner",
  ownerHome: HOME,
  firstId: 451,
  env: {},
})

const input = (over: Partial<PlaneInput> = {}): PlaneInput => ({
  layout,
  checkout: "/Users/owner/dev/eido",
  node: "/opt/homebrew/bin/node",
  tailnetHost: "mac.example.ts.net",
  settings: {},
  allowlist: {
    hosts: ["api.example.com", "push.example.net"],
    local: [{ host: "127.0.0.1", port: 1143 }],
  },
  ...over,
})

const none = {
  users: new Map<string, number>(),
  groups: new Map<string, number>(),
}
const line = (step: Step) => step.argv.join(" ")
const lines = (steps: readonly Step[]) => steps.map(line)

describe("planeLayout", () => {
  it("puts the plane outside every home and the supervisor socket in the owner's stack dir", () => {
    expect(layout.ids).toEqual({
      gateUid: 451,
      gateGid: 451,
      dataUid: 452,
      dataGid: 452,
      ipcGid: 453,
      parseUid: 454,
      parseGid: 454,
    })
    expect(layout.gateSocket).toBe(
      "/Library/Application Support/Eido/run/gate-data-plane.sock"
    )
    expect(layout.controlSocket).toBe(
      "/Library/Application Support/Eido/run/gate-control.sock"
    )
    expect(layout.keychain).toBe(
      "/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db"
    )
    expect(layout.supervisorDir).toBe(
      "/Users/owner/Library/Application Support/eido-dev/run/supervisor"
    )
    expect(layout.supervisorSocket).toBe(
      "/Users/owner/Library/Application Support/eido-dev/run/supervisor/supervisor.sock"
    )
  })

  it("follows EIDO_STACK_DIR for the supervisor socket", () => {
    const moved = planeLayout({
      owner: "owner",
      ownerHome: HOME,
      firstId: 451,
      env: { EIDO_STACK_DIR: "/Users/owner/eido-stack" },
    })
    expect(moved.supervisorSocket).toBe(
      "/Users/owner/eido-stack/run/supervisor/supervisor.sock"
    )
  })

  it("refuses a stack dir outside the owner's home", () => {
    expect(() =>
      planeLayout({
        owner: "owner",
        ownerHome: HOME,
        firstId: 451,
        env: { EIDO_STACK_DIR: "/opt/eido" },
      })
    ).toThrow("must be inside /Users/owner")
  })

  it("refuses root, a service user and a name that is not one as the owner", () => {
    for (const owner of ["root", "_eidogate", "a b"])
      expect(() =>
        planeLayout({ owner, ownerHome: HOME, firstId: 451, env: {} })
      ).toThrow()
  })

  it("refuses ids outside the hidden system range", () => {
    for (const firstId of [400, 497, 451.5, Number.NaN])
      expect(() =>
        planeLayout({ owner: "owner", ownerHome: HOME, firstId, env: {} })
      ).toThrow("--first-id must be between 401 and 496")
    expect(
      planeLayout({ owner: "owner", ownerHome: HOME, firstId: 496, env: {} })
        .ids.parseUid
    ).toBe(499)
  })
})

describe("dscl output", () => {
  it("reads name and id pairs", () => {
    const ids = parseDsclIds(
      "_www                     70\nowner                   501\nnobody -2\n\n"
    )
    expect([...ids]).toEqual([
      ["_www", 70],
      ["owner", 501],
      ["nobody", -2],
    ])
  })

  it("reads an attribute on its own line or on the next one", () => {
    expect(
      parseDsclValue("NFSHomeDirectory: /Users/owner\n", "NFSHomeDirectory")
    ).toBe("/Users/owner")
    expect(
      parseDsclValue(
        "NFSHomeDirectory:\n /Users/Owner Name\n",
        "NFSHomeDirectory"
      )
    ).toBe("/Users/Owner Name")
    expect(() => parseDsclValue("RealName: x\n", "NFSHomeDirectory")).toThrow(
      "dscl printed no NFSHomeDirectory"
    )
  })
})

describe("accountProblems", () => {
  it("has none on a fresh host or one the plan already ran on", () => {
    expect(accountProblems(layout, none)).toEqual([])
    const applied = {
      users: new Map([
        ["owner", 501],
        ["_eidogate", 451],
        ["_eidodata", 452],
        ["_eidoparse", 454],
      ]),
      groups: new Map([
        ["_eidogate", 451],
        ["_eidodata", 452],
        ["_eidoipc", 453],
        ["_eidoparse", 454],
      ]),
    }
    expect(accountProblems(layout, applied)).toEqual([])
  })

  it("names an existing service user with another id, and an id another account holds", () => {
    expect(
      accountProblems(layout, {
        users: new Map([["_eidogate", 460]]),
        groups: new Map([["_other", 453]]),
      })
    ).toEqual([
      "user _eidogate already exists with id 460, not 451; pass --first-id 460 or remove it first",
      "group id 453 belongs to _other; pass a free --first-id",
    ])
  })

  it("reports a parser user or group that clashes with an existing account", () => {
    expect(
      accountProblems(layout, {
        users: new Map([
          ["_eidoparse", 470],
          ["_spotlight", 454],
        ]),
        groups: new Map([["_eidoparse", 471]]),
      })
    ).toEqual([
      "user _eidoparse already exists with id 470, not 454; pass --first-id 470 or remove it first",
      "user id 454 belongs to _spotlight; pass a free --first-id",
      "group _eidoparse already exists with id 471, not 454; pass --first-id 471 or remove it first",
    ])
  })
})

describe("coreProfile", () => {
  it("allows only the gate socket, the parser socket and core's own listener when no port is set", () => {
    expect(coreProfile(layout, { core: 8789 })).toBe(
      [
        "(version 1)",
        "; Eido data plane (#70): generated by `host plane`; edit the generator, not this file.",
        "(allow default)",
        "(deny network*)",
        '(allow network-outbound (remote unix-socket (path-literal "/Library/Application Support/Eido/run/gate-data-plane.sock")))',
        '(allow network-outbound (remote unix-socket (path-literal "/Library/Application Support/Eido/parser-run/parser.sock")))',
        '(allow network-bind network-inbound (local ip "localhost:8789"))',
        '(deny file-read* file-write* (subpath "/Library/Application Support/Eido/gate") (subpath "/Library/Application Support/Eido/home/gate"))',
        "",
      ].join("\n")
    )
  })

  it("adds llama-server and the egress proxy on loopback when they are set", () => {
    const profile = coreProfile(layout, {
      core: 8789,
      llama: 8080,
      egress: 8790,
    })
    expect(profile).toContain(
      '(allow network-outbound (remote ip "localhost:8080"))\n'
    )
    expect(profile).toContain(
      '(allow network-outbound (remote ip "localhost:8790"))\n'
    )
  })

  it("refuses a path that cannot be quoted in SBPL", () => {
    const odd = { ...layout, gateSocket: '/tmp/a"b.sock' }
    expect(() => coreProfile(odd, { core: 8789 })).toThrow(
      "cannot go in a sandbox profile"
    )
  })

  it("gives parsers no network but binding the broker's own socket", () => {
    expect(parserProfile(layout.parser)).toBe(
      [
        "(version 1)",
        "; Eido document parsers (#43, #70, #818): generated by `host plane`; no network but the broker's own socket.",
        "(allow default)",
        "(deny network*)",
        '(allow network-bind network-inbound (local unix-socket (path-literal "/Library/Application Support/Eido/parser-run/parser.sock")))',
        "",
      ].join("\n")
    )
  })
})

describe("pfAnchor", () => {
  it("blocks every new TCP connection and all UDP from the data user, and all traffic of the parser user, when nothing is allowed", () => {
    expect(pfAnchor(layout, { core: 8789 })).toBe(
      [
        "# Eido plane split (#70), anchor com.apple/eido.plane: generated by `host plane`.",
        "# uid 452 is _eidodata.",
        "block return out quick proto tcp from any to any user 452 flags S/SA",
        "block return out quick proto udp from any to any user 452",
        "# uid 454 is _eidoparse: no network at all.",
        "block return quick proto { tcp, udp } from any to any user 454",
        "",
      ].join("\n")
    )
  })

  it("passes the egress proxy and llama-server on 127.0.0.1 before the blocks", () => {
    const rules = pfAnchor(layout, {
      core: 8789,
      egress: 8790,
      llama: 8080,
    }).split("\n")
    expect(rules[2]).toBe(
      "pass out quick on lo0 inet proto tcp from any to 127.0.0.1 port { 8790, 8080 } user 452 flags S/SA keep state"
    )
    expect(rules[3]).toBe(
      "block return out quick proto tcp from any to any user 452 flags S/SA"
    )
  })
})

describe("daemonPlist", () => {
  const plist = daemonPlist({
    label: "com.eido.plane.gate",
    user: "_eidogate",
    group: "_eidogate",
    args: ["/opt/node", "a&b"],
    cwd: "/app",
    env: { Z: "1", A: "<x>" },
    outLog: "/l/out",
    errLog: "/l/err",
    keepAlive: true,
  })

  it("runs as the service user with a private umask and restarts", () => {
    expect(plist).toContain(
      "  <key>UserName</key>\n  <string>_eidogate</string>\n"
    )
    expect(plist).toContain(
      "  <key>GroupName</key>\n  <string>_eidogate</string>\n"
    )
    expect(plist).toContain("  <key>Umask</key>\n  <integer>63</integer>\n")
    expect(plist).toContain("  <key>KeepAlive</key>\n  <true/>\n")
    expect(plist).not.toContain("StartInterval")
  })

  it("escapes values and sorts the environment", () => {
    expect(plist).toContain("<string>a&amp;b</string>")
    expect(plist).toContain(
      "    <key>A</key>\n    <string>&lt;x&gt;</string>\n    <key>Z</key>\n    <string>1</string>\n"
    )
  })

  it("reruns a periodic job instead of keeping it alive", () => {
    const job = daemonPlist({
      label: "com.eido.plane.pf",
      user: "root",
      group: "wheel",
      args: ["/bin/sh"],
      cwd: "/",
      env: {},
      outLog: "/l/out",
      errLog: "/l/err",
      keepAlive: false,
      interval: 300,
    })
    expect(job).toContain(
      "  <key>StartInterval</key>\n  <integer>300</integer>\n"
    )
    expect(job).not.toContain("KeepAlive")
  })
})

describe("shellQuote", () => {
  it("leaves safe words bare and single-quotes the rest", () => {
    expect(shellQuote("/usr/bin/dscl")).toBe("/usr/bin/dscl")
    expect(shellQuote("/Library/Application Support")).toBe(
      "'/Library/Application Support'"
    )
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("*")).toBe("'*'")
  })
})

describe("planeServices", () => {
  it("runs the gate and core from the app copy, under their own users, with the plane's dirs over stack.env", () => {
    const services = planeServices(
      input({
        settings: {
          EIDO_GATE_DATA_DIR: "/Users/owner/elsewhere",
          EIDO_GOOGLE_CLIENT_ID: "client",
        },
      })
    )
    expect(services.gate.cwd).toBe(
      "/Library/Application Support/Eido/app/packages/gate"
    )
    // The launcher execs the gate's command as _eidogate, from the same cwd.
    expect(services.launcher).toContain(
      ` '/usr/bin/env' '-C' '/Library/Application Support/Eido/app/packages/gate' '/opt/homebrew/bin/node' '--disable-warning=ExperimentalWarning' '--import' './src/ts-hooks.ts' './src/main.ts'\n`
    )
    expect(services.launcher).toContain(
      `'/usr/sbin/chroot' '-u' '_eidogate' '-g' '_eidogate' '-G' '_eidogate,_eidoipc' '/'`
    )
    expect(services.gate.env["EIDO_GATE_DATA_DIR"]).toBe(
      "/Library/Application Support/Eido/gate"
    )
    expect(services.gate.env["EIDO_GOOGLE_CLIENT_ID"]).toBe("client")
    expect(services.gate.env["EIDO_GATE_SUPERVISOR_SOCKET"]).toBe(
      layout.supervisorSocket
    )
    expect(services.gate.env["HOME"]).toBe(layout.gateHome)
    expect(services.core.user).toBe("_eidodata")
    expect(services.core.args.slice(0, 4)).toEqual([
      "/usr/bin/sandbox-exec",
      "-f",
      "/Library/Application Support/Eido/policy/core.sb",
      "/opt/homebrew/bin/node",
    ])
    expect(services.core.env["EIDO_DATA_DIR"]).toBe(
      "/Library/Application Support/Eido/data"
    )
    expect(services.core.env["EIDO_GATE_SOCKET"]).toBe(layout.gateSocket)
    expect(services.core.env["HOME"]).toBe(layout.dataHome)
    expect(services.ports).toEqual({ core: 8789 })
  })

  it("points core at the egress proxy and llama-server on 127.0.0.1", () => {
    const services = planeServices(
      input({
        settings: { EIDO_LLAMA_HOST: "localhost", EIDO_LLAMA_PORT: "8080" },
        egressPort: 8790,
      })
    )
    expect(services.ports).toEqual({ core: 8789, llama: 8080, egress: 8790 })
    expect(services.gate.env["EIDO_GATE_EGRESS_PORT"]).toBe("8790")
    expect(services.core.env["EIDO_GMAIL_PROXY_URL"]).toBe(
      "http://127.0.0.1:8790"
    )
    expect(services.core.env["EIDO_LLAMA_HOST"]).toBe("127.0.0.1")
    expect(services.core.env["EIDO_LLAMA_PORT"]).toBe("8080")
  })

  it("refuses a node inside a home and llama-server off this Mac", () => {
    expect(() =>
      planeServices(input({ node: "/Users/owner/.nvm/node" }))
    ).toThrow("inside a home the service users cannot read")
    expect(() =>
      planeServices(
        input({
          settings: { EIDO_LLAMA_HOST: "10.0.0.2", EIDO_LLAMA_PORT: "8080" },
        })
      )
    ).toThrow("EIDO_LLAMA_HOST must be 127.0.0.1")
    expect(() =>
      planeServices(input({ settings: { EIDO_LLAMA_PORT: "eighty" } }))
    ).toThrow("EIDO_LLAMA_PORT must be a port number")
  })

  it("loads the pf anchor as root, at load and every five minutes", () => {
    const { pf } = planeServices(input())
    expect(pf.user).toBe("root")
    expect(pf.args).toEqual([
      "/bin/sh",
      "-c",
      "/sbin/pfctl -E; /sbin/pfctl -a com.apple/eido.plane -f '/Library/Application Support/Eido/policy/eido-plane.pf'",
    ])
    expect(pf.interval).toBe(300)
  })

  it("refreshes the gate's egress table as root with only sh and pfctl, at load and every five minutes", () => {
    const { egress } = planeServices(input())
    expect(egress.user).toBe("root")
    expect(egress.args.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    expect(egress.args[2]).toContain(
      '-T add "$host" || echo "egress: $host was not added" >&2; done < \'/Library/Application Support/Eido/policy/eido-egress.hosts\''
    )
    expect(egress.errLog).toBe("/Library/Logs/Eido/pf/egress.err.log")
    expect(egress.interval).toBe(300)
    expect(egress.keepAlive).toBe(false)
  })
})

describe("supervisorAces", () => {
  it("lets the gate user search from the owner's home down and inherit access to new files in the supervisor dir only", () => {
    expect(
      supervisorAces(layout).map(({ path, ace }) => `${ace} @ ${path}`)
    ).toEqual([
      "_eidogate allow search @ /Users/owner",
      "_eidogate allow search @ /Users/owner/Library",
      "_eidogate allow search @ /Users/owner/Library/Application Support",
      "_eidogate allow search @ /Users/owner/Library/Application Support/eido-dev",
      "_eidogate allow search @ /Users/owner/Library/Application Support/eido-dev/run",
      "_eidogate allow search @ /Users/owner/Library/Application Support/eido-dev/run/supervisor",
      "_eidogate allow read,write,file_inherit,only_inherit @ /Users/owner/Library/Application Support/eido-dev/run/supervisor",
    ])
  })

  it("never puts an inheriting entry on the run dir or above, so no other file in the run dir gains access", () => {
    const inheriting = supervisorAces(layout).filter(({ ace }) =>
      ace.includes("inherit")
    )
    expect(inheriting.map(({ path }) => path)).toEqual([layout.supervisorDir])
  })

  it("names the socket the stack's supervisor listens on", () => {
    expect(layout.supervisorSocket).toBe(
      supervisorSocketPath({ platform: "darwin", env: {}, home: HOME })
    )
  })
})

describe("applySteps", () => {
  const steps = applySteps(input({ egressPort: 8790 }))
  const all = lines(steps)
  const at = (text: string) => {
    const index = all.indexOf(text)
    expect(index, text).toBeGreaterThanOrEqual(0)
    return index
  }

  it("copies the checkout without secrets, env files, local eval output or databases", () => {
    const rsync = steps.find((step) => step.argv[0] === "/usr/bin/rsync")
    expect(rsync?.argv).toEqual([
      "/usr/bin/rsync",
      "-a",
      "--delete",
      "--exclude=/.git",
      "--exclude=.turbo",
      "--exclude=/apps/web/.next",
      "--exclude=coverage",
      "--exclude=/infra/secrets",
      "--include=.env.example",
      "--exclude=.env*",
      "--exclude=/eval-local",
      "--exclude=*.db",
      "--exclude=*.db-wal",
      "--exclude=*.db-shm",
      "--exclude=/gate-launcher.zsh",
      "/Users/owner/dev/eido/",
      "/Library/Application Support/Eido/app/",
    ])
  })

  it("creates the users with no password or shell and puts both in the socket group", () => {
    expect(all).toContain(
      "/usr/bin/dscl . -create /Users/_eidogate UniqueID 451"
    )
    expect(all).toContain(
      "/usr/bin/dscl . -create /Users/_eidodata UniqueID 452"
    )
    expect(all).toContain("/usr/bin/dscl . -create /Users/_eidodata Password *")
    expect(all).toContain(
      "/usr/bin/dscl . -create /Users/_eidodata UserShell /usr/bin/false"
    )
    expect(all).toContain(
      "/usr/bin/dscl . -create /Groups/_eidoipc GroupMembership _eidogate _eidodata"
    )
  })

  it("gives each plane its own private dirs and the data plane only the socket dir through the group", () => {
    expect(all).toContain(
      "/usr/sbin/chown _eidogate:_eidogate /Library/Application Support/Eido/gate"
    )
    expect(all).toContain(
      "/usr/sbin/chown _eidodata:_eidodata /Library/Application Support/Eido/data"
    )
    expect(all).toContain(
      "/usr/sbin/chown _eidogate:_eidoipc /Library/Application Support/Eido/run"
    )
    expect(all).toContain(
      "/bin/chmod 0750 /Library/Application Support/Eido/run"
    )
    expect(all).toContain(
      "/bin/chmod 0700 /Library/Application Support/Eido/gate"
    )
    expect(all).toContain(
      "/bin/chmod 0700 /Library/Application Support/Eido/data"
    )
  })

  it("creates the supervisor dir as the owner at 0700 after checking the run dir exists, and before any ACL entry names it", () => {
    const runDir = "/Users/owner/Library/Application Support/eido-dev/run"
    const supervisorDir = `${runDir}/supervisor`
    const create = at(`/usr/bin/install -d -o owner -m 0700 ${supervisorDir}`)
    expect(at(`/bin/test -d ${runDir}`)).toBeLessThan(create)
    expect(create).toBeLessThan(
      at(`/bin/chmod +a _eidogate allow search ${supervisorDir}`)
    )
  })

  it("drops the inherited entry an earlier apply put on the run dir, tolerating its absence, before granting the new ones", () => {
    const runDir = "/Users/owner/Library/Application Support/eido-dev/run"
    const drop = `/bin/chmod -a _eidogate allow read,write,file_inherit,only_inherit ${runDir}`
    const dropStep = steps.find((step) => line(step) === drop)
    expect(dropStep?.mayFail).toBe(true)
    expect(at(drop)).toBeLessThan(
      at(
        `/bin/chmod +a _eidogate allow read,write,file_inherit,only_inherit ${runDir}/supervisor`
      )
    )
  })

  it("never grants an inheriting entry anywhere but the supervisor dir", () => {
    const granted = steps.filter(
      (step) =>
        step.argv[1] === "+a" && (step.argv[2] ?? "").includes("inherit")
    )
    expect(granted.map((step) => step.argv[3])).toEqual([
      "/Users/owner/Library/Application Support/eido-dev/run/supervisor",
    ])
  })

  it("never grants the data user anything outside the plane", () => {
    expect(
      all.filter(
        (text) => text.includes("_eidodata") && text.includes("/Users/owner")
      )
    ).toEqual([])
    expect(
      all
        .filter((text) => text.includes("+a"))
        .every((text) => text.includes("_eidogate allow"))
    ).toBe(true)
  })

  it("creates users before chowning to them, and checks every policy file before loading anything", () => {
    expect(at("/usr/bin/dscl . -create /Users/_eidogate")).toBeLessThan(
      at(
        "/usr/sbin/chown _eidogate:_eidogate /Library/Application Support/Eido/gate"
      )
    )
    const firstLoad = all.findIndex((text) =>
      text.startsWith("/bin/launchctl bootstrap")
    )
    expect(
      at(
        "/usr/bin/sandbox-exec -f /Library/Application Support/Eido/policy/core.sb /usr/bin/true"
      )
    ).toBeLessThan(firstLoad)
    expect(
      at(
        "/sbin/pfctl -a com.apple/eido.plane -nf /Library/Application Support/Eido/policy/eido-plane.pf"
      )
    ).toBeLessThan(firstLoad)
    expect(
      at(
        "/usr/bin/plutil -lint /Library/LaunchDaemons/com.eido.plane.core.plist"
      )
    ).toBeLessThan(firstLoad)
  })

  it("loads the pf rules before the services, and replaces a loaded job instead of failing on it", () => {
    const launch = steps.filter((step) => step.argv[0] === "/bin/launchctl")
    expect(launch.map((step) => [line(step), step.mayFail === true])).toEqual([
      ["/bin/launchctl bootout system/com.eido.plane.pf", true],
      [
        "/bin/launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.pf.plist",
        false,
      ],
      ["/bin/launchctl bootout system/com.eido.plane.egress", true],
      [
        "/bin/launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.egress.plist",
        false,
      ],
      ["/bin/launchctl bootout system/com.eido.plane.gate", true],
      [
        "/bin/launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.gate.plist",
        false,
      ],
      ["/bin/launchctl bootout system/com.eido.plane.parser", true],
      [
        "/bin/launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.parser.plist",
        false,
      ],
      ["/bin/launchctl bootout system/com.eido.plane.core", true],
      [
        "/bin/launchctl bootstrap system /Library/LaunchDaemons/com.eido.plane.core.plist",
        false,
      ],
    ])
  })

  it("writes the pf rules the anchor function builds for these ports", () => {
    const pf = steps.find(
      (step) => step.argv.join(" ") === `/usr/bin/tee ${layout.pfRules}`
    )
    expect(pf?.stdin).toContain("port { 8790 } user 452")
  })

  it("writes the gate's egress anchor and host list from the allowlist, and checks then loads the anchor before any job starts", () => {
    const written = (path: string) =>
      steps.find((step) => line(step) === `/usr/bin/tee ${path}`)?.stdin
    expect(written(layout.egressHosts)).toBe(
      "api.example.com\npush.example.net\n"
    )
    const rules = written(layout.egressRules)
    expect(rules).toContain("to <eido_egress> port 443 user 451 ")
    expect(rules).toContain("to 127.0.0.1 port { 1143 } user 451 ")
    const check = at(
      "/sbin/pfctl -a com.apple/eido.egress -nf /Library/Application Support/Eido/policy/eido-egress.pf"
    )
    const load = at(
      "/sbin/pfctl -a com.apple/eido.egress -f /Library/Application Support/Eido/policy/eido-egress.pf"
    )
    expect(check).toBeLessThan(load)
    expect(load).toBeLessThan(
      all.findIndex((text) => text.startsWith("/bin/launchctl bootstrap"))
    )
  })

  it("starts the gate daemon as root through the launcher, not as _eidogate", () => {
    const plist = steps.find(
      (step) => line(step) === `/usr/bin/tee ${layout.plists.gate}`
    )?.stdin
    expect(plist).toContain(
      "  <key>UserName</key>\n  <string>root</string>\n  <key>GroupName</key>\n  <string>wheel</string>\n"
    )
    expect(plist).not.toContain("<string>_eidogate</string>")
    expect(plist).toContain(
      "  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/zsh</string>\n    <string>-f</string>\n    <string>/Library/Application Support/Eido/app/gate-launcher.zsh</string>\n  </array>\n"
    )
    // The gate's own settings still reach it: the launcher passes the job's env through.
    expect(plist).toContain(
      "    <key>EIDO_GATE_KEYCHAIN_PATH</key>\n    <string>/Library/Application Support/Eido/home/gate/Library/Keychains/eido/eido.keychain-db</string>\n"
    )
  })

  it("writes the launcher root-owned and read-only after the app copy, before the gate's plist", () => {
    const launcher = "/Library/Application Support/Eido/app/gate-launcher.zsh"
    const write = at(`/usr/bin/tee ${launcher}`)
    const gate =
      "'/usr/sbin/chroot' '-u' '_eidogate' '-g' '_eidogate' '-G' '_eidogate,_eidoipc' '/' '/usr/bin/env' '-C' '/Library/Application Support/Eido/app/packages/gate' '/opt/homebrew/bin/node' '--disable-warning=ExperimentalWarning' '--import' './src/ts-hooks.ts' './src/main.ts'"
    expect(steps[write]?.stdin).toBe(
      [
        "#!/bin/zsh -f",
        "# Eido gate launcher (#823): generated by `host plane`; edit the generator, not this file.",
        "# launchd runs it as root. It pipes the passphrase of the System keychain item com.eido.gate.keychain-unlock",
        "# into the gate's stdin, drops to _eidogate and execs the gate, which unlocks its keychain (#821).",
        "set -u",
        "ulimit -c 0",
        "export EIDO_GATE_KEYCHAIN_UNLOCK=stdin",
        "if ! '/usr/bin/env' '-i' 'HOME=/var/root' '/usr/bin/security' 'find-generic-password' '-s' 'com.eido.gate.keychain-unlock' '/Library/Keychains/System.keychain' >/dev/null 2>&1; then",
        "  print -u2 -r -- 'eido gate launcher: the System keychain item com.eido.gate.keychain-unlock is missing or unreadable; starting the gate with no passphrase, so it stays locked'",
        `  exec ${gate} </dev/null`,
        "fi",
        `'/usr/bin/env' '-i' 'HOME=/var/root' '/usr/bin/security' 'find-generic-password' '-s' 'com.eido.gate.keychain-unlock' '-w' '/Library/Keychains/System.keychain' | exec ${gate}`,
        "",
      ].join("\n")
    )
    // A symlink left at the path is removed first, so the root tee, chown and chmod cannot follow it.
    expect(all.slice(write - 1, write + 3)).toEqual([
      `/bin/rm -f ${launcher}`,
      `/usr/bin/tee ${launcher}`,
      `/usr/sbin/chown root:wheel ${launcher}`,
      `/bin/chmod 0555 ${launcher}`,
    ])
    expect(
      at("/bin/chmod -R go-w /Library/Application Support/Eido/app")
    ).toBeLessThan(write)
    expect(write).toBeLessThan(at(`/usr/bin/tee ${layout.plists.gate}`))
    // Its directory, the app copy, is root's and 0755: the gate user cannot replace the file.
    expect(all).toContain(
      "/usr/sbin/chown root:wheel /Library/Application Support/Eido/app"
    )
    expect(all).toContain(
      "/bin/chmod 0755 /Library/Application Support/Eido/app"
    )
  })

  it("only creates or sets, apart from dropping the old run dir entry (tolerated when absent), the launcher it rewrites and links in the gate's logs, so it can run again on a host it already ran on", () => {
    const destructive = steps.filter((step) =>
      /\s-delete\s|\/bin\/rm\b|^\/bin\/chmod -a\s/.test(line(step))
    )
    expect(
      destructive.map((step) => `${line(step)} | mayFail=${step.mayFail}`)
    ).toEqual([
      "/usr/bin/find /Library/Logs/Eido/gate -mindepth 1 -maxdepth 1 ( ! -type f -o -links +1 ) -exec /bin/rm -rf {} + | mayFail=undefined",
      "/bin/rm -f /Library/Application Support/Eido/app/gate-launcher.zsh | mayFail=undefined",
      "/bin/chmod -a _eidogate allow read,write,file_inherit,only_inherit /Users/owner/Library/Application Support/eido-dev/run | mayFail=true",
    ])
  })

  it("keeps the gate's log directory root's, and takes back the log files an older plane gave the gate", () => {
    // launchd opens these logs as root: a directory the gate could write would let it swap a
    // log for a link to a file root then appends to.
    const gateLogs = "/Library/Logs/Eido/gate"
    const owner = at(`/usr/sbin/chown root:admin ${gateLogs}`)
    expect(all.slice(owner, owner + 4)).toEqual([
      `/usr/sbin/chown root:admin ${gateLogs}`,
      `/bin/chmod 0750 ${gateLogs}`,
      `/usr/bin/find ${gateLogs} -mindepth 1 -maxdepth 1 ( ! -type f -o -links +1 ) -exec /bin/rm -rf {} +`,
      `/usr/bin/find ${gateLogs} -mindepth 1 -maxdepth 1 -type f -exec /usr/sbin/chown -h root:admin {} + -exec /bin/chmod 0640 {} +`,
    ])
    expect(
      all.filter(
        (text) =>
          (text.startsWith("/usr/sbin/chown ") ||
            text.startsWith("/bin/chmod ")) &&
          text.endsWith(` ${gateLogs}`)
      )
    ).toEqual([
      `/usr/sbin/chown root:admin ${gateLogs}`,
      `/bin/chmod 0750 ${gateLogs}`,
    ])
    expect(
      all.slice(0, owner).filter((text) => text.includes(gateLogs))
    ).toEqual([`/bin/mkdir -p ${gateLogs}`])
  })
})

describe("removeSteps", () => {
  it("stops the jobs, flushes the anchor and deletes only the accounts that exist, keeping the data", () => {
    const steps = removeSteps(layout, {
      users: new Map([["_eidogate", 451]]),
      groups: new Map([
        ["_eidogate", 451],
        ["_eidoipc", 453],
      ]),
    })
    const all = lines(steps)
    const at = (text: string) => {
      const index = all.indexOf(text)
      expect(index, text).toBeGreaterThanOrEqual(0)
      return index
    }
    expect(all.slice(0, 2)).toEqual([
      "/bin/launchctl bootout system/com.eido.plane.core",
      "/bin/rm -f /Library/LaunchDaemons/com.eido.plane.core.plist",
    ])
    expect(all).toContain("/sbin/pfctl -a com.apple/eido.plane -F all")
    expect(all).toContain("/sbin/pfctl -a com.apple/eido.egress -F all")
    expect(all).toContain(
      "/bin/rm -f /Library/LaunchDaemons/com.eido.plane.egress.plist"
    )
    expect(all).toContain(
      "/bin/chmod -a _eidogate allow read,write,file_inherit,only_inherit /Users/owner/Library/Application Support/eido-dev/run"
    )
    expect(all).toContain(
      "/bin/chmod -a _eidogate allow read,write,file_inherit,only_inherit /Users/owner/Library/Application Support/eido-dev/run/supervisor"
    )
    expect(all.filter((text) => text.includes("-delete"))).toEqual([
      "/usr/bin/dscl . -delete /Users/_eidogate",
      "/usr/bin/dscl . -delete /Groups/_eidoipc",
      "/usr/bin/dscl . -delete /Groups/_eidogate",
    ])
    const launcher =
      "/bin/rm -f /Library/Application Support/Eido/app/gate-launcher.zsh"
    expect(at(launcher)).toBeGreaterThan(
      at("/bin/launchctl bootout system/com.eido.plane.gate")
    )
    const rm = all.find((text) => text.startsWith("/bin/rm -rf"))
    expect(rm).toBe(
      "/bin/rm -rf /Library/Application Support/Eido/policy /Library/Application Support/Eido/app /Library/Application Support/Eido/run"
    )
    expect(
      all.some(
        (text) => text.startsWith("/bin/rm -rf") && text.includes("/Eido/gate")
      )
    ).toBe(false)
    expect(
      all.some(
        (text) => text.startsWith("/bin/rm -rf") && text.includes("/Eido/data")
      )
    ).toBe(false)
  })
})

describe("renderScript", () => {
  it("feeds file contents through a quoted heredoc and lets expected failures pass", () => {
    expect(
      renderStep({ argv: ["/usr/bin/tee", "/a b"], stdin: "x $HOME\n" })
    ).toBe("/usr/bin/tee '/a b' >/dev/null <<'EIDO_EOF'\nx $HOME\nEIDO_EOF")
    expect(
      renderStep({
        argv: ["/bin/launchctl", "bootout", "system/x"],
        mayFail: true,
      })
    ).toBe("/bin/launchctl bootout system/x || true")
  })

  it("refuses a file that would end the heredoc early", () => {
    expect(() =>
      renderStep({ argv: ["/usr/bin/tee", "/a"], stdin: "a\nEIDO_EOF\nb\n" })
    ).toThrow("contains the line EIDO_EOF")
  })

  it("stops at the first failure and ends with the notes as comments", () => {
    expect(renderScript([{ argv: ["/usr/bin/true"] }], ["kept: x"])).toBe(
      "#!/bin/sh\n# Generated by `node infra/host/bin.ts plane`; review it, then run it with sudo (infra/plane-split.md).\nset -eu\n/usr/bin/true\n# kept: x\n"
    )
  })
})
