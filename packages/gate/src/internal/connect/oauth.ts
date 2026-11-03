import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

// OAuth 2.0 for native apps (RFC 8252) for the Mac-side `connect` command (#98): an
// authorization request with PKCE S256 (RFC 7636) and a `state` value, a loopback redirect to
// 127.0.0.1 on an ephemeral port, and the code exchange at Google's token endpoint. The listener
// binds 127.0.0.1 only, takes one callback, then closes; it also closes when the timeout passes.
// Nothing here prints, logs or stores a token: the caller gets the refresh token back and writes
// it to the vault.

export const GOOGLE_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
/** The compose client's scope: the gate's Gmail writes and the profile read its probe makes. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify"
/** The Gmail read client's scope: the reads core makes through the gate's egress proxy. */
export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly"
/** The Drive read client's scope: the reads core makes through the gate's egress proxy. */
export const DRIVE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly"

export const CALLBACK_PATH = "/oauth2callback"
const LOOPBACK = "127.0.0.1"
/** OAuth error codes are short ASCII words; anything else is shown as `invalid_callback`. */
const ERROR_CODE = /^[a-z_]{1,64}$/

export type Pkce = { verifier: string; challenge: string }

/** A fresh PKCE pair: 32 random bytes as the verifier (43 characters), its SHA-256 as the challenge. */
export function pkcePair(): Pkce {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/** A fresh `state` value, compared on the callback to bind it to this request. */
export function oauthState(): string {
  return randomBytes(32).toString("base64url")
}

export type AuthorizationRequest = {
  clientId: string
  redirectUri: string
  scope: string
  state: string
  challenge: string
}

/**
 * The browser URL. `access_type=offline` asks for a refresh token and `prompt=consent` makes
 * Google issue a new one on a reconnect, where it would otherwise omit it.
 */
export function authorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: "code",
    scope: request.scope,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString()
  return url.toString()
}

export type CallbackResult =
  | { ok: true; code: string }
  | {
      ok: false
      reason:
        | "state_mismatch"
        | "authorization_denied"
        | "invalid_callback"
        | "timeout"
      /** The OAuth `error` code Google sent with a denied authorization. */
      error?: string
    }

export type Loopback = {
  redirectUri: string
  /** Settles once: on the one callback, or when the timeout passes. The listener is closed by then. */
  result: Promise<CallbackResult>
}

function sameState(expected: string, actual: string | null): boolean {
  if (actual === null) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reply(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  })
  response.end(`${text}\n`)
}

function judge(
  request: IncomingMessage,
  expectedState: string
): CallbackResult {
  const query = new URL(request.url ?? "/", `http://${LOOPBACK}`).searchParams
  if (!sameState(expectedState, query.get("state")))
    return { ok: false, reason: "state_mismatch" }
  const error = query.get("error")
  if (error !== null)
    return {
      ok: false,
      reason: "authorization_denied",
      ...(ERROR_CODE.test(error) ? { error } : {}),
    }
  const code = query.get("code")
  if (code === null || code === "")
    return { ok: false, reason: "invalid_callback" }
  return { ok: true, code }
}

/**
 * Starts the loopback listener on 127.0.0.1 with an ephemeral port. Requests to another path,
 * with another method or with a Host other than the listen address are answered 404 or 421 and
 * do not count as the callback. The first request to the callback path settles the result,
 * whatever it carries, and closes the listener.
 */
export async function startLoopback(options: {
  state: string
  timeoutMs: number
}): Promise<Loopback> {
  let settle: (result: CallbackResult) => void = () => undefined
  const result = new Promise<CallbackResult>((resolve) => {
    settle = resolve
  })
  let settled = false
  let host = ""
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", `http://${LOOPBACK}`).pathname
    if (settled) return reply(response, 410, "This sign-in has finished.")
    if (request.headers.host !== host)
      return reply(response, 421, "Wrong host.")
    if (request.method !== "GET" || path !== CALLBACK_PATH)
      return reply(response, 404, "Not found.")
    const outcome = judge(request, options.state)
    reply(
      response,
      outcome.ok ? 200 : 400,
      outcome.ok
        ? "Eido received the sign-in. You can close this tab."
        : "Eido did not accept this sign-in. Return to the terminal."
    )
    finish(outcome)
  })
  const timer = setTimeout(
    () => finish({ ok: false, reason: "timeout" }),
    options.timeoutMs
  )
  function finish(outcome: CallbackResult): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close(() => settle(outcome))
    server.closeIdleConnections()
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  // listen() on a TCP host always reports an AddressInfo, never a pipe name or null.
  const port =
    typeof address === "object" && address !== null ? address.port : 0
  host = `${LOOPBACK}:${port}`
  return { redirectUri: `http://${host}${CALLBACK_PATH}`, result }
}

export type CodeExchange = {
  fetch: typeof fetch
  clientId: string
  clientSecret: string
  code: string
  verifier: string
  redirectUri: string
  scope: string
}

export type ExchangeResult =
  | { ok: true; refreshToken: string }
  | {
      ok: false
      reason:
        | "token_endpoint_unreachable"
        | "token_endpoint_refused"
        | "no_refresh_token"
        | "scope_not_granted"
      /** The OAuth `error` code the token endpoint returned, when it is a plain code. */
      error?: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Exchanges the authorization code with its PKCE verifier. Only the refresh token is returned;
 * the access token in the same answer is dropped, and no response text is passed on.
 */
export async function exchangeCode(
  exchange: CodeExchange
): Promise<ExchangeResult> {
  let response: Response
  try {
    response = await exchange.fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: exchange.code,
        code_verifier: exchange.verifier,
        client_id: exchange.clientId,
        client_secret: exchange.clientSecret,
        redirect_uri: exchange.redirectUri,
      }),
      redirect: "manual",
    })
  } catch {
    return { ok: false, reason: "token_endpoint_unreachable" }
  }
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = isRecord(value) ? value["error"] : undefined
    return {
      ok: false,
      reason: "token_endpoint_refused",
      ...(typeof error === "string" && ERROR_CODE.test(error) ? { error } : {}),
    }
  }
  const refreshToken = isRecord(value) ? value["refresh_token"] : undefined
  if (typeof refreshToken !== "string" || refreshToken === "")
    return { ok: false, reason: "no_refresh_token" }
  // Google's granular consent lets the owner untick a scope; a token without it would fail later.
  const scope = isRecord(value) ? value["scope"] : undefined
  if (typeof scope !== "string" || !scope.split(" ").includes(exchange.scope))
    return { ok: false, reason: "scope_not_granted" }
  return { ok: true, refreshToken }
}
