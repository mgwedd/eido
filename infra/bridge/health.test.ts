import { createServer, type Server } from "node:net"
import { afterEach, describe, expect, it } from "vitest"

import {
  endpointFromEnv,
  isGreeting,
  probe,
  readGreetingOverTcp,
  type ReadGreeting,
} from "./health.ts"

const env = {
  EIDO_BRIDGE_HOST: "127.0.0.1",
  EIDO_BRIDGE_IMAP_PORT: "2143",
  EIDO_BRIDGE_SMTP_PORT: "2025",
}

describe("endpointFromEnv", () => {
  it("reads host and both ports from the gate's variables", () => {
    expect(endpointFromEnv(env)).toEqual({
      host: "127.0.0.1",
      imapPort: 2143,
      smtpPort: 2025,
    })
  })
  it("refuses a non-loopback host", () => {
    expect(() =>
      endpointFromEnv({ ...env, EIDO_BRIDGE_HOST: "mail.example.com" })
    ).toThrow("EIDO_BRIDGE_HOST must be one of")
  })
  it("refuses a missing port instead of defaulting to 1143", () => {
    expect(() =>
      endpointFromEnv({ ...env, EIDO_BRIDGE_IMAP_PORT: undefined })
    ).toThrow("EIDO_BRIDGE_IMAP_PORT must be a port number")
  })
  it("refuses an out-of-range port", () => {
    expect(() =>
      endpointFromEnv({ ...env, EIDO_BRIDGE_SMTP_PORT: "70000" })
    ).toThrow("EIDO_BRIDGE_SMTP_PORT")
  })
})

describe("isGreeting", () => {
  it("accepts the IMAP and SMTP greetings", () => {
    expect(
      isGreeting("imap", "* OK IMAP4rev1 Proton Mail Bridge ready\r\n")
    ).toBe(true)
    expect(isGreeting("smtp", "220 127.0.0.1 ESMTP Service Ready\r\n")).toBe(
      true
    )
  })
  it("rejects the other protocol's greeting and an IMAP BYE", () => {
    expect(isGreeting("imap", "220 ready\r\n")).toBe(false)
    expect(isGreeting("smtp", "* OK ready\r\n")).toBe(false)
    expect(isGreeting("imap", "* BYE going away\r\n")).toBe(false)
  })
})

describe("probe", () => {
  const endpoint = {
    host: "127.0.0.1",
    imapPort: 2143,
    smtpPort: 2025,
  } as const

  it("reports each port ok when both greet", async () => {
    const read: ReadGreeting = (_h, port) =>
      Promise.resolve(port === 2143 ? "* OK ready\r\n" : "220 ready\r\n")
    expect(await probe(endpoint, read)).toEqual([
      { protocol: "imap", port: 2143 },
      { protocol: "smtp", port: 2025 },
    ])
  })

  it("names the failing protocol only", async () => {
    const read: ReadGreeting = (_h, port) =>
      port === 2143
        ? Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:2143"))
        : Promise.resolve("220 ready\r\n")
    const results = await probe(endpoint, read)
    expect(results[0]).toEqual({
      protocol: "imap",
      port: 2143,
      error: "connect ECONNREFUSED 127.0.0.1:2143",
    })
    expect(results[1]).toEqual({ protocol: "smtp", port: 2025 })
  })

  it("fails a wrong greeting", async () => {
    const results = await probe(endpoint, () => Promise.resolve("garbage"))
    expect(
      results.every((r) => r.error?.startsWith("unexpected greeting"))
    ).toBe(true)
  })
})

describe("readGreetingOverTcp", () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })
  const listen = (onConnection: Parameters<typeof createServer>[1]) =>
    new Promise<number>((resolve) => {
      const server = createServer(onConnection)
      servers.push(server)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        resolve(
          typeof address === "object" && address !== null ? address.port : 0
        )
      })
    })

  it("returns what the server sends first", async () => {
    const port = await listen((socket) => socket.end("* OK hi\r\n"))
    expect(await readGreetingOverTcp("127.0.0.1", port, 1000)).toBe(
      "* OK hi\r\n"
    )
  })
  it("rejects when the server closes without a greeting", async () => {
    const port = await listen((socket) => socket.end())
    await expect(readGreetingOverTcp("127.0.0.1", port, 1000)).rejects.toThrow(
      "closed before a greeting"
    )
  })
  it("rejects when nothing greets in time", async () => {
    const port = await listen(() => {})
    await expect(readGreetingOverTcp("127.0.0.1", port, 50)).rejects.toThrow(
      "no greeting within 50 ms"
    )
  })
  it("rejects when nothing listens", async () => {
    const port = await listen(() => {})
    for (const server of servers.splice(0))
      await new Promise((r) => server.close(r))
    await expect(readGreetingOverTcp("127.0.0.1", port, 1000)).rejects.toThrow(
      "ECONNREFUSED"
    )
  })
})
