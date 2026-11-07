import { describe, expect, it, vi } from "vitest"
import {
  authorizationUrl,
  exchangeCode,
  GMAIL_MODIFY_SCOPE,
  oauthState,
  pkcePair,
} from "./oauth"
import type { CodeExchange } from "./oauth"

describe("pkcePair", () => {
  it("makes a 43-character base64url verifier and a different S256 challenge each time", () => {
    const first = pkcePair()
    const second = pkcePair()
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.challenge).not.toBe(first.verifier)
    expect(second.verifier).not.toBe(first.verifier)
  })
})

describe("oauthState", () => {
  it("is fresh for every request", () => {
    expect(oauthState()).not.toBe(oauthState())
  })
})

describe("authorizationUrl", () => {
  it("asks Google for an offline code with PKCE S256, the state and consent", () => {
    const url = new URL(
      authorizationUrl({
        clientId: "client.example.invalid",
        redirectUri: "http://127.0.0.1:5000/oauth2callback",
        scope: GMAIL_MODIFY_SCOPE,
        state: "state-1",
        challenge: "challenge-1",
      })
    )
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client.example.invalid",
      redirect_uri: "http://127.0.0.1:5000/oauth2callback",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.modify",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    })
  })
})

describe("exchangeCode", () => {
  const exchange = (send: typeof fetch): CodeExchange => ({
    fetch: send,
    clientId: "client.example.invalid",
    clientSecret: "test-client-secret",
    code: "code-1",
    verifier: "verifier-1",
    redirectUri: "http://127.0.0.1:5000/oauth2callback",
    scope: GMAIL_MODIFY_SCOPE,
  })
  const answer = (status: number, body: unknown) =>
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
        })
      )
    )

  it("posts the code with its PKCE verifier and returns only the refresh token", async () => {
    const send = answer(200, {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      scope: `openid ${GMAIL_MODIFY_SCOPE}`,
    })
    expect(await exchangeCode(exchange(send))).toEqual({
      ok: true,
      refreshToken: "test-refresh-token",
    })
    expect(send).toHaveBeenCalledTimes(1)
    const [url, init] = send.mock.calls[0] ?? []
    expect(url).toBe("https://oauth2.googleapis.com/token")
    expect(init?.method).toBe("POST")
    const body = init?.body
    if (!(body instanceof URLSearchParams))
      throw new Error("the exchange body is not form-encoded")
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "verifier-1",
      client_id: "client.example.invalid",
      client_secret: "test-client-secret",
      redirect_uri: "http://127.0.0.1:5000/oauth2callback",
    })
  })

  it("reports a refusal with its OAuth error code and nothing else from the body", async () => {
    expect(
      await exchangeCode(
        exchange(
          answer(400, {
            error: "invalid_grant",
            error_description: "Bad Request",
          })
        )
      )
    ).toEqual({
      ok: false,
      reason: "token_endpoint_refused",
      error: "invalid_grant",
    })
  })

  it("drops a refusal's error when it is not a plain code", async () => {
    expect(
      await exchangeCode(exchange(answer(500, "<html>oops</html>")))
    ).toEqual({ ok: false, reason: "token_endpoint_refused" })
    expect(
      await exchangeCode(exchange(answer(400, { error: "Some Words" })))
    ).toEqual({ ok: false, reason: "token_endpoint_refused" })
  })

  it("reports an unreachable token endpoint", async () => {
    const send = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError("fetch failed"))
    )
    expect(await exchangeCode(exchange(send))).toEqual({
      ok: false,
      reason: "token_endpoint_unreachable",
    })
  })

  it("refuses an answer without a refresh token", async () => {
    expect(
      await exchangeCode(
        exchange(
          answer(200, {
            access_token: "test-access-token",
            scope: GMAIL_MODIFY_SCOPE,
          })
        )
      )
    ).toEqual({ ok: false, reason: "no_refresh_token" })
  })

  it("refuses a token granted without the Gmail scope", async () => {
    expect(
      await exchangeCode(
        exchange(
          answer(200, {
            refresh_token: "test-refresh-token",
            scope: "openid https://www.googleapis.com/auth/gmail.readonly",
          })
        )
      )
    ).toEqual({ ok: false, reason: "scope_not_granted" })
    expect(
      await exchangeCode(
        exchange(answer(200, { refresh_token: "test-refresh-token" }))
      )
    ).toEqual({ ok: false, reason: "scope_not_granted" })
  })
})
