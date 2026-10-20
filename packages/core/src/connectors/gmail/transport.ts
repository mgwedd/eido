import { GmailError } from "./errors"
import { GMAIL_CONNECTOR } from "./routes"

/**
 * One read request to Gmail. Core only ever reads: the type has no other method, no headers and no
 * body, so no caller can attach a credential or send a write through it.
 */
export type GmailRequest = Readonly<{ method: "GET"; url: string }>

/** A `fetch`-style transport. Sync passes the gate's egress proxy; tests pass a fake. */
export type GmailTransport = (request: GmailRequest) => Promise<Response>

export type EgressTransportOptions = {
  /** Base URL of the gate's egress proxy (#14). */
  proxyUrl: string
  fetch?: typeof fetch
}

/**
 * Sends each read through the gate's egress proxy, which checks the pinned route, injects the read
 * client's token and forwards it. Core holds no token: the request carries only the target.
 */
export function createEgressTransport(
  options: EgressTransportOptions
): GmailTransport {
  const send = options.fetch ?? fetch
  const endpoint = new URL("/", options.proxyUrl).href
  return async (request) => {
    try {
      return await send(endpoint, {
        method: request.method,
        headers: {
          "x-eido-connector": GMAIL_CONNECTOR,
          "x-eido-target": request.url,
        },
        redirect: "manual",
      })
    } catch {
      throw new GmailError(
        "gate_unavailable",
        "the gate's egress proxy could not be reached"
      )
    }
  }
}
