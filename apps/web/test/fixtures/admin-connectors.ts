// Synthetic fixtures for the Admin Connectors page. Imported by tests only; never by app code
// (enforced by the `web-test-fixtures-are-test-only` rule in .dependency-cruiser.mts).
import { createHash } from "node:crypto"
import type { GateConnectorSettings, GateControlPrepared } from "@eido/schemas"

type Connector = GateConnectorSettings["connectors"][number]

const base = {
  enabled: true,
  pinnedAt: "2026-10-01T09:00:00.000Z",
  health: "healthy",
  consecutiveFailures: 0,
  manifestHash:
    "3c9a1f0b7d52e8a4c6b1093de5f7a2c84b61d09e3a7f5c2b8d4e6a10f9c7b3e1",
} as const satisfies Partial<Connector>

export const gmail: Connector = {
  ...base,
  name: "gmail",
  scopes: [
    "https://scopes.example.invalid/gmail.readonly",
    "https://scopes.example.invalid/gmail.modify",
  ],
}
export const drive: Connector = {
  ...base,
  name: "drive",
  scopes: ["https://scopes.example.invalid/drive.readonly"],
}
export const protonMail: Connector = {
  ...base,
  name: "proton-mail",
  scopes: [],
}
export const gmailDegraded: Connector = {
  ...gmail,
  health: "degraded",
  consecutiveFailures: 2,
}
export const driveDisabled: Connector = { ...drive, enabled: false }

/** A 64-hex certificate pin, and a second one for a change. */
export const PIN = "ab12".repeat(16)
export const OTHER_PIN = "cd34".repeat(16)

const NONCE = "N".repeat(43)
const ID = "control-1"

/**
 * A control ceremony as the gate prepares it, built here with node:crypto from the spec: the
 * payload is the key-sorted JSON text (already its RFC 8785 form for string values), the hash is
 * SHA-256 of it, and the challenge is SHA-256 over the `eido.control.v1` array, base64url.
 */
export function controlPrepared(
  target: string,
  payload: Record<string, string>
): GateControlPrepared {
  const text = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1))
    )
  )
  const payloadHash = createHash("sha256").update(text).digest("hex")
  const challenge = createHash("sha256")
    .update(
      JSON.stringify([
        "eido.control.v1",
        "policy.set",
        target,
        ID,
        payloadHash,
        NONCE,
      ])
    )
    .digest("base64url")
  return {
    id: ID,
    purpose: "policy.set",
    target,
    payload: text,
    payloadHash,
    nonce: NONCE,
    challenge,
  }
}

export const bridgePrepared = (pin: string) =>
  controlPrepared("connector_secret:proton-mail", {
    action: "connector.secret.set",
    connector: "proton-mail",
    certificateSha256: pin,
  })
export const pinPrepared = (pin: string) =>
  controlPrepared("connector_pin:proton-mail", {
    action: "connector.pin.set",
    connector: "proton-mail",
    certificateSha256: pin,
  })
export const simplefinPrepared = controlPrepared("connector_secret:simplefin", {
  action: "connector.secret.set",
  connector: "simplefin",
})

export const GOOGLE_CLIENT_ID = "client-1.apps.example.invalid"
export const googlePrepared = (
  target: "gmail" | "gmail-read" | "drive",
  connector: string,
  client: string,
  clientId = GOOGLE_CLIENT_ID
) =>
  controlPrepared(`connector_oauth:${target}`, {
    action: "connector.oauth.start",
    connector,
    client,
    clientId,
  })

export const GOOGLE_URL = "https://accounts.google.com/o/oauth2/v2/auth?state=s"
export const FLOW = "F".repeat(43)

/** What a sealed secret answers: the health of the connectors it feeds. */
export const sealedHealth = {
  connectors: [
    { name: "proton-mail", health: "healthy", consecutiveFailures: 0 },
  ],
}

export type Call = { path: string; method: string; body: unknown }

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/**
 * A fake gate: `routes` maps "METHOD /path" (below /api/gate) to its answer. Every call is
 * recorded with its parsed JSON body; a route that is not listed answers 404.
 */
export function fakeGate(
  routes: Record<string, (call: Call) => Response | Promise<Response>>
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = (
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : input.url
    ).replace(/^\/api\/gate/, "")
    const method = init?.method ?? "GET"
    const call: Call = {
      path,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const route = routes[`${method} ${path}`]
    return route === undefined ? json(404, {}) : route(call)
  }
  return { fetch: impl, calls }
}
