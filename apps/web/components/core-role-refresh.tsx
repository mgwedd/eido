"use client"

import { useEffect } from "react"

import { withCoreRoleRefresh } from "@/lib/auth/core-fetch"

/**
 * With Auth0 on, core wants the role assertion cookie on every state-changing request (ADR
 * 0010). This wraps `fetch` once so any call to /api/core that core refuses as unauthenticated
 * refreshes the cookie and retries once, whichever page made it. Renders nothing.
 */
export function CoreRoleRefresh(): null {
  useEffect(() => {
    if (process.env["NEXT_PUBLIC_AUTH0_ENABLED"] !== "true") return
    const original = window.fetch.bind(window)
    window.fetch = withCoreRoleRefresh(original)
    return () => {
      window.fetch = original
    }
  }, [])
  return null
}
