import { NextResponse, type NextRequest } from "next/server"

import { FORBIDDEN_PATH, guard } from "@/lib/auth/access"
import { AllowListError, roleFor } from "@/lib/auth/roles"
import { auth0 } from "@/lib/auth0"

/** Copies the session cookies the SDK set (rolling session, cleared session) onto `to`. */
function withCookies(to: NextResponse, from: NextResponse): NextResponse {
  for (const cookie of from.headers.getSetCookie())
    to.headers.append("set-cookie", cookie)
  return to
}

/**
 * Every page needs an Auth0 session whose verified email is on the allow-list. The SDK
 * serves /auth/* (login, callback, logout, profile). Signed-out requests go to Universal
 * Login and come back to the page they asked for; signed-in users without access get the
 * 403 page. Requests under /api/gate and /api/core on the Tailscale origin go straight to
 * the gate and core, not through Next, so this proxy does not guard them.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const authResponse = await auth0.middleware(request)
  const { pathname, search } = request.nextUrl
  if (pathname === "/auth" || pathname.startsWith("/auth/")) return authResponse

  const session = await auth0.getSession(request)
  let role
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

  const decision = guard({ signedIn: session !== null, role, pathname, search })
  if (decision.kind === "allow") return authResponse
  if (decision.kind === "login") {
    const login = new URL("/auth/login", request.url)
    login.searchParams.set("returnTo", decision.returnTo)
    return withCookies(NextResponse.redirect(login), authResponse)
  }
  return withCookies(
    NextResponse.rewrite(new URL(FORBIDDEN_PATH, request.url), { status: 403 }),
    authResponse
  )
}

export const config = {
  // Static assets, the PWA manifest and icons, the service worker and the stack's health
  // probe stay public; everything else, including /auth/*, runs through the proxy.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|icon/|apple-icon|sw\\.js|sw-routing\\.js|healthz).*)",
  ],
}
