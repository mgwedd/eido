// Sign out for apps/web (issue 679).
// Calls the gate's logout route to invalidate the session in SQLite, clear elevations,
// and clear both eido_gate_session and eido_web_session cookies.
// Then navigates to /unlock (or /auth/logout if Auth0 is enabled).

import { clearUserCaches } from "@/lib/clear-user-caches"

export async function performSignOut(): Promise<void> {
  try {
    await fetch("/api/gate/auth/logout", {
      method: "POST",
      cache: "no-store",
    })
  } catch {
    // Continue even if gate call fails (e.g. network partition)
  }

  clearUserCaches()

  const isAuth0 =
    typeof process !== "undefined" &&
    process.env["NEXT_PUBLIC_AUTH0_ENABLED"] === "true"

  if (isAuth0) {
    // Full browser navigation is required to clear session cookies and Auth0 state.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/auth/logout"
  } else {
    // Full browser navigation is required to clear session cookies and client state.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/unlock"
  }
}
