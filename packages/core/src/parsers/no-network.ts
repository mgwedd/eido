import dgram from "node:dgram"
import dns from "node:dns"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"
import tls from "node:tls"

// Preloaded into every parse child (`node --import`): makes Node's network entry points throw,
// so parser code cannot open a connection or resolve a name even if a hostile file subverts it.
// Defense in depth only; the boundary is the OS-level rule (#70), checked live by #56.

export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super(`network access is blocked in the parser process (${what})`)
    this.name = "NetworkBlockedError"
  }
}

// A plain function, not an arrow, so `new WebSocket(...)` throws this error too.
function blocked(what: string): () => never {
  return function blockedCall(): never {
    throw new NetworkBlockedError(what)
  }
}

/** Replaces each named function on `target` with one that throws. */
function block(target: object, label: string, names: readonly string[]): void {
  for (const name of names) {
    Object.defineProperty(target, name, {
      value: blocked(`${label}.${name}`),
      writable: false,
      configurable: false,
    })
  }
}

const DNS_CALLS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
] as const

export function blockNetwork(): void {
  // The default imports are the built-ins' own module objects, so patching them reaches every
  // `require` of the module as well.
  block(globalThis, "globalThis", ["fetch", "WebSocket", "EventSource"])
  block(net, "net", ["connect", "createConnection"])
  block(net.Socket.prototype, "net.Socket", ["connect"])
  block(tls, "tls", ["connect"])
  block(http, "http", ["request", "get"])
  block(https, "https", ["request", "get"])
  block(http2, "http2", ["connect"])
  block(dgram, "dgram", ["createSocket"])
  block(dns, "dns", DNS_CALLS)
  block(dns.promises, "dns.promises", DNS_CALLS)
  block(dns.Resolver.prototype, "dns.Resolver", DNS_CALLS)
  block(dns.promises.Resolver.prototype, "dns.promises.Resolver", DNS_CALLS)
  // ES module imports of the built-ins (`import { connect } from "node:net"`) see the change too.
  syncBuiltinESMExports()
}

blockNetwork()
