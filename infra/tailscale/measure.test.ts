import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"

import { probe, report, startEchoServers, type Seen } from "./measure.ts"

describe("startEchoServers", () => {
  it("binds loopback and echoes path, Host and whether Tailscale-User-Login arrived", async () => {
    const echo = await startEchoServers([
      { name: "core", path: "/api/core", target: "http://127.0.0.1:0" },
    ])
    try {
      const response = await fetch(
        `http://127.0.0.1:${echo.ports.core}/profile?q=1`
      )
      expect(await response.json()).toEqual({
        backend: "core",
        path: "/profile?q=1",
        host: `127.0.0.1:${echo.ports.core}`,
        userLogin: false,
      })
    } finally {
      await echo.close()
    }
  })

  it("says to stop the backends when a target port is taken, and frees what it opened", async () => {
    const taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve))
    const port = (taken.address() as AddressInfo).port
    try {
      await expect(
        startEchoServers([
          { name: "web", path: "/", target: "http://127.0.0.1:0" },
          {
            name: "core",
            path: "/api/core",
            target: `http://127.0.0.1:${port}`,
          },
        ])
      ).rejects.toThrow("stop Next, core and the gate before measuring")
    } finally {
      await new Promise((resolve) => taken.close(resolve))
    }
  })

  it("reports any other start failure", async () => {
    await expect(
      startEchoServers([{ name: "web", path: "/", target: "not a url" }])
    ).rejects.toThrow("could not start the echo servers")
  })
})

describe("probe and report", () => {
  it("records a non-200 reply and a misrouted request", async () => {
    const seen: Seen = {
      backend: "web",
      path: "/api/core/profile?q=1",
      host: "node.example.ts.net:8443",
      userLogin: false,
    }
    const replies = [
      { status: 502, text: () => Promise.resolve("bad gateway") },
      { status: 200, text: () => Promise.resolve(JSON.stringify(seen)) },
    ]
    let i = 0
    const results = await probe("https://node.example.ts.net:8443", () =>
      Promise.resolve(replies[Math.min(i++, 1)]!)
    )
    expect(results[0]).toBe("HTTP 502")
    const lines = report(results, "node.example.ts.net", 8443)
    expect(lines[0]).toBe(
      "Measured through https://<host>:8443 with echo servers on the route targets:"
    )
    expect(lines).toContain("| `/eido-probe?q=1` | HTTP 502 | | | |")
    expect(lines).toContain(
      "| `/api/core/profile?q=1` | web (expected core) | `/api/core/profile?q=1` | `<host>:8443` | absent |"
    )
  })

  it("marks a missing result", () => {
    expect(report([], "node.example.ts.net", 8443)).toContain(
      "| `/eido-probe?q=1` | no result | | | |"
    )
  })
})
