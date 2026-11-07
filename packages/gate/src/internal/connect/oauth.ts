import { createHash, randomBytes } from "node:crypto"

// Google OAuth for the gate's own sign-in (#98, #662): an authorization request with PKCE S256
// (RFC 7636) and a `state` value, redirected to the gate's callback on the web app's origin, and
// the code exchange at Google's token endpoint. Nothing here prints, logs or stores a token: the
// caller gets the refresh token back and writes it to the vault.

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
