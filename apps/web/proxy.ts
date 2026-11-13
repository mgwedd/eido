import { NextResponse, type NextRequest } from "next/server"

import { FORBIDDEN_PATH, guard } from "@/lib/auth/access"
import {
  clearedCoreRoleCookie,
  coreRoleCookie,
  coreRoleKeyFromEnv,
  CORE_ROLE_REFRESH_PATH,
  issueCoreRole,
} from "@/lib/auth/core-role"
import { AllowListError, roleFor, type Role } from "@/lib/auth/roles"
import { auth0, isAuth0Enabled } from "@/lib/auth0"
import {
  loadWebSessionPublicKey,
  verifyWebSessionToken,
  WEB_SESSION_COOKIE,
} from "@/lib/auth/web-session"

/** Copies the session cookies the SDK set (rolling session, cleared session) onto `to`. */
function withCookies(to: NextResponse, from: NextResponse): NextResponse {
  for (const cookie of from.headers.getSetCookie())
    to.headers.append("set-cookie", cookie)
  return to
}

/**
 * The role assertion core checks (ADR 0010, #720) on `response`: a fresh one for a signed-in
 * user with a role, a clearing one otherwise (signed out, no role). Does nothing when
 * EIDO_WEB_ROLE_PRIVATE_KEY is unset, as core then does not enforce roles either. The cookie
 * is scoped to /api/core, so the browser never sends it back to this proxy: it is reissued on
 * each page request and on POST /auth/core-role, and lasts minutes.
 */
function withCoreRole<T extends NextResponse>(
  response: T,
  user: { sub?: unknown } | null,
  role: Role | null
): T {
  const key = coreRoleKeyFromEnv()
  if (!key) return response
  const sub = typeof user?.sub === "string" ? user.sub : null
  response.headers.append(
    "set-cookie",
    role && sub
      ? coreRoleCookie(issueCoreRole({ sub, role }, key))
      : clearedCoreRoleCookie()
  )
  return response
}

/**
 * Every page needs a valid session.
 *
 * In passkey-only mode (AUTH0_DOMAIN unset, #679):
 * /unlock, /enroll, and /healthz are reachable without a session so the owner can enrol the
 * first passkey (#648) and unlock. All other routes verify the gate-signed eido_web_session
 * cookie (#678). Requests without a valid cookie redirect to /unlock?next=<pathname><search>;
 * requests with a valid cookie pass its role ("owner") to guard() (apps/web/lib/auth/access.ts).
 *
 * When Auth0 is enabled (AUTH0_DOMAIN set, #370 / #382):
 * The SDK serves /auth/* (login, callback, logout, profile). Signed-out requests go to
 * Universal Login and come back to the page they asked for; signed-in users without access get
 * the 403 page.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl

  if (!isAuth0Enabled()) {
    if (pathname === "/auth/logout") {
      const unlock = new URL("/unlock", request.url)
      const res = NextResponse.redirect(unlock)
      res.cookies.delete(WEB_SESSION_COOKIE)
      return res
    }

    if (
      pathname === "/unlock" ||
      pathname === "/enroll" ||
      pathname === "/recover" ||
      pathname === "/healthz"
    ) {
      return NextResponse.next()
    }

    const token = request.cookies.get(WEB_SESSION_COOKIE)?.value
    if (!token) {
      const unlock = new URL("/unlock", request.url)
      unlock.searchParams.set("next", `${pathname}${search}`)
      return NextResponse.redirect(unlock)
    }

    const key = await loadWebSessionPublicKey()
    const verified = verifyWebSessionToken(token, key)
    if (!verified.ok) {
      const unlock = new URL("/unlock", request.url)
      unlock.searchParams.set("next", `${pathname}${search}`)
      return NextResponse.redirect(unlock)
    }

    const decision = guard({
      signedIn: true,
      role: verified.payload.role,
      pathname,
      search,
    })
    if (decision.kind === "allow") return NextResponse.next()
    return NextResponse.rewrite(new URL(FORBIDDEN_PATH, request.url))
  }

  const client = auth0
  if (!client) return NextResponse.next()

  const authResponse = await client.middleware(request)
  const isAuthPath = pathname === "/auth" || pathname.startsWith("/auth/")
  if (isAuthPath && pathname !== CORE_ROLE_REFRESH_PATH) {
    // Sign-out ends the role assertion with the session.
    return pathname === "/auth/logout"
      ? withCoreRole(authResponse, null, null)
      : authResponse
  }

  const session = await client.getSession(request)
  let role: Role | null
  try {
    role = session ? roleFor(session.user) : null
  } catch (error) {
    if (!(error instanceof AllowListError)) throw error
    // Fail closed. instrumentation.ts already refuses to start with a bad allow-list.
    return new NextResponse("Eido's sign-in allow-list is misconfigured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    })
  }

  if (pathname === CORE_ROLE_REFRESH_PATH) {
    // The client's answer to a core 401 `unauthenticated`: a fresh assertion, or nothing.
    if (request.method !== "POST" || role === null || !coreRoleKeyFromEnv()) {
      return withCookies(
        new NextResponse(null, {
          status: request.method === "POST" ? 401 : 405,
          headers: { "Cache-Control": "no-store" },
        }),
        authResponse
      )
    }
    return withCookies(
      withCoreRole(
        new NextResponse(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        }),
        session?.user ?? null,
        role
      ),
      authResponse
    )
  }

  const decision = guard({ signedIn: session !== null, role, pathname, search })
  if (decision.kind === "allow")
    return withCoreRole(authResponse, session?.user ?? null, role)
  if (decision.kind === "login") {
    const login = new URL("/auth/login", request.url)
    login.searchParams.set("returnTo", decision.returnTo)
    return withCoreRole(
      withCookies(NextResponse.redirect(login), authResponse),
      null,
      null
    )
  }
  // The /forbidden page answers 403 itself (forbidden()); a rewrite's own status is dropped.
  return withCoreRole(
    withCookies(
      NextResponse.rewrite(new URL(FORBIDDEN_PATH, request.url)),
      authResponse
    ),
    null,
    null
  )
}

export const config = {
  // Static assets, the PWA manifest and icons, the service worker and the stack's health
  // probe stay public; everything else, including /auth/*, runs through the proxy.
  matcher: [
    "/((?!_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|manifest\\.webmanifest$|icon/|apple-icon(?:/|$)|sw\\.js$|sw-routing\\.js$|healthz(?:/|$)).*)",
  ],
}
