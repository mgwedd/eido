"use client"

import * as React from "react"

type Reachability = "reachable" | "unreachable"

const ReachabilityContext = React.createContext<Reachability>("reachable")

const PROBE_URL = "/healthz"
const RETRY_MS = 15_000

/**
 * Tracks whether this device can reach Eido: the browser reports offline, or the
 * same-origin health probe fails (for example Tailscale is disconnected).
 */
function ReachabilityProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<Reachability>("reachable")

  const probe = React.useCallback(() => {
    fetch(PROBE_URL, { cache: "no-store" }).then(
      (response) => setState(response.ok ? "reachable" : "unreachable"),
      () => setState("unreachable")
    )
  }, [])

  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") probe()
    }
    probe()
    window.addEventListener("online", probe)
    window.addEventListener("offline", probe)
    window.addEventListener("focus", probe)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", probe)
      window.removeEventListener("offline", probe)
      window.removeEventListener("focus", probe)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [probe])

  React.useEffect(() => {
    if (state !== "unreachable") return
    const timer = window.setInterval(probe, RETRY_MS)
    return () => window.clearInterval(timer)
  }, [state, probe])

  return (
    <ReachabilityContext.Provider value={state}>
      {children}
    </ReachabilityContext.Provider>
  )
}

/** Pages use this to disable Approve and signing while Eido cannot be reached. */
function useReachability(): Reachability {
  return React.useContext(ReachabilityContext)
}

export { ReachabilityProvider, useReachability }
