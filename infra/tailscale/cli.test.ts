import { readFileSync } from "node:fs"
import { request } from "node:http"
import { describe, expect, it } from "vitest"

import { main, type Deps, type RunResult } from "./cli.ts"
import type { Fetch } from "./measure.ts"
import { parseServeConfig, type ServeConfig } from "./serve-routes.ts"

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" })

/** A stand-in for the tailscale CLI that keeps a serve config and applies `serve --bg` to it. */
function fakeTailscale(
  initial: ServeConfig,
  options: { failOn?: string } = {}
) {
  const state: ServeConfig = structuredClone(initial)
  const calls: string[][] = []
  const tailscale = (args: readonly string[]): Promise<RunResult> => {
    calls.push([...args])
    const line = args.join(" ")
    if (options.failOn !== undefined && line.includes(options.failOn))
      return Promise.resolve({ code: 1, stdout: "", stderr: "boom" })
    if (line === "serve status --json" || line === "funnel status --json")
      return Promise.resolve(ok(JSON.stringify(state)))
    if (line === "status --json") return Promise.resolve(ok(fixture("status")))
    const [, bg, https, setPath, target] = args
    if (args[0] === "serve" && bg === "--bg" && https && setPath && target) {
      const port = https.replace("--https=", "")
      const path = setPath.replace("--set-path=", "")
      state.TCP = { ...state.TCP, [port]: { HTTPS: true } }
      const key = `node.example.ts.net:${port}`
      const web = (state.Web ??= {})
      const handlers = ((web[key] ??= {}).Handlers ??= {})
      handlers[path] = { Proxy: target }
      return Promise.resolve(ok())
    }
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `unexpected: ${line}`,
    })
  }
  return { state, calls, tailscale }
}

function deps(
  tailscale: Deps["tailscale"],
  fetch: Fetch = () => Promise.reject(new Error("no fetch"))
) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    deps: {
      tailscale,
      fetch,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    },
  }
}

const writes = (calls: string[][]) => calls.filter((c) => !c.includes("status"))

describe("plan", () => {
  it("prints the three commands and runs nothing", async () => {
    const fake = fakeTailscale({})
    const run = deps(fake.tailscale)
    expect(await main(["plan"], run.deps)).toBe(0)
    expect(run.out).toEqual([
      "tailscale serve --bg --https=8443 --set-path=/ http://127.0.0.1:3000",
      "tailscale serve --bg --https=8443 --set-path=/api/core http://127.0.0.1:8787",
      "tailscale serve --bg --https=8443 --set-path=/api/gate http://127.0.0.1:8788",
    ])
    expect(fake.calls).toEqual([])
  })
})

describe("check", () => {
  it("passes with the Eido routes beside another app on 443, reading only", async () => {
    const fake = fakeTailscale(parseServeConfig(fixture("eido-with-other-app")))
    const run = deps(fake.tailscale)
    expect(await main(["check"], run.deps)).toBe(0)
    expect(writes(fake.calls)).toEqual([])
    expect(run.out.at(-1)).toBe(
      "ok: exactly the three Eido routes on port 8443; funnel is off for it"
    )
    expect(run.out[0]).toBe(
      "warning: funnel is on for another port (443); left alone"
    )
  })

  it("fails on an extra route", async () => {
    const run = deps(
      fakeTailscale(parseServeConfig(fixture("extra-route"))).tailscale
    )
    expect(await main(["check"], run.deps)).toBe(1)
    expect(run.err).toEqual(["FAIL: unexpected route /admin on port 8443"])
  })

  it("fails when funnel status shows Eido's port funnelled", async () => {
    const run = deps(
      fakeTailscale(parseServeConfig(fixture("funnel-on"))).tailscale
    )
    expect(await main(["check"], run.deps)).toBe(1)
    expect(run.err).toEqual(["FAIL: funnel is on for port 8443"])
  })

  it("fails when tailscale itself fails", async () => {
    const run = deps(fakeTailscale({}, { failOn: "funnel status" }).tailscale)
    expect(await main(["check"], run.deps)).toBe(1)
    expect(run.err).toEqual([
      "FAIL: tailscale funnel status --json failed: boom",
    ])
  })
})

describe("apply", () => {
  it("adds the three routes on 8443 and leaves the other app's 443 route alone", async () => {
    const initial = parseServeConfig(fixture("other-app-only"))
    const fake = fakeTailscale(initial)
    const run = deps(fake.tailscale)
    expect(await main(["apply"], run.deps)).toBe(0)
    expect(writes(fake.calls).every((c) => c.includes("--https=8443"))).toBe(
      true
    )
    expect(writes(fake.calls)).toHaveLength(3)
    expect(fake.state.TCP?.["443"]).toEqual(initial.TCP?.["443"])
    expect(fake.state.Web?.["node.example.ts.net:443"]).toEqual(
      initial.Web?.["node.example.ts.net:443"]
    )
    const expected = parseServeConfig(fixture("eido-with-other-app"))
    delete expected.AllowFunnel
    expect(fake.state).toEqual(expected)
  })

  it("changes nothing when Eido's port holds a route it does not own", async () => {
    const fake = fakeTailscale(parseServeConfig(fixture("extra-route")))
    const run = deps(fake.tailscale)
    expect(await main(["apply"], run.deps)).toBe(1)
    expect(writes(fake.calls)).toEqual([])
    expect(run.err.at(-1)).toContain("Nothing was changed")
  })

  it("changes nothing when funnel is on for Eido's port", async () => {
    const fake = fakeTailscale(parseServeConfig(fixture("funnel-on")))
    const run = deps(fake.tailscale)
    expect(await main(["apply"], run.deps)).toBe(1)
    expect(writes(fake.calls)).toEqual([])
  })

  it("stops at the first failing serve command", async () => {
    const fake = fakeTailscale({}, { failOn: "--set-path=/api/core" })
    const run = deps(fake.tailscale)
    expect(await main(["apply"], run.deps)).toBe(1)
    expect(writes(fake.calls)).toHaveLength(2)
    expect(run.err.at(-1)).toContain(
      "FAIL: tailscale serve --bg --https=8443 --set-path=/api/core"
    )
  })

  it("uses the port flag for every command", async () => {
    const fake = fakeTailscale({})
    expect(
      await main(["apply", "--port=10443"], deps(fake.tailscale).deps)
    ).toBe(0)
    expect(writes(fake.calls).map((c) => c[2])).toEqual([
      "--https=10443",
      "--https=10443",
      "--https=10443",
    ])
  })
})

