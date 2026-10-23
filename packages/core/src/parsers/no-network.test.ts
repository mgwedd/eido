import dgram from "node:dgram"
import dns from "node:dns"
import { lookup } from "node:dns/promises"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import net, { connect } from "node:net"
import tls from "node:tls"
import { describe, expect, it } from "vitest"
import { NetworkBlockedError } from "./no-network"

// Importing the module patches this test worker's own built-ins, as the preload does in a child.

describe("the no-network preload", () => {
  it.each([
    ["fetch", () => fetch("http://127.0.0.1:9/")],
    ["WebSocket", () => new WebSocket("ws://127.0.0.1:9/")],
    ["net.connect", () => net.connect(9, "127.0.0.1")],
    ["net.createConnection", () => net.createConnection(9, "127.0.0.1")],
    ["an ESM import of net.connect", () => connect(9, "127.0.0.1")],
    ["net.Socket#connect", () => new net.Socket().connect(9, "127.0.0.1")],
    ["tls.connect", () => tls.connect(9, "127.0.0.1")],
    ["http.request", () => http.request("http://127.0.0.1:9/")],
    ["http.get", () => http.get("http://127.0.0.1:9/")],
    ["https.request", () => https.request("https://127.0.0.1:9/")],
    ["http2.connect", () => http2.connect("http://127.0.0.1:9")],
    ["dgram.createSocket", () => dgram.createSocket("udp4")],
    ["dns.lookup", () => dns.lookup("example.invalid", () => undefined)],
    ["dns.resolve4", () => dns.resolve4("example.invalid", () => undefined)],
    ["dns.promises.lookup", () => lookup("example.invalid")],
    [
      "a dns.Resolver",
      () => new dns.Resolver().resolve("example.invalid", () => undefined),
    ],
    [
      "a dns.promises.Resolver",
      () => new dns.promises.Resolver().resolveTxt("example.invalid"),
    ],
  ])("blocks %s", (_, call) => {
    expect(call).toThrow(NetworkBlockedError)
  })

  it("cannot be undone by reassigning", () => {
    expect(() => {
      Object.defineProperty(net, "connect", { value: () => "open" })
    }).toThrow(TypeError)
  })
})
