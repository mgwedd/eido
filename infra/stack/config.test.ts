import { describe, expect, it } from "vitest"

import {
  allowedHosts,
  buildStackConfig,
  DEFAULTS,
  type ConfigInput,
} from "./config.ts"

const HOST = "node.example.ts.net"

const input = (overrides: Partial<ConfigInput> = {}): ConfigInput => ({
  mode: "dev",
  env: {},
  home: "/home/u",
  repoRoot: "/repo",
  nodePath: "/bin/node",
  tailnetHost: HOST,
  ...overrides,
})

const byName = (config: ReturnType<typeof buildStackConfig>, name: string) => {
  const spec = config.processes.find((p) => p.name === name)
  if (spec === undefined) throw new Error(`no ${name}`)
  return spec
}

describe("allowedHosts", () => {
  it("lists loopback by address and name, the tailnet host and the host on the edge port", () => {
    expect(allowedHosts(8788, HOST, 8443)).toBe(
      `127.0.0.1:8788,localhost:8788,${HOST},${HOST}:8443`
    )
  })
})

describe("buildStackConfig", () => {
  it("starts gate, core and web in that order on the default ports", () => {
    const config = buildStackConfig(input())
    expect(config.processes.map((p) => p.name)).toEqual(["gate", "core", "web"])
    expect(config.ports).toEqual({ web: 3000, core: 8789, gate: 8788 })
    expect(config.edgePort).toBe(DEFAULTS.edgePort)
    expect(Object.values(config.ports)).not.toContain(8787)
  })

  it("keeps data, sockets and logs under the dev dirs", () => {
    const config = buildStackConfig(input())
    const stackDir = "/home/u/Library/Application Support/eido-dev"
    expect(config.stackDir).toBe(stackDir)
    expect(config.runDir).toBe(`${stackDir}/run`)
    expect(config.logDir).toBe("/home/u/Library/Logs/eido-dev")
    expect(config.gateSocket).toBe(`${stackDir}/run/gate-data-plane.sock`)
    expect(config.privateDirs).toEqual([
      stackDir,
      `${stackDir}/run`,
      `${stackDir}/gate`,
      `${stackDir}/core`,
      "/home/u/Library/Logs/eido-dev",
    ])
  })

  it("gives the gate its sockets, WebAuthn identity, empty base path and allowed hosts", () => {
    const gate = byName(buildStackConfig(input()), "gate")
    const stackDir = "/home/u/Library/Application Support/eido-dev"
    expect(gate.cwd).toBe("/repo/packages/gate")
    expect(gate.command).toBe("/bin/node")
    expect(gate.env).toEqual({
      EIDO_GATE_DATA_DIR: `${stackDir}/gate`,
      EIDO_GATE_SOCKET: `${stackDir}/run/gate-data-plane.sock`,
      EIDO_GATE_CONTROL_SOCKET: `${stackDir}/run/gate-control.sock`,
      EIDO_WEBAUTHN_RP_ID: HOST,
      EIDO_WEBAUTHN_ORIGIN: `https://${HOST}:8443`,
      EIDO_GATE_PHONE_HOST: "127.0.0.1",
      EIDO_GATE_PHONE_PORT: "8788",
      EIDO_GATE_PHONE_BASE_PATH: "",
      EIDO_GATE_PHONE_ALLOWED_HOSTS: `127.0.0.1:8788,localhost:8788,${HOST},${HOST}:8443`,
    })
    expect(gate.healthUrl).toBe("http://127.0.0.1:8788/passkey/status")
  })

  it("points core at the gate socket with an empty base path", () => {
    const core = byName(buildStackConfig(input()), "core")
    expect(core.cwd).toBe("/repo/packages/core")
    expect(core.env).toMatchObject({
      EIDO_GATE_SOCKET:
        "/home/u/Library/Application Support/eido-dev/run/gate-data-plane.sock",
      EIDO_CORE_HOST: "127.0.0.1",
      EIDO_CORE_PORT: "8789",
      EIDO_CORE_BASE_PATH: "",
      EIDO_CORE_ALLOWED_HOSTS: `127.0.0.1:8789,localhost:8789,${HOST},${HOST}:8443`,
    })
    expect(core.healthUrl).toBe("http://127.0.0.1:8789/connectors/health")
  })

  it("never sets the llama, Gmail or Bridge variables", () => {
    const config = buildStackConfig(input())
    const keys = config.processes.flatMap((p) => Object.keys(p.env))
    expect(keys.filter((k) => /LLAMA|GMAIL|BRIDGE/.test(k))).toEqual([])
  })

  it("watches gate and core and runs next dev on 127.0.0.1 in dev mode", () => {
    const config = buildStackConfig(input())
    expect(byName(config, "gate").args).toEqual([
      "--watch",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "./src/ts-hooks.ts",
      "./src/main.ts",
    ])
    expect(byName(config, "core").args[0]).toBe("--watch")
    const web = byName(config, "web")
    expect(web.args).toEqual([
      "/repo/apps/web/node_modules/next/dist/bin/next",
      "dev",
      "-H",
      "127.0.0.1",
      "-p",
      "3000",
    ])
    expect(web.env).toEqual({ EIDO_TAILNET_HOST: HOST })
    expect(web.healthUrl).toBe("http://127.0.0.1:3000/healthz")
  })

  it("runs no watchers and next start in prod mode", () => {
    const config = buildStackConfig(input({ mode: "prod" }))
    for (const spec of config.processes)
      expect(spec.args).not.toContain("--watch")
    expect(byName(config, "web").args[1]).toBe("start")
    expect(byName(config, "web").readyTimeoutMs).toBeLessThan(
      byName(buildStackConfig(input()), "web").readyTimeoutMs
    )
  })

  it("builds the URL and the serve-routes flags from the edge and backend ports", () => {
    const config = buildStackConfig(input())
    expect(config.url).toBe(`https://${HOST}:8443/`)
    expect(config.serveFlags).toEqual([
      "--port",
      "8443",
      "--web-port",
      "3000",
      "--core-port",
      "8789",
      "--gate-port",
      "8788",
    ])
  })

  it("takes overrides from the environment", () => {
    const config = buildStackConfig(
      input({
        env: {
          EIDO_TAILNET_HOST: "other.example.ts.net",
          EIDO_EDGE_PORT: "9443",
          EIDO_WEB_PORT: "3001",
          EIDO_CORE_PORT: "8791",
          EIDO_GATE_PHONE_PORT: "8790",
          EIDO_STACK_DIR: "/data",
          EIDO_STACK_LOG_DIR: "/logs",
          EIDO_WEBAUTHN_ORIGIN: "https://other.example.ts.net",
          EIDO_CORE_BASE_PATH: "/api/core",
        },
      })
    )
    expect(config.tailnetHost).toBe("other.example.ts.net")
    expect(config.ports).toEqual({ web: 3001, core: 8791, gate: 8790 })
    expect(config.runDir).toBe("/data/run")
    expect(config.logDir).toBe("/logs")
    expect(config.url).toBe("https://other.example.ts.net:9443/")
    const gate = byName(config, "gate")
    expect(gate.env["EIDO_WEBAUTHN_ORIGIN"]).toBe(
      "https://other.example.ts.net"
    )
    expect(gate.env["EIDO_GATE_PHONE_ALLOWED_HOSTS"]).toContain(
      "other.example.ts.net:9443"
    )
    expect(byName(config, "core").env["EIDO_CORE_BASE_PATH"]).toBe("/api/core")
    expect(byName(config, "web").args).toContain("3001")
  })

  it("treats an empty override as unset, except for base paths", () => {
    const config = buildStackConfig(
      input({ env: { EIDO_WEB_PORT: "", EIDO_GATE_PHONE_BASE_PATH: "" } })
    )
    expect(config.ports.web).toBe(3000)
    expect(byName(config, "gate").env["EIDO_GATE_PHONE_BASE_PATH"]).toBe("")
  })

  it("drops a default HTTPS port from the origin, as browsers do", () => {
    const gate = byName(
      buildStackConfig(input({ env: { EIDO_EDGE_PORT: "443" } })),
      "gate"
    )
    expect(gate.env["EIDO_WEBAUTHN_ORIGIN"]).toBe(`https://${HOST}`)
  })

  it("refuses a host that is not a host name", () => {
    expect(() =>
      buildStackConfig(input({ tailnetHost: "evil.ts.net/x" }))
    ).toThrow(/must be a host name/)
  })

  it("refuses a bad or repeated port", () => {
    expect(() =>
      buildStackConfig(input({ env: { EIDO_WEB_PORT: "abc" } }))
    ).toThrow(/EIDO_WEB_PORT/)
    expect(() =>
      buildStackConfig(input({ env: { EIDO_WEB_PORT: "8788" } }))
    ).toThrow(/must differ/)
  })
})
