"use client"

import * as React from "react"

/** Registers /sw.js with scope "/". Production only: in dev it would cache unhashed assets. */
function ServiceWorkerRegister() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return
    if (!("serviceWorker" in navigator)) return
    void navigator.serviceWorker.register("/sw.js", { scope: "/" })
  }, [])

  return null
}

export { ServiceWorkerRegister }