/** Emulates serve: forwards an origin URL to the echo server for its route, optionally stripping the prefix. */
function serveFetch(
  strip: boolean,
  ports: () => Record<string, number>
): Fetch {
  return (url) => {
    const { pathname, search, host } = new URL(url)
    const mount = pathname.startsWith("/api/core")
      ? "/api/core"
      : pathname.startsWith("/api/gate")
        ? "/api/gate"
        : "/"
    const port = { "/": 3000, "/api/core": 8787, "/api/gate": 8788 }[mount]
    const forwarded =
      strip && mount !== "/" ? pathname.slice(mount.length) || "/" : pathname
    return new Promise((resolve, reject) => {
      const req = request(
        {
          agent: false,
          host: "127.0.0.1",
          port: ports()[String(port)] ?? port,
          path: forwarded + search,
          headers: { host, "tailscale-user-login": "someone@example.com" },
        },
        (res) => {
          let body = ""
          res.on("data", (chunk: Buffer) => (body += chunk.toString()))
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              text: () => Promise.resolve(body),
            })
          )
        }
      )
      req.on("error", reject)
      req.end()
    })
  }
}

describe("measure", () => {
  const applied = () => fakeTailscale(parseServeConfig(fixture("eido-only")))
  // Free high ports for the echo servers, so the test never needs 3000, 8787 or 8788.
  const flags = ["--web-port=39300", "--core-port=39301", "--gate-port=39302"]
  const ports = () => ({ "3000": 39300, "8787": 39301, "8788": 39302 })
  const withPorts = (fake: ReturnType<typeof applied>) => {
    const handlers =
      fake.state.Web?.["node.example.ts.net:8443"]?.Handlers ?? {}
    handlers["/"] = { Proxy: "http://127.0.0.1:39300" }
    handlers["/api/core"] = { Proxy: "http://127.0.0.1:39301" }
    handlers["/api/gate"] = { Proxy: "http://127.0.0.1:39302" }
    return fake
  }

  it("reports the path and Host each backend saw, without the node's name", async () => {
    const run = deps(withPorts(applied()).tailscale, serveFetch(true, ports))
    expect(await main(["measure", ...flags], run.deps)).toBe(0)
    const table = run.out.filter((l) => l.startsWith("| `"))
    expect(table).toEqual([
      "| `/eido-probe?q=1` | web | `/eido-probe?q=1` | `<host>:8443` | present |",
      "| `/api/core/profile?q=1` | core | `/profile?q=1` | `<host>:8443` | present |",
      "| `/api/gate/passkey/status` | gate | `/passkey/status` | `<host>:8443` | present |",
    ])
    expect(run.out.join("\n")).not.toContain("example.ts.net")
  })

  it("shows an unstripped prefix as it arrives", async () => {
    const run = deps(withPorts(applied()).tailscale, serveFetch(false, ports))
    const code = await main(["measure", ...flags], run.deps)
    expect(code).toBe(0)
    expect(run.out).toContain(
      "| `/api/core/profile?q=1` | core | `/api/core/profile?q=1` | `<host>:8443` | present |"
    )
  })

  it("refuses to measure before the routes are applied", async () => {
    const fake = fakeTailscale({})
    const run = deps(fake.tailscale)
    expect(await main(["measure"], run.deps)).toBe(1)
    expect(run.err.at(-1)).toBe("Apply the routes before measuring.")
    expect(fake.calls.some((c) => c[0] === "status")).toBe(false)
  })

  it("exits 1 when a probe fails", async () => {
    const run = deps(withPorts(applied()).tailscale, () =>
      Promise.reject(new Error("offline"))
    )
    expect(await main(["measure", ...flags], run.deps)).toBe(1)
    expect(run.out.filter((l) => l.includes("request failed"))).toHaveLength(3)
  })
})

describe("arguments", () => {
  it.each([[[]], [["reset"]]])("prints usage for %j", async (argv) => {
    const run = deps(fakeTailscale({}).tailscale)
    expect(await main(argv, run.deps)).toBe(2)
    expect(run.err[0]).toContain("usage:")
  })

  it("prints the flag error and usage for a bad flag", async () => {
    const run = deps(fakeTailscale({}).tailscale)
    expect(await main(["check", "--port=x"], run.deps)).toBe(2)
    expect(run.err[0]).toContain("--port must be a port number")
  })
})
