import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  applyCommands,
  blockingProblems,
  checkServeConfig,
  DEFAULT_CORE_PORT,
  DEFAULT_EIDO_PORT,
  parseDnsName,
  parseEdgeConfig,
  parseServeConfig,
  routesFor,
} from "./serve-routes.ts"

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const defaults = parseEdgeConfig([])
const check = (name: string) =>
  checkServeConfig(parseServeConfig(fixture(name)), defaults)

describe("parseEdgeConfig", () => {
  it("defaults to Eido's own port 8443 and the backends' default ports", () => {
    expect(defaults).toEqual({
      port: 8443,
      webPort: 3000,
      corePort: 8789,
      gatePort: 8788,
    })
    expect(DEFAULT_EIDO_PORT).toBe(8443)
  })

  it("reads --flag=N and --flag N", () => {
    expect(
      parseEdgeConfig([
        "--port=10443",
        "--core-port",
        "9787",
        "--gate-port=9788",
        "--web-port",
        "4000",
      ])
    ).toEqual({
      port: 10443,
      webPort: 4000,
      corePort: 9787,
      gatePort: 9788,
    })
  })

  it.each([
    [["--port=0"], "--port must be a port number"],
    [["--port=65536"], "--port must be a port number"],
    [["--core-port=abc"], "--core-port must be a port number"],
    [["--gate-port"], "--gate-port needs a value"],
    [["--other=1"], "unknown argument"],
    [["--core-port=3000"], "must differ"],
  ])("refuses %j", (args, message) => {
    expect(() => parseEdgeConfig(args)).toThrow(message)
  })
})

describe("applyCommands", () => {
  it("adds exactly the three routes on Eido's port, in the background, to loopback targets", () => {
    expect(applyCommands(defaults)).toEqual([
      [
        "serve",
        "--bg",
        "--https=8443",
        "--set-path=/",
        "http://127.0.0.1:3000",
      ],
      [
        "serve",
        "--bg",
        "--https=8443",
        "--set-path=/api/core",
        "http://127.0.0.1:8789",
      ],
      [
        "serve",
        "--bg",
        "--https=8443",
        "--set-path=/api/gate",
        "http://127.0.0.1:8788",
      ],
    ])
  })

  it("never names a gate admin or enrolment route", () => {
    const paths = routesFor(defaults).map((route) => route.path)
    expect(paths).toEqual(["/", "/api/core", "/api/gate"])
    for (const route of routesFor(defaults))
      expect(route.target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})

describe("parseServeConfig", () => {
  it("treats empty output as an empty config", () => {
    expect(parseServeConfig("")).toEqual({})
    expect(parseServeConfig("{}\n")).toEqual({})
  })

  it.each([
    ["not json", "not JSON"],
    ["[]", "not a JSON object"],
    ['{"Web": []}', "malformed Web"],
    ['{"TCP": 1}', "malformed TCP"],
  ])("refuses %s", (text, message) => {
    expect(() => parseServeConfig(text)).toThrow(message)
  })
})

describe("checkServeConfig", () => {
  it("passes with exactly the three routes on 8443", () => {
    expect(check("eido-only")).toEqual({ problems: [], warnings: [] })
  })

  it("ignores another app's route on 443 and only warns about its funnel", () => {
    const result = check("eido-with-other-app")
    expect(result.problems).toEqual([])
    expect(result.warnings).toEqual([
      "funnel is on for another port (443); left alone",
    ])
    expect(result.warnings.join()).not.toContain("example.ts.net")
  })

  it("reports every route as missing when only another app is served", () => {
    const result = check("other-app-only")
    expect(result.problems.map((p) => p.kind)).toEqual([
      "missing",
      "missing",
      "missing",
      "missing",
    ])
    expect(blockingProblems(result)).toEqual([])
  })

  it("fails on any other route on Eido's port, and apply cannot fix it", () => {
    const result = check("extra-route")
    expect(result.problems).toEqual([
      { kind: "foreign", message: "unexpected route /admin on port 8443" },
    ])
    expect(blockingProblems(result)).toHaveLength(1)
  })

  it("fails when funnel is on for Eido's port", () => {
    const result = check("funnel-on")
    expect(result.problems).toEqual([
      { kind: "funnel", message: "funnel is on for port 8443" },
    ])
    expect(blockingProblems(result)).toHaveLength(1)
  })

  it("ignores a funnel entry that is off", () => {
    const serve = parseServeConfig(fixture("funnel-on"))
    serve.AllowFunnel = { "node.example.ts.net:8443": false }
    expect(checkServeConfig(serve, defaults).problems).toEqual([])
  })

  it("reports a route that points elsewhere or serves files as a wrong target", () => {
    const serve = parseServeConfig(fixture("eido-only"))
    const handlers = serve.Web?.["node.example.ts.net:8443"]?.Handlers ?? {}
    handlers["/api/core"] = { Proxy: "http://127.0.0.1:9999" }
    handlers["/api/gate"] = { Path: "/tmp" }
    const result = checkServeConfig(serve, defaults)
    expect(
      result.problems.map((p) => [p.kind, p.message.split(" ")[0]])
    ).toEqual([
      ["wrong-target", "/api/core"],
      ["wrong-target", "/api/gate"],
    ])
    expect(blockingProblems(result)).toEqual([])
  })

  it("fails when Eido's port is a TCP forwarder or plain HTTP", () => {
    for (const tcp of [
      { TCPForward: "127.0.0.1:22" },
      { HTTP: true },
      { HTTPS: true, TCPForward: "x" },
    ]) {
      const serve = parseServeConfig(fixture("eido-only"))
      serve.TCP = { "8443": tcp }
      expect(
        blockingProblems(checkServeConfig(serve, defaults))[0]?.message
      ).toContain("not a plain HTTPS serve port")
    }
  })

  it("fails when Eido's port is served for two names", () => {
    const serve = parseServeConfig(fixture("eido-only"))
    serve.Web = { ...serve.Web, "other.example.ts.net:8443": { Handlers: {} } }
    expect(
      blockingProblems(checkServeConfig(serve, defaults))[0]?.message
    ).toContain("more than one name")
  })

  it("fails when a foreground serve session holds Eido's port, not another one", () => {
    const serve = parseServeConfig(fixture("eido-only"))
    serve.Foreground = {
      a: { TCP: { "443": { HTTPS: true } } },
      b: { Web: { "node.example.ts.net:8443": {} } },
    }
    expect(checkServeConfig(serve, defaults).problems).toEqual([
      {
        kind: "foreign",
        message: "a foreground serve session (b) uses port 8443",
      },
    ])
  })

  it("checks a non-default Eido port and then treats 8443 as another app's", () => {
    const config = parseEdgeConfig(["--port=10443"])
    const result = checkServeConfig(
      parseServeConfig(fixture("extra-route")),
      config
    )
    expect(result.problems.every((p) => p.kind === "missing")).toBe(true)
  })
})

describe("parseDnsName", () => {
  it("reads Self.DNSName without the trailing dot", () => {
    expect(parseDnsName(fixture("status"))).toBe("node.example.ts.net")
  })

  it.each([
    ["nope", "not JSON"],
    ["{}", "no Self.DNSName"],
    ['{"Self":{"DNSName":""}}', "no Self.DNSName"],
  ])("refuses %s", (text, message) => {
    expect(() => parseDnsName(text)).toThrow(message)
  })
})

describe("DEFAULT_CORE_PORT", () => {
  it("is core's default, 8789, not 8787 which another app on the host uses", () => {
    expect(DEFAULT_CORE_PORT).toBe(8789)
  })
})
