import type { DatabaseSync } from "node:sqlite"
import { validateGateAuditPage, validateGateLoginOptions } from "@eido/schemas"
import type { ExecutionResult } from "./executor"
import type { Handler, Reply } from "./http"
import { phoneHandler } from "./phone-routes"
import { assertion, testAuthenticator, WEBAUTHN } from "./test-fixtures"
import type { Setup } from "./test-fixtures"

// The shared harness for the phone Undo route tests: a real phone handler over a control DB, an
// owner session signed in through the real passkey login, and the Activity projection. The
// executor and its upstream double are the caller's.

export const HOST = "eido.example.invalid"
export const NOW = new Date("2030-01-01T12:00:00Z")

/** A phone handler whose Undo runs `undo`; everything else is the real route table. */
export function undoHandler(
  fixture: Pick<Setup, "db" | "policy">,
  undo: (id: string) => Promise<ExecutionResult>
): Handler {
  return phoneHandler({
    gate: () => ({
      db: fixture.db,
      policy: fixture.policy,
      webAuthn: WEBAUTHN,
    }),
    allowedHosts: [HOST],
    basePath: "/api/gate",
    now: () => NOW,
    undo,
  })
}

export function call(
  handler: Handler,
  path: string,
  cookie?: string,
  method = "POST"
): Promise<Reply> {
  return Promise.resolve(
    handler({
      method,
      path: `/api/gate${path}`,
      query: new URLSearchParams(),
      headers: {
        host: HOST,
        contentType: "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: () => Promise.resolve({ ok: true, text: "{}" }),
    })
  )
}

/** Registers a passkey, signs in with it and returns the session cookie. */
export async function signIn(
  f: { db: DatabaseSync },
  handler: Handler
): Promise<string> {
  const auth = testAuthenticator()
  f.db
    .prepare(
      "INSERT INTO credentials (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)"
    )
    .run(auth.credentialId, auth.publicKey, NOW.toISOString())
  const options = validateGateLoginOptions(
    (await call(handler, "/auth/login/options")).body
  )
  if (!options.ok) throw new Error("invalid login options")
  const response = await handler({
    method: "POST",
    path: "/api/gate/auth/login",
    query: new URLSearchParams(),
    headers: { host: HOST, contentType: "application/json" },
    body: () =>
      Promise.resolve({
        ok: true,
        text: JSON.stringify({
          assertion: assertion(auth, options.value.challenge),
        }),
      }),
  })
  const rawCookie = response.headers?.["set-cookie"]
  const first = typeof rawCookie === "string" ? rawCookie : rawCookie?.[0]
  const cookie = first?.split(";")[0]
  if (!cookie) throw new Error("login failed")
  return cookie
}

/** The Activity entry for the execution of intent `id`, as the audit page reports it. */
export async function projection(handler: Handler, cookie: string, id: string) {
  const page = validateGateAuditPage(
    (await call(handler, "/audit", cookie, "GET")).body
  )
  if (!page.ok) throw new Error("invalid audit page")
  return page.value.entries.find(
    (entry) => entry.action === "execute" && entry.target === id
  )
}
